import { app, BrowserWindow, clipboard, crashReporter, dialog, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { autoUpdater, type ProgressInfo } from 'electron-updater'
import { createHash, randomUUID } from 'node:crypto'
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { homedir, hostname, tmpdir } from 'node:os'
import { basename, dirname, join, delimiter, isAbsolute } from 'node:path'
import { AUTO_BACKUP_MS, backupReasonFor, exportText, SETTINGS_BACKUP_GAP_MS, type BackupInfo, type BackupReason } from '../shared/backup'
import { IPC, isBackupMark, isHostAction, isRedactFix, isUpdateAction, type AppInfo, type RedactStatus } from '../shared/ipc'
import type { LogLevel } from '../shared/errlog'
import { blockedReason, UPDATE_CHECK_MS, UPDATE_FIRST_DELAY_MS, type UpdateView } from '../shared/update'
import { normalizeState } from '../shared/model'
import { Debouncer, readStateText } from '../shared/persist'
import { redact, type SecretOptions } from '../shared/redact'
import { isAccel, isAppCommand } from '../shared/keymap'
import { MAX_LINK, webUrl } from '../shared/links'
import { rendererFromEnv, type RendererMode } from '../shared/renderer'
import { isPaneId, validSize, validWrite } from '../shared/pty'
import { controlPathFits, isRemotePath, isSshHost, parseSshConfigHosts, sshArgs } from '../shared/remote'
import type { AppState, Settings } from '../shared/types'
import { installAppMenu, onCliInstall, onQuitAll } from './menu'
import { CliServer } from './cli-server'
import { installCli } from './cli-install'
import { cliSocketPath, parseUiReply, type PaneTarget, type UiReply, type UiRequest } from '../shared/cli'
import { PaneWatch } from '../shared/pane-watch'
import { lsofCwds, strictLsofCwds } from './cwd-probe'
import { killPort, probePorts } from './port-probe'
import type { ProbeResult } from '../shared/ports'
import { branchesOf } from './git-branch'
import { addWorktree } from './worktree'
import { installWorkflowIpc } from './workflow-ipc'
import { installScheduleIpc } from './schedule-ipc'
import { installWorktreeIpc } from './worktree-ipc'
import type { WorkspaceBrowser } from './workspace-browser'
import type { WorkflowRunner } from './workflow-runner'
import { installWorkspaceIpc } from './workspace-ipc'
import type { Accounts } from './accounts'
import type { WorktreeResult } from '../shared/worktree'
import { createHostControl, type HostControl } from './host-control'
import { BackupStore } from './backup-store'
import { ScrollbackStore } from './scrollback-store'
import { HistoryStore } from './history-store'
import { commitFiles, loadReview, makeRunGit, openTarget, restoreReverted, revertFile, revertLines, RevertStore, ReviewWatch, safeRel, undoCommit } from './review-git'
import type { CommitResult, RestoreResult, ReviewLoad, RevertResult, RevertedView, UndoResult } from '../shared/review'
import { spawn as spawnChild } from 'node:child_process'
import { ChatManager } from './chat/chat-manager'
import { ChatStore } from './chat/chat-store'
import { AgentBinFinder } from './chat/find-bin'
import type { SpawnFn } from './chat/claude-adapter'
import { IMAGE_MAX_BYTES, IMAGE_MAX_COUNT, isChatAgent, isChatDecision, isChatImages, type ChatImage, type ChatPermission } from '../shared/chat'
import type { ChatRef } from './chat/chat-manager'
import { isObj } from '../shared/guards'
import { StateFile } from './state-file'
import { ErrorLog } from './errlog'
import { Updater, type UpdateEngine, type UpdatePrefs } from './updater'
import { defaultShell } from '../shared/platform'
import { openTextEditor } from './text-editor'

// e2e 는 임시 폴더를 넘긴다 — 실제 ~/Library/Application Support/Taskminal 을 건드리지 않게. ready 전에 정해야 한다.
const userDataOverride = process.env['TASKMINAL_USER_DATA']
if (userDataOverride) app.setPath('userData', userDataOverride)
// 충돌 보고(18단계) — <userData>/Crashpad 에만 남기고 밖으로 보내지 않는다. ready 전에.
// 임시 userData(e2e)에서는 켜지 않는다: crashpad_handler 가 stdio 파이프를 물고 남아 Playwright 가 앱 종료를 못 본다.
// '갑자기 꺼짐' 안내는 덤프가 아니라 running 표시 파일로 판단하므로 e2e 에서도 그대로 시험된다.
if (!userDataOverride) crashReporter.start({ uploadToServer: false })

const devServerUrl = process.env['ELECTRON_RENDERER_URL']
const rendererFile = join(__dirname, '../renderer/index.html')

let mainWindow: BrowserWindow | null = null
// 셸 통합 시작 파일 — zsh 가 직접 읽으므로 asar 안이면 안 된다(Electron fs 는 asar 안도 '있다'고 한다).
// 패키징하면 extraResources 로 Resources/shell/zsh 에 둔다(14단계 설정), 개발 · e2e 는 저장소의 resources/shell/zsh.
const zshIntegrationDir = ((): string | null => {
  const dir = app.isPackaged ? join(process.resourcesPath, 'shell', 'zsh') : join(app.getAppPath(), 'resources', 'shell', 'zsh')
  return !dir.includes('.asar') && existsSync(join(dir, '.zshrc')) ? dir : null
})()
// 설정에서 고를 수 있는 셸 — 시스템이 로그인 셸로 인정한 것만
const allowedShells = ((): string[] => {
  if (process.platform === 'win32') return [defaultShell('win32', process.env)].filter(existsSync)
  try {
    return readFileSync('/etc/shells', 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('/'))
  } catch {
    return []
  }
})()
// 셸 지킴이(16단계) — userData 가 정해진 뒤(ready) 만든다. 셸 프로세스는 지킴이가 갖는다.
let hostControl: HostControl | null = null

// ─── 24단계: taskminal 명령 ───
// sh 도구 폴더 — 셸 · 대화 에이전트의 PATH 끝에 덧붙인다. 패키징하면 Resources/bin (extraResources), 개발 · e2e 는 저장소 resources/bin
const cliBinDir = app.isPackaged ? join(process.resourcesPath, 'bin') : join(app.getAppPath(), 'resources', 'bin')
const cliJs = join(__dirname, 'cli.js')
let cliSockPath = '' // ready 뒤 정한다(userData)
let cliServer: CliServer | null = null
// main 이 받은 마지막 상태 — 새 셸의 TASKMINAL_TASK_ID 를 찾는다. 상태를 받을 때마다 바꾼다(처음 한 번만 읽지 않는다)
let lastState: AppState | null = null
let agentAccounts: Accounts | null = null
let workspaceBrowser:WorkspaceBrowser|null=null
let workflowRunner: WorkflowRunner | null = null
const paneWatch = new PaneWatch({ now: Date.now, later: (fn, ms) => ((t) => () => clearTimeout(t))(setTimeout(fn, ms)) })
/** pane 의 셸 · 대화 에이전트에 넣는 값 — 그 안의 taskminal 이 '이 터미널' 을 안다 */
function cliEnv(paneId: string): Record<string, string> {
  const taskId = lastState?.tasks.find((t) => Object.hasOwn(t.panes, paneId))?.id
  return {
    TASKMINAL_PANE_ID: paneId,
    ...(taskId ? { TASKMINAL_TASK_ID: taskId } : {}),
    ...(cliSockPath ? { TASKMINAL_SOCKET: cliSockPath } : {}),
    TASKMINAL_CLI_NODE: process.execPath,
    TASKMINAL_CLI_JS: cliJs,
    PATH: cliBinDir,
  }
}
// 창에 묻는 요청 — 번호마다 답을 기다린다(5초). 시간이 지난 번호의 답은 버린다
let cliSeq = 0
const cliPending = new Map<number, (r: UiReply) => void>()
const CLI_UI_MS = 5000
function askUi(req: UiRequest): Promise<UiReply> {
  const win = mainWindow
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return Promise.resolve({ ok: false, error: '앱 창이 없어요 — Dock 의 Taskminal 을 눌러 창을 연 뒤 다시 해 주세요' })
  return new Promise((resolve) => {
    const id = ++cliSeq
    const timer = setTimeout(() => {
      cliPending.delete(id)
      resolve({ ok: false, error: '앱 화면이 답하지 않아요 — 잠시 뒤 다시 해 주세요' })
    }, CLI_UI_MS)
    cliPending.set(id, (r) => {
      clearTimeout(timer)
      cliPending.delete(id)
      resolve(r)
    })
    win.webContents.send(IPC.cliRequest, id, req)
  })
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
function startCliServer(): void {
  cliServer = new CliServer({
    sockPath: cliSockPath,
    askUi,
    pane: {
      async ready(paneId, ms) {
        const end = Date.now() + ms
        for (;;) {
          const s = (await control().ptys.sessions().catch(() => [])).find((x) => x.paneId === paneId)
          if (s && !s.exited) return true
          if (Date.now() >= end) return false
          await sleep(150)
        }
      },
      write: (paneId, data) => control().ptys.writeAny(paneId, data),
      tail: (paneId, lines) => control().tail(paneId, lines),
      async info(paneId) {
        const s = (await control().ptys.sessions().catch(() => [])).find((x) => x.paneId === paneId)
        return s ? { running: s.running, lastOutputAt: s.lastOutputAt, ...(s.exited ? { exited: s.exited.exitCode } : {}) } : null
      },
    },
    watch: paneWatch,
    chat: {
      async send(t: PaneTarget, text: string) {
        const sink = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null
        if (!sink) return 'no-window'
        const ref = t.chat ? { agent: t.chat.agent, ...(t.chat.sessionId ? { sessionId: t.chat.sessionId } : {}), ...(t.chat.sessionId && t.chat.forkAt ? { forkAt: t.chat.forkAt } : {}) } : { agent: 'claude' as const }
        return chats().send(sink, t.paneId, text, t.cwd, ref)
      },
      history: async (paneId) => (await chats().history(paneId)).events,
      subscribe: (fn) => chats().onEvent(fn),
    },
    redact: (text) => redact(text, secretOpts),
  })
  cliServer.listen().catch((e: unknown) => report('error', 'cli-socket', '명령줄 도구 소켓을 열지 못했어요', e))
}
/** 앱 메뉴 '명령줄 도구 설치…' — 사용자가 누를 때만. 시험은 TASKMINAL_CLI_INSTALL_DIR */
async function installCliMenu(): Promise<void> {
  if (process.platform === 'win32') {
    await dialog.showMessageBox({ type: 'info', message: '앱 안 터미널에서는 taskminal 명령을 바로 쓸 수 있어요', detail: `외부 터미널에서도 쓰려면 Windows 환경 변수 PATH에 다음 폴더를 추가하세요.\n${cliBinDir}\n기존 PATH는 바꾸지 않았어요.` })
    return
  }
  const dir = process.env['TASKMINAL_CLI_INSTALL_DIR'] || (process.platform === 'darwin' ? '/usr/local/bin' : join(homedir(), '.local', 'bin'))
  if (process.platform === 'linux') mkdirSync(dir, { recursive: true })
  const r = installCli(join(cliBinDir, 'taskminal'), dir)
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
  const box = (o: Electron.MessageBoxOptions) => (win ? dialog.showMessageBox(win, o) : dialog.showMessageBox(o))
  if (r.kind === 'installed' || r.kind === 'already') {
    await box({ type: 'info', message: r.kind === 'installed' ? '명령줄 도구를 설치했어요' : '명령줄 도구가 이미 설치돼 있어요', detail: `${r.path}\n아무 터미널에서나 'taskminal help' 를 쳐 보세요. 앱 안 터미널은 설치하지 않아도 돼요.` })
  } else if (r.kind === 'conflict') {
    await box({ type: 'warning', message: '같은 이름의 다른 파일이 있어요', detail: `${r.path} 를 덮지 않았어요. 지운 뒤 다시 해 주세요.` })
  } else {
    const c = await box({ type: 'info', message: '그 폴더에 쓸 권한이 없어요', detail: `터미널에서 이 명령을 쳐 주세요 (관리자 암호를 물어요):\n\n${r.command}`, buttons: ['명령 복사', '닫기'], defaultId: 0, cancelId: 1 })
    if (c.response === 0) clipboard.writeText(r.command)
  }
}
const control = (): HostControl => {
  if (!hostControl) throw new Error('셸 지킴이가 아직 준비되지 않음')
  return hostControl
}

// renderer 가 알려 주는 값: 실행 중 명령 수(끄기 전 확인이 꺼져 있으면 0) — renderer 가 사라지면 0
let busyCommands = 0
let quitting = false // 끝내기를 정했다 — before-quit 이 다시 묻지 않게
let asking = false // 안내 · 확인 창이 떠 있다 — 두 번째 창을 띄우지 않는다
const setBadge = (n: number) => app.dock?.setBadge(n > 0 ? String(n) : '')

// ─── 18단계: 오류 기록 · 지난번 꺼짐 · 첫 실행 · 업데이트 ───
let errorLog: ErrorLog | null = null
const errlog = () => (errorLog ??= new ErrorLog(app.getPath('logs'), () => secretOpts))
/** console 과 오류 기록 둘 다 — 오류 기록은 이 Mac 에만(~/Library/Logs/Taskminal) */
function report(level: LogLevel, key: string, msg: string, detail?: unknown): void {
  console.error(msg, detail ?? '')
  if (app.isReady()) errlog().write(level, key, msg, detail)
}
// 앱이 도는 동안 있는 표시 파일 — 시작 때 남아 있으면 지난번이 정상으로 끝나지 않은 것
const runningFile = () => join(app.getPath('userData'), 'running')
const firstRunFile = () => join(app.getPath('userData'), 'first-run-seen')
let crashedLast = false
// 업데이트 설정 — main 이 상태를 받을 때마다 바꾼다(처음 한 번만 읽지 않는다)
let updatePrefs: UpdatePrefs = { download: true, skip: '' }
const prefsFrom = (s: Settings): UpdatePrefs => ({ download: s.updateDownload, skip: s.updateSkip })
let updater: Updater | null = null
const sendUpdate = (v: UpdateView) => {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(IPC.updateView, v)
}

const MAX_STATE_BYTES = 5 * 1024 * 1024
// 비밀값 가리기 옵션(17단계) — main 이 마지막으로 받은 상태의 설정에서. 상태를 받을 때마다 바꾼다(처음 한 번만 읽지 않는다)
let secretOpts: SecretOptions = {}
const optsFrom = (s: Settings): SecretOptions => ({ allow: new Set(s.secretAllow.map((a) => a.hash)), custom: s.secretCustom })
// 스크롤 저장 — userData 가 정해진 뒤(ready 이후 첫 요청) 만든다. 디스크로 가기 전 가린다
let scrollbackStore: ScrollbackStore | null = null
const scrollback = () => (scrollbackStore ??= new ScrollbackStore(join(app.getPath('userData'), 'scrollback'), () => secretOpts))
// 스크롤 쓰기 · 이미 남은 파일 정리를 한 줄로 — 주기 저장(비동기)이 도는 중에 다음 일이 와도 차례로
let saving: Promise<unknown> = Promise.resolve()
const redactMarker = () => join(app.getPath('userData'), 'scrollback-redacted-v1')
let redactStarted = false
const sendRedact = (s: RedactStatus) => {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(IPC.redactStatus, s)
}
// 명령 기록(19단계) — userData 가 정해진 뒤 만든다. 디스크로 가기 전 가린다
let historyStore: HistoryStore | null = null
const history = () => (historyStore ??= new HistoryStore(join(app.getPath('userData'), 'history'), () => secretOpts))
// 대화 pane (21단계) — 허락 방식은 상태 저장 때마다 갱신(떠 있는 claude 에도 바로)
let chatPermission: ChatPermission = 'ask'
let chatManager: ChatManager | null = null
const chatSpawn: SpawnFn = (bin, args, o) => spawnChild(bin, args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'] })
const agentBins = new AgentBinFinder()
const chats = () =>
  (chatManager ??= new ChatManager({
    // 대화 에이전트(claude -p · codex)도 taskminal 을 쓴다 — PATH 는 에이전트를 찾은 PATH 끝에 덧붙인다
    extraEnv: (paneId, path) => ({ ...cliEnv(paneId), PATH: `${path || process.env['PATH'] || process.env['Path'] || ''}${delimiter}${cliBinDir}` }),
    sessionEnv: (env,paneId,chat) => agentAccounts?.sessionEnvironment(paneId,chat.agent,!!chat.sessionId,env) ?? env,
    store: new ChatStore(join(app.getPath('userData'), 'chat'), () => secretOpts),
    redactOptions: () => secretOpts,
    spawn: chatSpawn,
    findBin: (agent) => agentBins.find(agent),
    reserved:paneId=>!!lastState?.tasks.some(t=>t.panes[paneId]?.workflowRunId),
    permissionFor:paneId=>lastState?.tasks.some(t=>t.panes[paneId]?.workflowRunId)?'ask':undefined,
    permission: () => chatPermission,
    channel: IPC.chatEvent,
    appVersion: app.getVersion(),
  }))
const setChatPermission = (p: ChatPermission) => {
  if (p === chatPermission) return
  chatPermission = p
  chatManager?.setPermission(p)
}
// 변경 검토(23단계) — 되돌린 것 보관 · 폴더 감시. git 은 TASKMINAL_GIT_BIN(e2e '없음' 시험) 또는 PATH 의 git
let revertStore: RevertStore | null = null
const reverts = () => (revertStore ??= new RevertStore(join(app.getPath('userData'), 'reverted')))
const runGit = makeRunGit(process.env['TASKMINAL_GIT_BIN'] || 'git')
const reviewWatch = new ReviewWatch()

// 상태 백업(17단계) — userData 가 정해진 뒤 만든다
let backupStore: BackupStore | null = null
const backups = () => (backupStore ??= new BackupStore(app.getPath('userData')))
let worktreeRevision=0
const pendingWorktreeCwds=new Map<symbol,string>()
let lastWritten: AppState | null = null // 디스크에 있는 상태 — 다음 상태와 비교해 백업 이유를 정한다
let lastSettingsBackup = 0
let changedSinceAuto = false
let backupFailing = false
/** 백업 실패는 상태 저장을 막지 않는다 — 노란 줄로 알리고, 다음에 되면 줄을 지운다 */
function backupNow(reason: BackupReason, force = false): string | null | Error {
  const r = backups().snapshot(reason, Date.now(), force)
  if (r instanceof Error) {
    report('error', 'backup', '백업을 만들지 못했어요', r)
    backupFailing = true
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send(IPC.backupError, r.message)
  } else if (backupFailing) {
    backupFailing = false
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send(IPC.backupError, null)
  }
  return r
}
const MAX_LIVE_PANES = 2000
const MAX_BRANCH_DIRS = 200 // 사이드바 일감 폴더 (15c)
const cwdPollMs = ((): number => {
  const v = Number(process.env['TASKMINAL_CWD_POLL_MS'])
  return Number.isInteger(v) && v >= 100 ? v : 15_000
})()
// 20단계 포트 조사 주기 (창에 포커스가 있을 때, 없으면 5배) — 시험은 줄인다
const portPollMs = ((): number => {
  const v = Number(process.env['TASKMINAL_PORT_POLL_MS'])
  return Number.isInteger(v) && v >= 100 ? v : 3000
})()
// 25단계 원격 다시 붙기의 한 걸음 — 시험은 줄인다
const sshRetryMs = ((): number => {
  const v = Number(process.env['TASKMINAL_SSH_RETRY_MS'])
  return Number.isInteger(v) && v >= 10 ? v : 1000
})()
// ssh 실행 파일 — 시험은 TASKMINAL_SSH 로 가짜(절대 경로만)
const sshFile = (): string => {
  const v = process.env['TASKMINAL_SSH']
  return v && isAbsolute(v) ? v : process.platform === 'win32' ? join(process.env['SystemRoot'] || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe') : '/usr/bin/ssh'
}
// ControlMaster 소켓 폴더 — 나만 읽고 쓰는(0700 · 내 것 · 링크 아님) 폴더. macOS 소켓 경로 한도(104바이트)에 들어가야 한다:
// 보통 '~/Library/Application Support/Taskminal/ssh' 는 넘치므로(25단계 리뷰) /tmp/taskminal-<uid> 로. 둘 다 안 되면 연결을 나누지 않는다
const ownPrivateDir = (dir: string): boolean => {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const st = lstatSync(dir)
    return st.isDirectory() && !st.isSymbolicLink() && st.uid === process.getuid?.() && (st.mode & 0o077) === 0
  } catch {
    return false
  }
}
const sshControlDir = (): string | null => {
  if (process.platform === 'win32') return null // Windows OpenSSH는 ControlMaster 소켓을 지원하지 않는다
  for (const dir of [join(app.getPath('userData'), 'ssh'), `/tmp/taskminal-${process.getuid?.() ?? 'u'}`]) {
    if (controlPathFits(dir) && ownPrivateDir(dir)) return dir
  }
  return null
}
// 15e: 터미널 그리기 — 시험(e2e)은 DOM 의 글을 읽으므로 playwright 설정이 dom 을 넣는다
const renderer: RendererMode = rendererFromEnv(process.env['TASKMINAL_RENDERER'])
let stateFile: StateFile | null = null // userData 경로가 정해진 뒤(ready) 만든다
// 디바운스가 main 에 있어서 창 닫기 · 새로 고침 · 렌더러 충돌 뒤에도 이미 받은 값은 타이머가 쓴다.
const stateWriter = new Debouncer<AppState>(
  (state) => {
    // 쓰기 직전: 디스크의 지금 모습(바뀌기 전)을 백업할지 — 일감 · 탭이 사라짐 · 설정이 바뀜(10분에 한 번까지)
    if (stateFile?.canWrite) {
      const reason = backupReasonFor(lastWritten, state)
      if (reason === 'delete' || (reason === 'settings' && Date.now() - lastSettingsBackup >= SETTINGS_BACKUP_GAP_MS)) {
        if (reason === 'settings') lastSettingsBackup = Date.now()
        backupNow(reason)
      }
    }
    const error = stateFile?.trySave(state) ?? null
    if (!error) {
      if (stateFile?.canWrite) {
        lastWritten = state
        changedSinceAuto = true
      }
      return
    }
    // 디스크 가득 · 권한: main 을 죽이지 않고 알린다. 다음 변경이 전체 상태를 다시 보내므로 그때 다시 시도된다.
    report('error', 'state-save', '상태를 저장하지 못했어요', error)
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send(IPC.stateError, error.message)
  },
  (fn, ms) => {
    const t = setTimeout(fn, ms)
    return () => clearTimeout(t)
  },
  300,
)

const isOurPage = (url: string): boolean => {
  try {
    const u = new URL(url)
    if (devServerUrl) return u.origin === new URL(devServerUrl).origin
    return u.protocol === 'file:' && decodeURIComponent(u.pathname) === rendererFile
  } catch {
    return false
  }
}

const openExternalIfWeb = (url: unknown): void => {
  const web = webUrl(url) // http(s) 가 아니면 무시
  if (web) void shell.openExternal(web)
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 640,
    minHeight: 400,
    title: 'Taskminal',
    backgroundColor: '#0e0f11',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })

  win.once('ready-to-show', () => win.show())
  // 화면을 못 읽으면 ready-to-show 가 오지 않는다 — 숨은 창으로 남지 않게 보여 주고 기록한다.
  win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame) return
    report('error', 'load-fail', '화면을 읽지 못했어요', `${code} ${description}: ${url}`)
    win.show()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfWeb(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (!isOurPage(url)) {
      event.preventDefault()
      openExternalIfWeb(url)
    }
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
  // 대화의 claude 는 지킴이에 남기지 않는다 — 창이 닫히면 끝내고, 다음 보내기가 --resume 으로 잇는다(새로 고침 · 충돌은 같은 webContents 라 그대로)
  const chatSink = win.webContents
  win.on('closed', () => {workflowRunner?.dispose();chatManager?.closeSink(chatSink)})
  // 종료 경로 4개 중 창에 딸린 3개 — 셸은 지킴이에 남기고 떼기만 한다(16단계). 다시 열리면 attach 로 다시 붙는다.
  const wc = win.webContents
  // renderer 가 사라지면(창 닫기 · 새로 고침 · 충돌) 그 renderer 가 알려 준 수도 버린다 — 새 페이지가 다시 보낸다
  const forget = () => {
    busyCommands = 0
    setBadge(0)
  }
  const detach = () => {
    workflowRunner?.dispose()
    hostControl?.ptys.detachOwner(wc)
    reviewWatch.stopPrefix(`${wc.id}:`)
    forget()
  }
  wc.on('destroyed', detach) // ① 창 닫기
  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) detach() // ② 새로 고침 — 새 페이지가 다시 붙는다(수 · 배지도 다시 보낸다)
  })
  // ③ 렌더러 충돌 — 셸은 남아 있으니 창을 다시 읽어 다시 붙는다. 10초 안에 또 죽으면 다시 읽지 않는다(충돌 되풀이)
  let lastCrash = 0
  wc.on('render-process-gone', (_event, details) => {
    report('error', 'render-gone', '화면이 멈췄다 되살아났어요', `render-process-gone: ${details.reason} (${details.exitCode})`)
    detach()
    const now = Date.now()
    if (now - lastCrash > 10_000 && !win.isDestroyed()) wc.reload()
    lastCrash = now
  })

  const load = devServerUrl ? win.loadURL(devServerUrl) : win.loadFile(rendererFile)
  load.catch(() => {
    // did-fail-load 가 처리한다
  })
  return win
}

// 우리 창의 맨 위 프레임이 우리 페이지를 띄우고 있을 때만 받는다 (창이 여러 개여도 같은 규칙).
const fromOurWindow = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => {
  const frame = event.senderFrame
  return (
    frame !== null &&
    BrowserWindow.fromWebContents(event.sender) !== null &&
    frame === event.sender.mainFrame &&
    isOurPage(frame.url)
  )
}

/** .app 이 든 폴더에 쓸 수 있나 — 없으면 업데이트가 .app 을 바꾸지 못한다 */
function bundleWritable(): boolean {
  const bundle = process.execPath.split('/Contents/MacOS/')[0] ?? process.execPath
  try {
    accessSync(dirname(bundle), constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** electron-updater 를 엔진 모양으로. 받는 곳은 electron-builder 가 넣은 app-update.yml(GitHub Releases) —
 *  TASKMINAL_UPDATE_FEED 가 있으면 그 주소(generic, e2e · 로컬 확인용)를 개발 실행에서도 본다. */
function electronUpdaterEngine(feed: string | undefined): UpdateEngine {
  autoUpdater.logger = null
  autoUpdater.autoDownload = false // 건너뛴 버전 · 받기 설정은 Updater 가 정한다
  autoUpdater.autoInstallOnAppQuit = false // 설치는 사용자가 고를 때만 — 이것이 꺼져 있으면 받은 뒤 Squirrel 을 부르지 않는다
  autoUpdater.autoRunAppAfterInstall = true
  if (feed) {
    const config = join(app.getPath('userData'), 'dev-app-update.yml')
    writeFileSync(config, `provider: generic\nurl: ${JSON.stringify(feed)}\nupdaterCacheDirName: taskminal-updater\n`, { mode: 0o600 })
    autoUpdater.forceDevUpdateConfig = true
    autoUpdater.updateConfigPath = config
    autoUpdater.setFeedURL({ provider: 'generic', url: feed })
  }
  if (userDataOverride) {
    // 시험이 실제 ~/Library/Caches/taskminal-updater 를 쓰지 않게 (받은 파일 자리 — ElectronAppAdapter.baseCachePath)
    Object.defineProperty((autoUpdater as unknown as { app: object }).app, 'baseCachePath', { value: join(userDataOverride, 'caches') })
  }
  return {
    async checkForUpdate() {
      const r = await autoUpdater.checkForUpdates()
      return r?.isUpdateAvailable ? { version: r.updateInfo.version, notes: r.updateInfo.releaseNotes } : null
    },
    async downloadUpdate(onProgress) {
      const h = (p: ProgressInfo) => onProgress({ percent: p.percent, transferred: p.transferred, total: p.total })
      autoUpdater.on('download-progress', h)
      try {
        await autoUpdater.downloadUpdate()
      } finally {
        autoUpdater.removeListener('download-progress', h)
      }
    },
    install() {
      autoUpdater.quitAndInstall(false, true)
    },
    onError(fn) {
      autoUpdater.on('error', fn)
    },
  }
}

function createUpdater(): Updater {
  const feed = process.env['TASKMINAL_UPDATE_FEED']
  // 받는 곳(app-update.yml)은 배포 빌드(dmg · zip)에만 있다 — dir 패키징본 · 개발 실행은 확인하지 않는다
  const hasFeed = app.isPackaged && existsSync(join(process.resourcesPath, 'app-update.yml'))
  return new Updater(hasFeed || feed ? electronUpdaterEngine(feed) : null, {
    current: app.getVersion(),
    blocked: app.isPackaged ? blockedReason(process.execPath, bundleWritable()) : null,
    prefs: () => updatePrefs,
    now: Date.now,
    send: sendUpdate,
    log: report,
    // 설치를 위한 종료는 '처음 끌 때 안내' 를 건너뛴다 — 셸은 지킴이에 남는다(16단계)
    beforeInstall: () => {
      quitting = true
      stateWriter.flush()
    },
    installFailed: () => {
      quitting = false
    },
  })
}

/** 디스크 이미지에서 실행 중 — 응용 프로그램 폴더로 옮기고 다시 연다 */
function moveToApplications(): void {
  quitting = true // 옮기면 앱이 바로 다시 열린다 — 끄기 안내를 건너뛴다
  // 옮기기는 will-quit 없이 프로세스를 끝낼 수 있다 — 상태 쓰기 · 정상 종료 표시를 먼저 한다(다시 연 앱이 '갑자기 꺼짐' 으로 보지 않게)
  stateWriter.flush()
  markRunning(false)
  let moved = false
  try {
    moved = app.moveToApplicationsFolder()
  } catch (e) {
    report('error', 'move-app', '응용 프로그램 폴더로 옮기지 못했어요', e)
  }
  if (!moved) {
    quitting = false
    markRunning(true)
  }
}

/** 실행 중 표시 — 남아 있으면 다음 실행이 '지난번에 갑자기 꺼짐' 으로 본다 */
function markRunning(on: boolean): void {
  try {
    if (on) writeFileSync(runningFile(), String(process.pid), { mode: 0o600 })
    else unlinkSync(runningFile())
  } catch (e) {
    if (on) report('warn', 'running-mark', '실행 표시 파일을 쓰지 못했어요', e)
    // 지울 때 없으면 그만
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // macOS 는 창을 다 닫아도 앱이 남으므로, 다시 실행하면 창이 없을 수 있다 → 만든다.
  app.on('second-instance', () => {
    if (!app.isReady()) return
    if (!mainWindow) {
      mainWindow = createWindow()
      return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  ipcMain.handle(IPC.appInfo, (event): AppInfo => {
    if (!fromOurWindow(event)) throw new Error('알 수 없는 프레임의 요청')
    return { name: app.getName(), version: app.getVersion(), shells: allowedShells, host: hostname(), home: homedir(), cwdPollMs, portPollMs, renderer, crashedLast, sshRetryMs, claudeTui: process.env['TASKMINAL_CLAUDE_TUI'] || 'claude', codexTui: process.env['TASKMINAL_CODEX_TUI'] || 'codex' }
  })

  const workspaceTools = installWorkspaceIpc(fromOurWindow, () => lastState)
  agentAccounts=workspaceTools.accounts
  workspaceBrowser=workspaceTools.browser
  workflowRunner = installWorkflowIpc(fromOurWindow,{
    state:()=>lastState,accounts:agentAccounts,manager:chats(),ask:askUi,
    saved:()=>{stateWriter.flush();return stateFile?.canWrite?lastWritten:null},
    sink:()=>mainWindow&&!mainWindow.isDestroyed()?mainWindow.webContents:null,
    redact:text=>redact(text,secretOpts),
  })
  installScheduleIpc(fromOurWindow,{state:()=>lastState,workflow:workflowRunner,
    available:()=>!!stateFile?.canWrite&&!!lastState&&!!mainWindow&&!mainWindow.isDestroyed()&&!mainWindow.webContents.isCrashed()&&!mainWindow.webContents.isLoading(),
    redact:text=>redact(text,secretOpts),report:error=>report('error','schedules','예약 실행을 멈췄어요',error),
  })
  installWorktreeIpc(fromOurWindow,{state:()=>lastState,revision:()=>worktreeRevision,pendingPaths:()=>[...pendingWorktreeCwds.values()],
    liveCwds:async()=>{
      await control().ready
      if(control().view().state!=='connected')throw new Error('셸 지킴이 상태를 확인하지 못했어요')
      const sessions=(await control().sessions(false)).filter(s=>!s.exited)
      const paths=await strictLsofCwds(sessions.map(s=>s.pid))
      if(sessions.some(s=>!paths[s.pid]))throw new Error('실행 중인 셸의 폴더를 확인하지 못했어요')
      return Object.values(paths)
    },
  })


  ipcMain.handle(IPC.ptySpawn, async (event, paneId: unknown, opts: unknown) => {
    if (!fromOurWindow(event)) throw new Error('알 수 없는 프레임의 요청')
    const o = (opts ?? {}) as Record<string, unknown>
    if (!isPaneId(paneId) || typeof o['cwd'] !== 'string' || !validSize(o['cols'], o['rows'])) {
      throw new Error('잘못된 pty 인자')
    }
    // 25단계 원격: host 는 옵션 주입 · 셸 글자를 막고(isSshHost), cwd 는 원격 명령 안에서 따옴표로 감싼다(isRemotePath)
    const rem = o['remote'] as Record<string, unknown> | undefined
    if (rem !== undefined && (typeof rem !== 'object' || rem === null || typeof rem['host'] !== 'string' || !isSshHost(rem['host']) || !isRemotePath(o['cwd']))) {
      throw new Error('잘못된 원격 인자')
    }
    const pendingCwd=Symbol()
    pendingWorktreeCwds.set(pendingCwd,rem?homedir():o['cwd'])
    worktreeRevision++
    try {
      await control().ready
      const ssh = rem ? { file: sshFile(), args: sshArgs({ host: rem['host'] as string, cwd: o['cwd'], paneId, tmux: rem['tmux'] !== false, controlDir: sshControlDir() }) } : undefined
      await control().ptys.spawn(
        event.sender,
        paneId,
        {
          cwd: o['cwd'],
          cols: o['cols'] as number,
          rows: o['rows'] as number,
          shell: typeof o['shell'] === 'string' ? o['shell'] : null, // 경로 검사는 PtyManager(pickShell)
          integration: o['integration'] !== false,
        },
        ssh,
      )
    } catch (e) {
      report('error', 'pty-spawn', '셸을 띄우지 못했어요', e)
      throw e
    } finally {
      pendingWorktreeCwds.delete(pendingCwd);worktreeRevision++
    }
  })
  // 25단계: 새 일감 대화상자의 호스트 목록 — ~/.ssh/config 를 읽기만(없거나 못 읽으면 빈 목록, Include 는 따라가지 않는다)
  ipcMain.handle(IPC.sshHosts, async (event): Promise<string[]> => {
    if (!fromOurWindow(event)) throw new Error('알 수 없는 프레임의 요청')
    const file = process.env['TASKMINAL_SSH_CONFIG'] || join(homedir(), '.ssh', 'config')
    const text = await readFile(file, 'utf8').catch(() => '')
    return parseSshConfigHosts(text.slice(0, 1_000_000)).slice(0, 500)
  })
  ipcMain.handle(IPC.ptyAttach, async (event, paneId: unknown) => {
    if (!fromOurWindow(event)) throw new Error('알 수 없는 프레임의 요청')
    if (!isPaneId(paneId)) throw new Error('잘못된 pty 인자')
    await control().ready
    return control().ptys.attach(event.sender, paneId)
  })
  // 고빈도 입력은 send(응답 없음). 틀린 인자는 조용히 버린다. 지킴이와 끊긴 동안의 입력은 버린다(화면이 '연결 끊김' 을 보인다).
  ipcMain.on(IPC.ptyWrite, (event, paneId: unknown, data: unknown) => {
    if (fromOurWindow(event) && isPaneId(paneId) && validWrite(data)) hostControl?.ptys.write(event.sender, paneId, data)
  })
  ipcMain.on(IPC.ptyResize, (event, paneId: unknown, cols: unknown, rows: unknown) => {
    if (fromOurWindow(event) && isPaneId(paneId) && validSize(cols, rows)) {
      hostControl?.ptys.resize(event.sender, paneId, cols as number, rows as number)
    }
  })
  ipcMain.on(IPC.ptyKill, (event, paneId: unknown) => {
    if (fromOurWindow(event) && isPaneId(paneId)) hostControl?.ptys.kill(event.sender, paneId)
  })

  ipcMain.handle(IPC.stateLoad, (event) => {
    if (!fromOurWindow(event)) throw new Error('알 수 없는 프레임의 요청')
    stateWriter.flush() // 새로 고침 직전에 받은 값을 먼저 쓰고 읽는다
    const missing = !existsSync(join(app.getPath('userData'), 'state.json'))
    // 손상이면 마지막 정상 백업으로 (17단계)
    const file = new StateFile(app.getPath('userData'), randomUUID, () => backups().latestGood(randomUUID))
    const loaded = file.load() // 실패(EACCES 등)하면 저장 대상은 그대로 두고 renderer 에 예외로 알린다
    lastState = loaded.state
    worktreeRevision++
    stateFile = file
    if (file.canWrite) {
      lastWritten = loaded.state
      try{workspaceBrowser?.reconcile()}catch(error){report('error','browser-reconcile','브라우저 탭 기록을 정리하지 못했어요',error)}
      secretOpts = optsFrom(loaded.state.settings)
      updatePrefs = prefsFrom(loaded.state.settings)
      setChatPermission(loaded.state.settings.chatPermission)
      updater?.prefsChanged()
      // 시작 백업 — 앱 버전이 바뀌었으면 '버전 올리기 전'(90일 보존). 같은 내용이면 만들지 않는다(새로 고침마다 쌓이지 않게)
      const prev = backups().lastVersion()
      backupNow(prev !== null && prev !== app.getVersion() ? 'version' : 'start')
      backups().writeVersion(app.getVersion())
      // 이미 남은 스크롤 파일을 한 번 가린다 — 스크롤 저장과 한 줄로
      if (!redactStarted) {
        redactStarted = true
        saving = saving.then(() => scrollback().redactExisting(redactMarker(), sendRedact)).catch((e: unknown) => report('error', 'scrollback-redact', '스크롤 정리에 실패했어요', e))
      }
    }
    // 첫 실행 안내(18단계) — 파일이 없었고, 안내를 끝낸 적이 없을 때. e2e 는 TASKMINAL_FIRST_RUN=seen 이 기본
    const firstRun = missing && file.canWrite && process.env['TASKMINAL_FIRST_RUN'] !== 'seen' && !existsSync(firstRunFile())
    return firstRun ? { ...loaded, firstRun } : loaded
  })
  // renderer 를 믿지 않는다: 크기 상한 · normalizeState 로 다시 검증한 값만 쓴다.
  ipcMain.on(IPC.stateSave, (event, raw: unknown) => {
    if (!fromOurWindow(event)) return
    let bytes = 0
    try {
      bytes = Buffer.byteLength(JSON.stringify(raw)) // 한글은 글자당 3바이트 — 글자 수가 아니라 바이트로 센다
    } catch {
      return
    }
    if (bytes > MAX_STATE_BYTES) return
    const state = normalizeState(raw, randomUUID)
    lastState = state
    worktreeRevision++
    if (stateFile?.canWrite) {
      secretOpts = optsFrom(state.settings)
      updatePrefs = prefsFrom(state.settings)
      setChatPermission(state.settings.chatPermission)
      updater?.prefsChanged()
    }
    stateWriter.push(state)
    try{workflowRunner?.reconcile()}catch(e){report('error','workflow-stop','작업 흐름을 정리하지 못했어요',e)}
    try{workspaceBrowser?.reconcileLive()}catch(error){report('error','browser-live-cleanup','브라우저 화면을 정리하지 못했어요',error)}
    if(stateFile?.canWrite)try{workspaceBrowser?.reconcile()}catch(error){report('error','browser-reconcile','브라우저 탭 기록을 정리하지 못했어요',error)}
  })

  // ─── 17단계: 백업 · 되돌리기 · 내보내기/가져오기 ───
  ipcMain.handle(IPC.backupList, (event): Promise<BackupInfo[]> => {
    if (!fromOurWindow(event)) throw new Error('알 수 없는 프레임의 요청')
    return backups().list()
  })
  ipcMain.handle(IPC.backupRead, (event, name: unknown): AppState => {
    if (!fromOurWindow(event)) throw new Error('알 수 없는 프레임의 요청')
    const r = backups().read(name, randomUUID)
    if (r instanceof Error) throw r
    return r
  })
  // 되돌리기 · 가져오기 직전 — 받아 둔 상태를 먼저 쓰고 지금 모습을 백업한다. 실패면 예외(renderer 는 되돌리지 않는다)
  ipcMain.handle(IPC.backupMark, (event, what: unknown): boolean => {
    if (!fromOurWindow(event)) throw new Error('알 수 없는 프레임의 요청')
    if (!isBackupMark(what)) throw new Error('잘못된 요청')
    stateWriter.flush()
    if (!stateFile?.canWrite) throw new Error('이 실행에서는 상태를 저장하지 않아요')
    const r = backupNow(what, true)
    if (r instanceof Error) throw r
    return true
  })
  ipcMain.handle(IPC.stateExport, async (event): Promise<string | null> => {
    if (!fromOurWindow(event)) throw new Error('알 수 없는 프레임의 요청')
    stateWriter.flush()
    const state = lastWritten
    if (!state) throw new Error('내보낼 상태가 없어요')
    const win = BrowserWindow.fromWebContents(event.sender)
    const day = new Date().toISOString().slice(0, 10)
    const options = { title: '상태 내보내기', defaultPath: join(app.getPath('documents'), `taskminal-${day}.json`), filters: [{ name: 'JSON', extensions: ['json'] }] }
    const r = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (r.canceled || !r.filePath) return null
    writeFileSync(r.filePath, exportText(state, { custom: state.settings.secretCustom }), { mode: 0o600 }) // 출력 · 스크롤은 넣지 않고, 명령 속 키도 가린 글
    return r.filePath
  })
  ipcMain.handle(IPC.stateImport, async (event): Promise<{ name: string; state: AppState } | null> => {
    if (!fromOurWindow(event)) throw new Error('알 수 없는 프레임의 요청')
    const win = BrowserWindow.fromWebContents(event.sender)
    const options = { title: '상태 가져오기', properties: ['openFile'] as Array<'openFile'>, filters: [{ name: 'JSON', extensions: ['json'] }] }
    const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    const path = r.canceled ? undefined : r.filePaths[0]
    if (!path) return null
    if (statSync(path).size > MAX_STATE_BYTES) throw new Error('파일이 너무 커요 (5MB 까지)')
    const read = readStateText(readFileSync(path, 'utf8'), randomUUID)
    if (read.kind !== 'ok') throw new Error(read.kind === 'newer' ? '더 새 버전 앱이 만든 파일이에요' : 'Taskminal 상태 파일이 아니에요')
    return { name: basename(path), state: read.state }
  })
  ipcMain.handle(IPC.redactStatus, (event): RedactStatus => {
    if (!fromOurWindow(event)) throw new Error('알 수 없는 프레임의 요청')
    return scrollback().redactStatus
  })
  ipcMain.on(IPC.redactFix, (event, action: unknown, name: unknown) => {
    if (!fromOurWindow(event) || !isRedactFix(action) || typeof name !== 'string') return
    saving = saving.then(() => scrollback().fixRedact(action, name, redactMarker(), sendRedact)).catch((e: unknown) => report('error', 'scrollback-redact', '스크롤 정리에 실패했어요', e))
  })

  // 명령 기록 — 값 검사 · 가리기는 HistoryStore. 쓰기 실패는 renderer 가 '저장하지 못했어요' 줄로 보인다
  ipcMain.handle(IPC.historyList, (event) => {
    if (!fromOurWindow(event)) throw new Error('알 수 없는 프레임의 요청')
    return history().list()
  })
  ipcMain.handle(IPC.historyAppend, async (event, entries: unknown) => {
    if (!fromOurWindow(event)) throw new Error('알 수 없는 프레임의 요청')
    try {
      return await history().append(entries)
    } catch (e) {
      report('warn', 'history-save', '명령 기록을 저장하지 못했어요', e)
      throw e
    }
  })
  ipcMain.on(IPC.historyRemove, (event, taskId: unknown, ids: unknown) => {
    if (fromOurWindow(event)) history().remove(taskId, ids).catch((e: unknown) => report('warn', 'history-save', '명령 기록을 지우지 못했어요', e))
  })
  ipcMain.on(IPC.historyRemoveTask, (event, taskId: unknown) => {
    if (fromOurWindow(event)) history().removeTask(taskId).catch((e: unknown) => report('warn', 'history-save', '명령 기록을 지우지 못했어요', e))
  })
  ipcMain.handle(IPC.historyClear, (event) => {
    if (!fromOurWindow(event)) throw new Error('알 수 없는 프레임의 요청')
    return history().clear()
  })

  // 스크롤 저장 — renderer 를 믿지 않는다: paneId 검사 · pane 당 바이트 상한은 ScrollbackStore, live 수 상한은 여기
  ipcMain.handle(IPC.scrollbackLoad, (event, paneId: unknown) => {
    if (!fromOurWindow(event)) throw new Error('알 수 없는 프레임의 요청')
    return scrollback().load(paneId)
  })
  // 덤이라 실패해도 알림은 띄우지 않는다 — 다음 주기가 다시 쓴다
  const logError = (error: Error | null) => error && report('warn', 'scrollback-save', '스크롤을 저장하지 못했어요', error)
  const liveOf = (raw: unknown): { live: unknown[]; panes: unknown } | null => {
    const r = (raw ?? {}) as Record<string, unknown>
    return Array.isArray(r['live']) && r['live'].length <= MAX_LIVE_PANES ? { live: r['live'], panes: r['panes'] } : null
  }
  ipcMain.on(IPC.scrollbackSave, (event, raw: unknown) => {
    const req = fromOurWindow(event) ? liveOf(raw) : null
    if (req) saving = saving.then(() => scrollback().save(req.live, req.panes)).then(logError, logError)
  })
  ipcMain.on(IPC.scrollbackSaveSync, (event, raw: unknown) => {
    try {
      const req = fromOurWindow(event) ? liveOf(raw) : null
      if (req) logError(scrollback().saveSync(req.live, req.panes))
    } finally {
      event.returnValue = true // 돌려주지 않으면 renderer 가 멈춘다
    }
  })
  ipcMain.handle(IPC.gitBranches, async (event, dirs: unknown): Promise<Record<string, string | null>> => {
    if (!fromOurWindow(event)) throw new Error('알 수 없는 프레임의 요청')
    if (!Array.isArray(dirs) || dirs.length > MAX_BRANCH_DIRS) return {}
    const ok = dirs.filter((d): d is string => typeof d === 'string' && d.length > 0 && d.length <= 4096)
    return branchesOf(ok, homedir())
  })
  ipcMain.handle(IPC.gitWorktreeAdd, async (event, dir: unknown, branch: unknown): Promise<WorktreeResult> => {
    if (!fromOurWindow(event)) throw new Error('알 수 없는 프레임의 요청')
    if (typeof dir !== 'string' || typeof branch !== 'string' || dir.length === 0 || dir.length > 4096 || branch.length > 200) {
      return { ok: false, error: '잘못된 요청' }
    }
    return addWorktree(dir, branch, homedir())
  })
  ipcMain.handle(IPC.ptyCwds, async (event, paneIds: unknown): Promise<Record<string, string>> => {
    if (!fromOurWindow(event)) throw new Error('알 수 없는 프레임의 요청')
    if (!Array.isArray(paneIds) || paneIds.length > MAX_LIVE_PANES) return {}
    const pids = control().ptys.pids(event.sender, paneIds.filter(isPaneId))
    const cwds = await lsofCwds(Object.values(pids))
    const out: Record<string, string> = {}
    for (const [paneId, pid] of Object.entries(pids)) if (cwds[pid]) out[paneId] = cwds[pid]
    return out
  })

  // 20단계 포트 — 그 창의 pane 셸만 조사 · 끄기
  ipcMain.handle(IPC.portsProbe, async (event, paneIds: unknown): Promise<ProbeResult> => {
    if (!fromOurWindow(event)) throw new Error('알 수 없는 프레임의 요청')
    if (!Array.isArray(paneIds) || paneIds.length > MAX_LIVE_PANES) return { ok: false }
    return probePorts(control().ptys.pids(event.sender, paneIds.filter(isPaneId)))
  })
  ipcMain.handle(IPC.portsKill, async (event, paneId: unknown, port: unknown, pid: unknown): Promise<'killed' | 'gone' | 'failed'> => {
    if (!fromOurWindow(event)) throw new Error('알 수 없는 프레임의 요청')
    if (!isPaneId(paneId) || !Number.isInteger(port) || !Number.isInteger(pid) || (pid as number) <= 1) return 'failed'
    const shellPid = control().ptys.pids(event.sender, [paneId])[paneId]
    return shellPid ? killPort(shellPid, port as number, pid as number) : 'gone'
  })

  // ─── 23단계: 변경 검토 — 폴더 · 경로 모양만 믿는다(경로는 review-git 이 저장소 안인지 · 바뀐 목록에 있는지 다시 본다) ───
  const okDir = (v: unknown): v is string => typeof v === 'string' && isAbsolute(v) && v.length <= 4096 && !v.includes('\0')
  const okStrs = (v: unknown, max: number): v is string[] => Array.isArray(v) && v.length <= max && v.every((x) => typeof x === 'string' && x.length <= 4096)
  const okBase = (v: unknown): v is string | null => v === null || v === 'main' || v === 'master'
  ipcMain.handle(IPC.reviewLoad, async (event, dir: unknown, base: unknown): Promise<ReviewLoad> => {
    if (!fromOurWindow(event)) throw new Error('알 수 없는 프레임의 요청')
    if (!okDir(dir) || !okBase(base)) return { state: 'error', message: '잘못된 요청' }
    return loadReview(runGit, dir, base)
  })
  ipcMain.handle(IPC.reviewRevertLines, async (event, dir: unknown, path: unknown, sig: unknown, keys: unknown): Promise<RevertResult> => {
    if (!fromOurWindow(event)) throw new Error('알 수 없는 프레임의 요청')
    if (!okDir(dir) || typeof path !== 'string' || !safeRel(path) || typeof sig !== 'string' || !okStrs(keys, 100_000) || !keys.every((k) => /^\d+:\d+$/.test(k))) return { ok: false, reason: 'changed' }
    return revertLines(runGit, reverts(), dir, path, sig, keys)
  })
  ipcMain.handle(IPC.reviewRevertFile, async (event, dir: unknown, path: unknown, sig: unknown): Promise<RevertResult> => {
    if (!fromOurWindow(event)) throw new Error('알 수 없는 프레임의 요청')
    if (!okDir(dir) || typeof path !== 'string' || !safeRel(path) || typeof sig !== 'string') return { ok: false, reason: 'changed' }
    return revertFile(runGit, reverts(), dir, path, sig)
  })
  ipcMain.handle(IPC.reviewRestore, async (event, id: unknown): Promise<RestoreResult> => {
    if (!fromOurWindow(event)) throw new Error('알 수 없는 프레임의 요청')
    return typeof id === 'string' ? restoreReverted(runGit, reverts(), id) : 'gone'
  })
  ipcMain.handle(IPC.reviewReverted, (event, root: unknown): RevertedView[] => {
    if (!fromOurWindow(event)) throw new Error('알 수 없는 프레임의 요청')
    if (!okDir(root)) return []
    return reverts().list(root).map(({ id, at, path, what }) => ({ id, at, path, what }))
  })
  ipcMain.handle(IPC.reviewClearReverted, (event) => {
    if (!fromOurWindow(event)) throw new Error('알 수 없는 프레임의 요청')
    reverts().clear()
  })
  ipcMain.handle(IPC.reviewCommit, async (event, dir: unknown, paths: unknown, message: unknown, sigs: unknown): Promise<CommitResult> => {
    if (!fromOurWindow(event)) throw new Error('알 수 없는 프레임의 요청')
    if (!okDir(dir) || !okStrs(paths, 20_000) || !okStrs(sigs, 20_000) || typeof message !== 'string' || message.length > 100_000) return { ok: false, reason: 'changed', tail: '' }
    return commitFiles(runGit, dir, paths, message, sigs)
  })
  ipcMain.handle(IPC.reviewUndoCommit, async (event, dir: unknown, hash: unknown): Promise<UndoResult> => {
    if (!fromOurWindow(event)) throw new Error('알 수 없는 프레임의 요청')
    if (!okDir(dir) || typeof hash !== 'string') return 'failed'
    return undoCommit(runGit, dir, hash)
  })
  ipcMain.on(IPC.reviewWatch, (event, paneId: unknown, root: unknown) => {
    if (!fromOurWindow(event) || !isPaneId(paneId)) return
    const wc = event.sender
    const key = `${wc.id}:${paneId}`
    const dir = okDir(root) ? root : null
    reviewWatch.set(key, dir, () => {
      if (!wc.isDestroyed()) wc.send(IPC.reviewChanged, paneId)
    })
    if (dir)
      void runGit(['rev-parse', '--absolute-git-dir'], { cwd: dir }).then((g) => {
        if (g.code === 0) reviewWatch.addGitDir(key, dir, g.stdout.trim())
      })
  })
  ipcMain.on(IPC.reviewOpenFile, (event, root: unknown, path: unknown) => {
    if (!fromOurWindow(event) || !okDir(root) || typeof path !== 'string' || !safeRel(path)) return
    // shell.openPath 는 .command · .app 을 실행한다 — 기본 글 편집기로만 연다. root 가 저장소 뿌리인지 main 이 다시 본다
    void openTarget(runGit, root, path).then((full) => {
      if (full) void openTextEditor(full).catch((e: unknown) => report('error', 'text-editor', '텍스트 편집기를 열지 못했어요', e))
    })
  })

  // ─── 21단계: 대화 ───
  const okSid = (v: unknown): v is string => typeof v === 'string' && /^[\w-]{1,100}$/.test(v)
  /** renderer 가 보낸 pane 의 대화 정보 — 에이전트 · id 모양만 믿는다 */
  const chatRef = (v: unknown): ChatRef | null => {
    if (!isObj(v) || !isChatAgent(v['agent'])) return null
    return { agent: v['agent'], ...(okSid(v['sessionId']) ? { sessionId: v['sessionId'] } : {}), ...(okSid(v['forkAt']) ? { forkAt: v['forkAt'] } : {}) }
  }
  ipcMain.handle(IPC.chatSend, async (event, paneId: unknown, text: unknown, cwd: unknown, chat: unknown, images: unknown) => {
    if (!fromOurWindow(event)) throw new Error('알 수 없는 프레임의 요청')
    if (!isPaneId(paneId) || typeof text !== 'string' || !text.trim() || text.length > 100_000 || typeof cwd !== 'string' || cwd.length > 4096) throw new Error('잘못된 대화 인자')
    const ref = chatRef(chat)
    if (!ref) throw new Error('잘못된 대화 인자')
    const imgs = images === undefined ? [] : images
    if (!isChatImages(imgs)) throw new Error('붙일 수 없는 그림')
    return chats().send(event.sender, paneId, text, cwd, ref, imgs)
  })
  const isIndex = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) < 1_000_000
  ipcMain.handle(IPC.chatRewind, async (event, paneId: unknown, index: unknown, at: unknown, chat: unknown) => {
    if (!fromOurWindow(event)) throw new Error('알 수 없는 프레임의 요청')
    const ref = chatRef(chat)
    if(typeof paneId==='string'&&lastState?.tasks.some(t=>t.panes[paneId]?.workflowRunId))throw new Error('작업 흐름의 실행 대화는 되감을 수 없어요')
    if (!isPaneId(paneId) || !isIndex(index) || typeof at !== 'number' || !ref) return null
    return chats().rewind(paneId, index, at, ref)
  })
  ipcMain.handle(IPC.chatBranch, async (event, from: unknown, to: unknown, index: unknown, at: unknown) => {
    if (!fromOurWindow(event)) throw new Error('알 수 없는 프레임의 요청')
    if (!isPaneId(from) || !isPaneId(to) || from === to || !isIndex(index) || typeof at !== 'number') return null
    const source=lastState?.tasks.flatMap(t=>Object.values(t.panes)).find(p=>p.id===from)
    const result=await chats().branch(from, to, index, at)
    if(result&&source?.chat)agentAccounts?.copyBinding(from,to,source.chat.agent)
    return result
  })
  /** 📎 — 그림 파일을 골라 읽는다(renderer 는 파일을 못 읽는다). 크기 · 종류가 맞지 않는 것은 빼고 그 이름을 돌려준다 */
  ipcMain.handle(IPC.chatPickImages, async (event): Promise<{ images: ChatImage[]; skipped: string[] }> => {
    if (!fromOurWindow(event)) throw new Error('알 수 없는 프레임의 요청')
    const win = BrowserWindow.fromWebContents(event.sender)
    const options = { title: '그림 붙이기', properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>, filters: [{ name: '그림', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }] }
    const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (r.canceled) return { images: [], skipped: [] }
    const mimeOf: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
    const images: ChatImage[] = []
    const skipped: string[] = []
    for (const f of r.filePaths) {
      const name = basename(f)
      const mime = mimeOf[name.split('.').pop()?.toLowerCase() ?? '']
      try {
        // 4 × 5MB 까지 — main 을 막지 않게 비동기로 읽는다(리뷰)
        if (!mime || images.length >= IMAGE_MAX_COUNT || (await stat(f)).size > IMAGE_MAX_BYTES) throw new Error('skip')
        images.push({ name, mime, data: (await readFile(f)).toString('base64') })
      } catch {
        skipped.push(name)
      }
    }
    return { images, skipped }
  })
  ipcMain.on(IPC.chatAnswer, (event, paneId: unknown, requestId: unknown, decision: unknown) => {
    if (fromOurWindow(event) && isPaneId(paneId) && typeof requestId === 'string' && requestId.length <= 200 && isChatDecision(decision)) chats().answer(paneId, requestId, decision)
  })
  ipcMain.on(IPC.chatInterrupt, (event, paneId: unknown) => {
    if (fromOurWindow(event) && isPaneId(paneId)) chats().interrupt(paneId)
  })
  ipcMain.handle(IPC.chatHistory, (event, paneId: unknown) => {
    if (!fromOurWindow(event)) throw new Error('알 수 없는 프레임의 요청')
    return isPaneId(paneId) ? chats().history(paneId) : { events: [], upTo: 0 }
  })
  ipcMain.on(IPC.chatClose, (event, paneId: unknown, forget: unknown) => {
    if (fromOurWindow(event) && isPaneId(paneId)) chats().close(paneId, forget === true)
  })

  // 24단계 taskminal — 창의 답. 번호가 맞는(아직 기다리는) 답만, 모양을 다시 본다
  ipcMain.on(IPC.cliReply, (event, id: unknown, raw: unknown) => {
    if (!fromOurWindow(event) || typeof id !== 'number') return
    const done = cliPending.get(id)
    if (!done) return
    done(parseUiReply(raw) ?? { ok: false, error: '앱 화면의 답을 읽지 못했어요' })
  })
  onCliInstall(() => void installCliMenu())

  // 셸 지킴이 — 설정 칸 · 위 줄
  ipcMain.handle(IPC.hostView, (event) => {
    if (!fromOurWindow(event)) throw new Error('알 수 없는 프레임의 요청')
    return control().view()
  })
  ipcMain.handle(IPC.hostSessions, async (event, clearUnseen: unknown) => {
    if (!fromOurWindow(event)) throw new Error('알 수 없는 프레임의 요청')
    await control().ready
    return control().sessions(clearUnseen === true)
  })
  ipcMain.handle(IPC.hostTail, async (event, paneId: unknown) => {
    if (!fromOurWindow(event)) throw new Error('알 수 없는 프레임의 요청')
    return isPaneId(paneId) ? redact(await control().tail(paneId), secretOpts) : '' // 화면에 보이는 글 — 비밀값을 가려서
  })
  ipcMain.on(IPC.hostKill, (event, paneIds: unknown) => {
    if (!fromOurWindow(event) || !Array.isArray(paneIds) || paneIds.length > MAX_LIVE_PANES) return
    hostControl?.ptys.killUnowned(paneIds.filter(isPaneId))
  })
  ipcMain.on(IPC.hostAction, (event, action: unknown) => {
    if (!fromOurWindow(event) || !isHostAction(action)) return
    if (action === 'quit-all') return void quitAll()
    void hostControl?.action(action)
  })

  // ─── 18단계: 업데이트 · 오류 기록 · 첫 실행 ───
  ipcMain.handle(IPC.updateView, (event): UpdateView => {
    if (!fromOurWindow(event)) throw new Error('알 수 없는 프레임의 요청')
    return updater?.view() ?? { state: 'idle', current: app.getVersion() }
  })
  ipcMain.on(IPC.updateAction, (event, action: unknown) => {
    if (!fromOurWindow(event) || !isUpdateAction(action) || !updater) return
    if (action === 'check') void updater.check()
    else if (action === 'download') void updater.download()
    else if (action === 'install') updater.install()
    else moveToApplications()
  })
  ipcMain.handle(IPC.errlogList, (event, level: unknown) => {
    if (!fromOurWindow(event)) throw new Error('알 수 없는 프레임의 요청')
    return errlog().rows(level === 'error' || level === 'warn' ? level : undefined)
  })
  ipcMain.on(IPC.errlogOpen, (event) => {
    if (!fromOurWindow(event)) return
    try {
      mkdirSync(errlog().dir, { recursive: true, mode: 0o700 })
    } catch {
      // 열기에서 알린다
    }
    void shell.openPath(errlog().dir)
  })
  ipcMain.on(IPC.firstRunDone, (event) => {
    if (!fromOurWindow(event)) return
    try {
      writeFileSync(firstRunFile(), String(Date.now()), { mode: 0o600 })
    } catch (e) {
      report('warn', 'first-run', '첫 실행 안내를 끝낸 것을 저장하지 못했어요', e)
    }
  })

  ipcMain.handle(IPC.pickFolder, async (event): Promise<string | null> => {
    if (!fromOurWindow(event)) throw new Error('알 수 없는 프레임의 요청')
    const win = BrowserWindow.fromWebContents(event.sender)
    const options = { title: '작업 폴더 선택', properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'> }
    const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })

  const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 10_000
  ipcMain.on(IPC.quitGuard, (event, busy: unknown) => {
    if (fromOurWindow(event) && isCount(busy)) busyCommands = busy
  })
  ipcMain.on(IPC.badge, (event, count: unknown) => {
    if (fromOurWindow(event) && isCount(count)) setBadge(count)
  })
  ipcMain.on(IPC.beep, (event) => {
    if (fromOurWindow(event)) shell.beep()
  })
  ipcMain.on(IPC.openLink, (event, url: unknown) => {
    if (fromOurWindow(event) && typeof url === 'string' && url.length <= MAX_LINK) openExternalIfWeb(url)
  })
  ipcMain.on(IPC.menuKeys, (event, keys: unknown) => {
    if (!fromOurWindow(event) || typeof keys !== 'object' || keys === null) return
    const safe: Record<string, string> = {}
    for (const [command, accel] of Object.entries(keys)) if (isAppCommand(command) && isAccel(accel)) safe[command] = accel
    installAppMenu(safe)
  })

  // ⌥⌘Q 셸까지 모두 끝내기 (메뉴 · 단축키 · ⌘P) — 실행 중이 있고 '끄기 전에 묻기' 가 켜져 있으면 확인(renderer 가 꺼져 있으면 0 을 보낸다)
  async function quitAll(): Promise<void> {
    if (asking || quitting || !hostControl) return
    asking = true
    try {
      if (!(await hostControl.quitAll(mainWindow, busyCommands, true))) return
      quitting = true
      app.quit()
    } finally {
      asking = false
    }
  }
  onQuitAll(() => void quitAll())

  // ⌘Q · Dock 의 끝내기: 셸은 지킴이에 남는다(묻지 않음). 처음 한 번만 안내한다.
  app.on('before-quit', (event) => {
    if (quitting || !hostControl) return
    event.preventDefault()
    if (asking) return
    asking = true
    void hostControl
      .beforeQuit(mainWindow)
      .then(async (choice) => {
        if (choice === 'cancel') return
        if (choice === 'quit-all') await hostControl!.quitAll(mainWindow, 0, false)
        quitting = true
        app.quit()
      })
      .finally(() => (asking = false))
  })

  // ④ 앱 종료 — 셸은 지킴이에 남는다. 상태를 쓰고 지킴이와의 연결만 놓는다.
  app.on('will-quit', () => {
    try {
      stateWriter.flush() // 디바운스 중인 마지막 상태를 동기로 쓴다
    } finally {
      hostControl?.dispose()
      chatManager?.killAll()
      cliServer?.close() // 소켓 파일을 지운다 — 기다리던 CLI 는 '연결이 끊겼어요'
      markRunning(false) // 정상으로 끝남 — 다음 실행이 '갑자기 꺼짐' 으로 보지 않게
    }
  })
  // 도우미 프로세스(GPU · 네트워크 …)가 비정상으로 끝나면 기록만 (화면 renderer 는 창의 render-process-gone 이 맡는다)
  app.on('child-process-gone', (_event, details) => {
    if (details.reason !== 'clean-exit') report('warn', 'child-gone', `도우미 프로세스가 끝났어요 (${details.type})`, `${details.reason} (${details.exitCode})`)
  })

  void app.whenReady().then(() => {
    // 개발 실행 Dock 아이콘 — 패키징본은 Info.plist 의 icon.icns 를 쓴다
    if (!app.isPackaged) {
      const icon = join(app.getAppPath(), 'resources', 'icon', 'icon.png')
      if (existsSync(icon)) app.dock?.setIcon(icon)
    }
    // 오류 기록 폴더: ~/Library/Logs/Taskminal (e2e 는 임시 userData 안)
    app.setAppLogsPath(userDataOverride ? join(userDataOverride, 'logs') : undefined)
    errlog().prune()
    crashedLast = existsSync(runningFile())
    if (crashedLast) errlog().write('error', 'crash', '지난번에 Taskminal 이 갑자기 꺼졌어요')
    markRunning(true)
    installAppMenu()
    cliSockPath = cliSocketPath(app.getPath('userData'), tmpdir(), (s) => createHash('sha1').update(s).digest('hex'), process.platform)
    // 새 셸을 띄울 때만 불린다 — 같은 pane id 로 새 셸이면 앞 셸의 끝 · 실행 중 표시를 지운다(24 리뷰)
    const newShellEnv = (paneId: string) => {
      paneWatch.forget(paneId)
      return cliEnv(paneId)
    }
    hostControl = createHostControl(zshIntegrationDir, allowedShells, (error) => report('error', 'host-down', '셸 지킴이에 연결하지 못했어요', error), newShellEnv, {
      data: (paneId, data) => paneWatch.feed(paneId, data),
      exit: (paneId, code) => paneWatch.exit(paneId, code),
    })
    startCliServer()
    updater = createUpdater()
    const firstMs = Number(process.env['TASKMINAL_UPDATE_FIRST_MS'])
    setTimeout(() => void updater?.check(), Number.isInteger(firstMs) && firstMs >= 0 ? firstMs : UPDATE_FIRST_DELAY_MS).unref()
    setInterval(() => void updater?.check(), UPDATE_CHECK_MS).unref()
    // 바뀐 게 있으면 한 시간마다 '자동' 백업 — 하루 하나 보존 규칙과 함께 '그날의 마지막' 이 남는다
    setInterval(() => {
      if (!changedSinceAuto || !stateFile?.canWrite) return
      changedSinceAuto = false
      backupNow('auto')
    }, AUTO_BACKUP_MS).unref()
    mainWindow = createWindow()
    // macOS: Dock 아이콘을 누르면 창을 다시 만든다.
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
    })
  })

  // macOS 는 창을 다 닫아도 앱이 남는다.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
