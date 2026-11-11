// 셸 지킴이(16단계)를 앱에 잇는 곳 — 지킴이 손님 · PtyManager 를 만들고, 상태(HostView)를 창에 알리고,
// 메모리 점검 · 옛 버전 지킴이 찾기 · 끝내기(⌘Q 처음 안내 · ⌥⌘Q 모두 끝내기)를 맡는다.

import { app, BrowserWindow, dialog, shell } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { IPC, type HostAction, type HostView } from '../shared/ipc'
import { memoryWarning, PTYHOST_PROTOCOL, socketPath, socketVersion, WARN_RSS_MB, type SessionInfo } from '../shared/ptyhost'
import { HostClient, oneShot, type HostStatus } from './ptyhost/client'
import { PtyManager } from './pty-manager'

const envInt = (name: string): number | undefined => {
  const v = Number(process.env[name])
  return process.env[name] !== undefined && Number.isInteger(v) && v >= 0 ? v : undefined
}

export interface HostControl {
  ptys: PtyManager
  /** 첫 연결(또는 실패)이 정해질 때까지 — 셸 요청은 이것을 기다린다 */
  ready: Promise<void>
  view(): HostView
  /** ⌘Q: 처음 한 번 안내. true 면 그대로 끝내도 된다 */
  beforeQuit(win: BrowserWindow | null): Promise<'quit' | 'quit-all' | 'cancel'>
  /** ⌥⌘Q 모두 끝내기 — 확인(실행 중이 있을 때) 뒤 지킴이 · 셸을 끝낸다. false = 확인에서 닫음. 앱은 부르는 쪽이 끝낸다 */
  quitAll(win: BrowserWindow | null, busy: number, confirm: boolean): Promise<boolean>
  action(a: HostAction): Promise<void>
  tail(paneId: string, lines?: number): Promise<string>
  sessions(clearUnseen: boolean): Promise<SessionInfo[]>
  /** 앱이 끝날 때 — 연결만 놓는다(셸은 남는다) */
  dispose(): void
}

/** onDown: 지킴이에 연결하지 못함 · 끊김 — 오류 기록에 남긴다 (18단계) */
export interface HostTap {
  /** 주인(창)과 상관없이 모든 출력 · 끝 — CLI 의 pane wait (24단계) */
  data(paneId: string, data: string): void
  exit(paneId: string, exitCode: number): void
}

export function createHostControl(
  zshIntegrationDir: string | null,
  allowedShells: readonly string[],
  onDown: (error?: string) => void = () => {},
  paneEnv: (paneId: string) => Record<string, string> = () => ({}),
  tap: HostTap | null = null,
): HostControl {
  const userData = app.getPath('userData')
  const protocol = envInt('TASKMINAL_PTYHOST_PROTOCOL') ?? PTYHOST_PROTOCOL // 시험: 옛 버전 흉내
  const sockPath = socketPath(userData, protocol, tmpdir(), (s) => createHash('sha1').update(s).digest('hex'))
  const hostScript = process.env['TASKMINAL_PTYHOST_SCRIPT'] ?? join(__dirname, 'host.js')
  const noticeFile = join(userData, 'quit-notice-seen')
  const logFile = join(userData, 'ptyhost.log')

  let view: HostView = { state: 'starting', sockPath, oldHost: null }
  const broadcast = () => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.isDestroyed()) w.webContents.send(IPC.hostView, view)
  }
  const patch = (p: Partial<HostView>) => {
    view = { ...view, ...p }
    broadcast()
  }

  let markReady: () => void = () => {}
  const ready = new Promise<void>((r) => (markReady = r))

  // 새 지킴이로 바뀌었다(지킴이를 잃음 · 다시 시작) — 창을 다시 읽어 13단계 되살리기 뒤 새 셸을 띄운다
  const reloadWindows = () => {
    ptys.clear()
    for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.isDestroyed()) w.webContents.reload()
  }

  const host = new HostClient({
    sockPath,
    userData,
    hostScript,
    execPath: process.execPath,
    env: process.env,
    ...(envInt('TASKMINAL_PTYHOST_RETRY_MS') !== undefined ? { retryScale: envInt('TASKMINAL_PTYHOST_RETRY_MS')! } : {}),
    onData: (paneId, data) => {
      tap?.data(paneId, data)
      ptys.onHostData(paneId, data)
    },
    onExit: (paneId, exit) => {
      tap?.exit(paneId, exit.exitCode)
      ptys.onHostExit(paneId, exit)
    },
    onStatus: (s: HostStatus) => {
      if (s.state === 'connected') {
        patch({ state: 'connected', pid: s.pid, version: s.version, startedAt: s.startedAt, fresh: s.fresh || view.fresh === true, attempt: undefined, of: undefined, error: undefined })
        markReady()
      } else if (s.state === 'reconnecting') patch({ state: 'reconnecting', attempt: s.attempt, of: s.of })
      else if (s.state === 'down') {
        patch({ state: 'down', error: s.error })
        onDown(s.error)
        markReady()
      } else patch({ state: 'starting' })
    },
    // 끊긴 동안(처음 연결 실패 포함) 셸을 못 띄운 pane 이 있으면 창을 다시 읽어 attach 부터 다시 — 셸은 남아 있다
    onReconnected: () => (ptys.takeMissed() ? reloadWindows() : void ptys.reattachAll()),
    onHostLost: () => {
      patch({ fresh: true })
      reloadWindows()
    },
  })
  const ptys = new PtyManager(host, zshIntegrationDir, allowedShells, paneEnv)
  void host.start().then(() => findOldHosts())

  // 메모리 · 셸 수 — 시작 10초 뒤, 그 뒤 5분마다. 기준을 넘으면 실행마다 한 번 알린다
  const statsMs = envInt('TASKMINAL_PTYHOST_STATS_MS')
  const warnMb = envInt('TASKMINAL_PTYHOST_WARN_MB') ?? WARN_RSS_MB
  const checkStats = async () => {
    if (!host.connected) return
    const r = await host.request({ op: 'stats' }).catch(() => null)
    if (!r) return
    const stats = { rss: Number(r['rss']) || 0, sessions: Number(r['sessions']) || 0 }
    patch({ ...stats, ...(memoryWarning(stats, warnMb) && view.memoryWarning === undefined ? { memoryWarning: true } : {}) })
  }
  setTimeout(() => {
    void checkStats()
    setInterval(() => void checkStats(), statsMs ?? 5 * 60_000).unref()
  }, statsMs ?? 10_000).unref()

  // 같은 폴더의 다른 버전 소켓 — 살아 있는 셸이 있으면 알린다
  const prefix = basename(sockPath).replace(/-v\d+\.sock$/, '')
  const otherSockets = (): Array<{ path: string; version: number }> => {
    try {
      return readdirSync(dirname(sockPath))
        .map((name) => ({ path: join(dirname(sockPath), name), version: socketVersion(name, prefix) }))
        // 옛 버전만 — 더 새 앱이 띄운 지킴이를 옛 앱이 '바꾸기' 로 끄지 않게
        .filter((x): x is { path: string; version: number } => x.version !== null && x.version < protocol)
    } catch {
      return []
    }
  }
  async function findOldHosts(): Promise<void> {
    for (const o of otherSockets()) {
      const r = await oneShot(o.path, [{ op: 'hello', version: protocol }, { op: 'list' }])
      const sessions = (r?.[1]?.['sessions'] as SessionInfo[] | undefined)?.filter((s) => !s.exited).length ?? 0
      if (sessions > 0) return patch({ oldHost: { version: o.version, sessions } })
    }
  }

  const askBox = async (win: BrowserWindow | null, options: Electron.MessageBoxOptions) => {
    if (win && !win.isDestroyed() && (!win.isVisible() || win.isMinimized())) win.show()
    return win && !win.isDestroyed() ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)
  }

  let quittingAll = false
  return {
    ptys,
    ready,
    view: () => view,
    async beforeQuit(win) {
      const seen = process.env['TASKMINAL_QUIT_NOTICE'] === 'seen' || existsSync(noticeFile)
      if (seen) return 'quit'
      // view.sessions 는 5분마다 읽는 값이라 늦다 — 지금 물어본다
      const live = (await ptys.sessions().catch(() => [])).filter((s) => !s.exited).length
      if (live === 0) return 'quit'
      const r = await askBox(win, {
        type: 'info',
        message: '이제 앱을 꺼도 셸은 계속 돌아요',
        detail: `셸 ${live}개는 다시 열면 그대로 이어져요.\n셸까지 끄고 싶으면 ⌥⌘Q 를 눌러요.`,
        buttons: ['앱만 끄기', '셸까지 모두 끝내기', '취소'],
        defaultId: 0,
        cancelId: 2,
      })
      if (r.response === 2) return 'cancel'
      try {
        writeFileSync(noticeFile, new Date().toISOString(), { mode: 0o600 })
      } catch {
        // 다음에 한 번 더 보일 뿐
      }
      return r.response === 1 ? 'quit-all' : 'quit'
    },
    async quitAll(win, busy, confirm) {
      if (quittingAll) return false
      if (confirm && busy > 0) {
        const live = (await ptys.sessions().catch(() => [])).filter((s) => !s.exited).length
        const r = await askBox(win, {
          type: 'warning',
          message: `실행 중인 명령 ${busy}개를 끝낼까요?`,
          detail: `셸 ${live}개가 모두 끝나요. 폴더와 출력만 되살아나요.`,
          buttons: ['닫기', '모두 끝내기'],
          defaultId: 0,
          cancelId: 0,
        })
        if (r.response !== 1) return false
      }
      quittingAll = true
      // 셸이 끝나며 오는 exit 를 창에 넘기지 않는다 — 깨끗한 끝(exit 0)이면 renderer 가 pane 을 상태에서 지우고,
      // 아니면 '셸이 끝났습니다' 줄이 스크롤 저장본에 들어간다. 저장은 창이 닫힐 때(beforeunload) 지금 화면으로.
      ptys.clear()
      await host.shutdown()
      return true
    },
    async action(a) {
      switch (a) {
        case 'reconnect':
          return host.reconnect()
        case 'restart':
          ptys.clear()
          await host.restart()
          patch({ fresh: true })
          return reloadWindows()
        case 'replace-old': {
          for (const o of otherSockets()) await oneShot(o.path, [{ op: 'shutdown' }])
          return patch({ oldHost: null })
        }
        case 'open-log':
          if (existsSync(logFile)) void shell.openPath(logFile)
          return
        case 'quit-all':
          return // index.ts 가 창 · 실행 중 수를 알고 처리한다
      }
    },
    async tail(paneId, lines = 20) {
      if (!host.connected) return ''
      const r = await host.request({ op: 'tail', paneId, lines }).catch(() => null)
      return typeof r?.['text'] === 'string' ? r['text'] : ''
    },
    sessions: (clearUnseen) => ptys.sessions(clearUnseen),
    dispose: () => host.dispose(),
  }
}
