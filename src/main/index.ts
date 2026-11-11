import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { basename, join } from 'node:path'
import { AUTO_BACKUP_MS, backupReasonFor, exportText, SETTINGS_BACKUP_GAP_MS, type BackupInfo, type BackupReason } from '../shared/backup'
import { IPC, isBackupMark, isHostAction, isRedactFix, type AppInfo, type RedactStatus } from '../shared/ipc'
import { normalizeState } from '../shared/model'
import { Debouncer, readStateText } from '../shared/persist'
import { redact, type SecretOptions } from '../shared/redact'
import { isAccel, isAppCommand } from '../shared/keymap'
import { MAX_LINK, webUrl } from '../shared/links'
import type { RendererMode } from '../shared/renderer'
import { isPaneId, validSize, validWrite } from '../shared/pty'
import type { AppState, Settings } from '../shared/types'
import { installAppMenu, onQuitAll } from './menu'
import { lsofCwds } from './cwd-probe'
import { branchesOf } from './git-branch'
import { addWorktree } from './worktree'
import type { WorktreeResult } from '../shared/worktree'
import { createHostControl, type HostControl } from './host-control'
import { BackupStore } from './backup-store'
import { ScrollbackStore } from './scrollback-store'
import { StateFile } from './state-file'

// e2e 는 임시 폴더를 넘긴다 — 실제 ~/Library/Application Support/Taskminal 을 건드리지 않게. ready 전에 정해야 한다.
const userDataOverride = process.env['TASKMINAL_USER_DATA']
if (userDataOverride) app.setPath('userData', userDataOverride)

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
const control = (): HostControl => {
  if (!hostControl) throw new Error('셸 지킴이가 아직 준비되지 않음')
  return hostControl
}

// renderer 가 알려 주는 값: 실행 중 명령 수(끄기 전 확인이 꺼져 있으면 0) — renderer 가 사라지면 0
let busyCommands = 0
let quitting = false // 끝내기를 정했다 — before-quit 이 다시 묻지 않게
let asking = false // 안내 · 확인 창이 떠 있다 — 두 번째 창을 띄우지 않는다
const setBadge = (n: number) => app.dock?.setBadge(n > 0 ? String(n) : '')

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
// 상태 백업(17단계) — userData 가 정해진 뒤 만든다
let backupStore: BackupStore | null = null
const backups = () => (backupStore ??= new BackupStore(app.getPath('userData')))
let lastWritten: AppState | null = null // 디스크에 있는 상태 — 다음 상태와 비교해 백업 이유를 정한다
let lastSettingsBackup = 0
let changedSinceAuto = false
let backupFailing = false
/** 백업 실패는 상태 저장을 막지 않는다 — 노란 줄로 알리고, 다음에 되면 줄을 지운다 */
function backupNow(reason: BackupReason, force = false): string | null | Error {
  const r = backups().snapshot(reason, Date.now(), force)
  if (r instanceof Error) {
    console.error('백업을 만들지 못함', r)
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
// 15e: 터미널 그리기 — 시험(e2e)은 DOM 의 글을 읽으므로 playwright 설정이 dom 을 넣는다
const renderer: RendererMode = process.env['TASKMINAL_RENDERER'] === 'dom' ? 'dom' : 'webgl'
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
    console.error('상태를 저장하지 못함', error)
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
    console.error(`화면을 읽지 못함 (${code} ${description}): ${url}`)
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
  // 종료 경로 4개 중 창에 딸린 3개 — 셸은 지킴이에 남기고 떼기만 한다(16단계). 다시 열리면 attach 로 다시 붙는다.
  const wc = win.webContents
  // renderer 가 사라지면(창 닫기 · 새로 고침 · 충돌) 그 renderer 가 알려 준 수도 버린다 — 새 페이지가 다시 보낸다
  const forget = () => {
    busyCommands = 0
    setBadge(0)
  }
  const detach = () => {
    hostControl?.ptys.detachOwner(wc)
    forget()
  }
  wc.on('destroyed', detach) // ① 창 닫기
  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) detach() // ② 새로 고침 — 새 페이지가 다시 붙는다(수 · 배지도 다시 보낸다)
  })
  // ③ 렌더러 충돌 — 셸은 남아 있으니 창을 다시 읽어 다시 붙는다. 10초 안에 또 죽으면 다시 읽지 않는다(충돌 되풀이)
  let lastCrash = 0
  wc.on('render-process-gone', () => {
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
    return { name: app.getName(), version: app.getVersion(), shells: allowedShells, host: hostname(), home: homedir(), cwdPollMs, renderer }
  })

  ipcMain.handle(IPC.ptySpawn, async (event, paneId: unknown, opts: unknown) => {
    if (!fromOurWindow(event)) throw new Error('알 수 없는 프레임의 요청')
    const o = (opts ?? {}) as Record<string, unknown>
    if (!isPaneId(paneId) || typeof o['cwd'] !== 'string' || !validSize(o['cols'], o['rows'])) {
      throw new Error('잘못된 pty 인자')
    }
    await control().ready
    await control().ptys.spawn(event.sender, paneId, {
      cwd: o['cwd'],
      cols: o['cols'] as number,
      rows: o['rows'] as number,
      shell: typeof o['shell'] === 'string' ? o['shell'] : null, // 경로 검사는 PtyManager(pickShell)
      integration: o['integration'] !== false,
    })
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
    // 손상이면 마지막 정상 백업으로 (17단계)
    const file = new StateFile(app.getPath('userData'), randomUUID, () => backups().latestGood(randomUUID))
    const loaded = file.load() // 실패(EACCES 등)하면 저장 대상은 그대로 두고 renderer 에 예외로 알린다
    stateFile = file
    if (file.canWrite) {
      lastWritten = loaded.state
      secretOpts = optsFrom(loaded.state.settings)
      // 시작 백업 — 앱 버전이 바뀌었으면 '버전 올리기 전'(90일 보존). 같은 내용이면 만들지 않는다(새로 고침마다 쌓이지 않게)
      const prev = backups().lastVersion()
      backupNow(prev !== null && prev !== app.getVersion() ? 'version' : 'start')
      backups().writeVersion(app.getVersion())
      // 이미 남은 스크롤 파일을 한 번 가린다 — 스크롤 저장과 한 줄로
      if (!redactStarted) {
        redactStarted = true
        saving = saving.then(() => scrollback().redactExisting(redactMarker(), sendRedact)).catch((e: unknown) => console.error('스크롤 정리 실패', e))
      }
    }
    return loaded
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
    if (stateFile?.canWrite) secretOpts = optsFrom(state.settings)
    stateWriter.push(state)
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
    saving = saving.then(() => scrollback().fixRedact(action, name, redactMarker(), sendRedact)).catch((e: unknown) => console.error('스크롤 정리 실패', e))
  })

  // 스크롤 저장 — renderer 를 믿지 않는다: paneId 검사 · pane 당 바이트 상한은 ScrollbackStore, live 수 상한은 여기
  ipcMain.handle(IPC.scrollbackLoad, (event, paneId: unknown) => {
    if (!fromOurWindow(event)) throw new Error('알 수 없는 프레임의 요청')
    return scrollback().load(paneId)
  })
  // 덤이라 실패해도 알림은 띄우지 않는다 — 다음 주기가 다시 쓴다
  const logError = (error: Error | null) => error && console.error('스크롤을 저장하지 못함', error)
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
    }
  })

  void app.whenReady().then(() => {
    // 개발 실행 Dock 아이콘 — 패키징본은 Info.plist 의 icon.icns 를 쓴다
    if (!app.isPackaged) {
      const icon = join(app.getAppPath(), 'resources', 'icon', 'icon.png')
      if (existsSync(icon)) app.dock?.setIcon(icon)
    }
    installAppMenu()
    hostControl = createHostControl(zshIntegrationDir, allowedShells)
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
