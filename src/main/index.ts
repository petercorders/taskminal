import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { IPC, type AppInfo } from '../shared/ipc'
import { normalizeState } from '../shared/model'
import { Debouncer } from '../shared/persist'
import { isAccel, isAppCommand } from '../shared/keymap'
import { isPaneId, validSize, validWrite } from '../shared/pty'
import type { AppState } from '../shared/types'
import { installAppMenu } from './menu'
import { lsofCwds } from './cwd-probe'
import { PtyManager } from './pty-manager'
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
const ptys = new PtyManager(zshIntegrationDir, allowedShells)

// renderer 가 알려 주는 값: 실행 중 명령 수(끄기 전 확인이 꺼져 있으면 0) — renderer 가 사라지면 0
let busyCommands = 0
let quitConfirmed = false
let asking = false
const setBadge = (n: number) => app.dock?.setBadge(n > 0 ? String(n) : '')

/** 실행 중인 명령이 있으면 끄기 · 닫기 전에 묻는다. true = 그대로 진행 */
async function confirmEnd(win: BrowserWindow | null, what: '끝내기' | '닫기'): Promise<boolean> {
  const options = {
    type: 'warning' as const,
    message: `명령 ${busyCommands}개가 실행 중입니다`,
    detail: what === '끝내기' ? '끝내면 모든 터미널이 함께 종료됩니다.' : '창을 닫으면 모든 터미널이 함께 종료됩니다.',
    buttons: [what, '취소'],
    defaultId: 1,
    cancelId: 1,
  }
  // 창에 붙는 시트라 창이 숨었거나(⌘H) 최소화돼 있으면 보이지 않는다 → 먼저 보여 준다
  if (win && !win.isDestroyed() && (!win.isVisible() || win.isMinimized())) win.show()
  const r = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
  return r.response === 0
}

const MAX_STATE_BYTES = 5 * 1024 * 1024
// 스크롤 저장 — userData 가 정해진 뒤(ready 이후 첫 요청) 만든다
let scrollbackStore: ScrollbackStore | null = null
const scrollback = () => (scrollbackStore ??= new ScrollbackStore(join(app.getPath('userData'), 'scrollback')))
const MAX_LIVE_PANES = 2000
const cwdPollMs = ((): number => {
  const v = Number(process.env['TASKMINAL_CWD_POLL_MS'])
  return Number.isInteger(v) && v >= 100 ? v : 15_000
})()
let stateFile: StateFile | null = null // userData 경로가 정해진 뒤(ready) 만든다
// 디바운스가 main 에 있어서 창 닫기 · 새로 고침 · 렌더러 충돌 뒤에도 이미 받은 값은 타이머가 쓴다.
const stateWriter = new Debouncer<AppState>(
  (state) => {
    const error = stateFile?.trySave(state) ?? null
    if (!error) return
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

const openExternalIfWeb = (url: string): void => {
  try {
    const { protocol } = new URL(url)
    if (protocol === 'http:' || protocol === 'https:') void shell.openExternal(url)
  } catch {
    // 주소가 아니면 무시
  }
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
  // 창 닫기(⇧⌘W · 빨간 단추)도 셸을 모두 끝낸다 → 실행 중이면 묻는다. 끝내기 중(이미 물음)이면 묻지 않는다.
  let closeConfirmed = false
  win.on('close', (event) => {
    if (closeConfirmed || quitConfirmed || busyCommands === 0) return
    event.preventDefault()
    if (asking) return
    asking = true
    void confirmEnd(win, '닫기')
      .then((ok) => {
        if (!ok || win.isDestroyed()) return
        closeConfirmed = true
        win.close()
      })
      .finally(() => (asking = false))
  })

  // 셸 정리 — 종료 경로 4개 중 창에 딸린 3개 (앱 종료는 will-quit).
  const wc = win.webContents
  // renderer 가 사라지면(창 닫기 · 새로 고침 · 충돌) 그 renderer 가 알려 준 수도 버린다 — 새 페이지가 다시 보낸다
  const forget = () => {
    busyCommands = 0
    setBadge(0)
  }
  const endOwner = () => {
    ptys.killOwner(wc)
    forget()
  }
  wc.on('destroyed', endOwner) // ① 창 닫기
  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) endOwner() // ② 새로 고침 — 새 페이지가 다시 띄운다(수 · 배지도 다시 보낸다)
  })
  wc.on('render-process-gone', endOwner) // ③ 렌더러 충돌

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
    return { name: app.getName(), version: app.getVersion(), shells: allowedShells, host: hostname(), home: homedir(), cwdPollMs }
  })

  ipcMain.handle(IPC.ptySpawn, (event, paneId: unknown, opts: unknown) => {
    if (!fromOurWindow(event)) throw new Error('알 수 없는 프레임의 요청')
    const o = (opts ?? {}) as Record<string, unknown>
    if (!isPaneId(paneId) || typeof o['cwd'] !== 'string' || !validSize(o['cols'], o['rows'])) {
      throw new Error('잘못된 pty 인자')
    }
    ptys.spawn(event.sender, paneId, {
      cwd: o['cwd'],
      cols: o['cols'] as number,
      rows: o['rows'] as number,
      shell: typeof o['shell'] === 'string' ? o['shell'] : null, // 경로 검사는 PtyManager(pickShell)
      integration: o['integration'] !== false,
    })
  })
  // 고빈도 입력은 send(응답 없음). 틀린 인자는 조용히 버린다.
  ipcMain.on(IPC.ptyWrite, (event, paneId: unknown, data: unknown) => {
    if (fromOurWindow(event) && isPaneId(paneId) && validWrite(data)) ptys.write(event.sender, paneId, data)
  })
  ipcMain.on(IPC.ptyResize, (event, paneId: unknown, cols: unknown, rows: unknown) => {
    if (fromOurWindow(event) && isPaneId(paneId) && validSize(cols, rows)) {
      ptys.resize(event.sender, paneId, cols as number, rows as number)
    }
  })
  ipcMain.on(IPC.ptyKill, (event, paneId: unknown) => {
    if (fromOurWindow(event) && isPaneId(paneId)) ptys.kill(event.sender, paneId)
  })

  ipcMain.handle(IPC.stateLoad, (event) => {
    if (!fromOurWindow(event)) throw new Error('알 수 없는 프레임의 요청')
    stateWriter.flush() // 새로 고침 직전에 받은 값을 먼저 쓰고 읽는다
    const file = new StateFile(app.getPath('userData'), randomUUID)
    const loaded = file.load() // 실패(EACCES 등)하면 저장 대상은 그대로 두고 renderer 에 예외로 알린다
    stateFile = file
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
    stateWriter.push(normalizeState(raw, randomUUID))
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
  // 저장이 겹치지 않게 한 줄로 — 주기 저장(비동기)이 도는 중에 다음 저장이 와도 차례로
  let saving: Promise<unknown> = Promise.resolve()
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
  ipcMain.handle(IPC.ptyCwds, async (event, paneIds: unknown): Promise<Record<string, string>> => {
    if (!fromOurWindow(event)) throw new Error('알 수 없는 프레임의 요청')
    if (!Array.isArray(paneIds) || paneIds.length > MAX_LIVE_PANES) return {}
    const pids = ptys.pids(event.sender, paneIds.filter(isPaneId))
    const cwds = await lsofCwds(Object.values(pids))
    const out: Record<string, string> = {}
    for (const [paneId, pid] of Object.entries(pids)) if (cwds[pid]) out[paneId] = cwds[pid]
    return out
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
  ipcMain.on(IPC.menuKeys, (event, keys: unknown) => {
    if (!fromOurWindow(event) || typeof keys !== 'object' || keys === null) return
    const safe: Record<string, string> = {}
    for (const [command, accel] of Object.entries(keys)) if (isAppCommand(command) && isAccel(accel)) safe[command] = accel
    installAppMenu(safe)
  })

  // ⌘Q · Dock 의 끝내기: 실행 중인 명령이 있으면 묻는다 (설정 '끄기 전에 묻기'가 꺼져 있으면 renderer 가 0 을 보낸다)
  app.on('before-quit', (event) => {
    if (quitConfirmed || busyCommands === 0) return
    event.preventDefault()
    if (asking) return
    asking = true
    void confirmEnd(mainWindow, '끝내기')
      .then((ok) => {
        if (!ok) return
        quitConfirmed = true
        app.quit()
      })
      .finally(() => (asking = false))
  })

  // ④ 앱 종료 — 남은 셸을 모두 끝낸다. 이 줄이 없어도 main 이 끝나면 pty 가 닫혀 커널이 셸에 SIGHUP 을 보낸다
  // (변이 확인으로 확인: e2e ① 은 이 줄 없이도 통과). 13단계의 종료 전 저장이 이 순서에 붙는다.
  app.on('will-quit', () => {
    try {
      stateWriter.flush() // 디바운스 중인 마지막 상태를 동기로 쓴다
    } finally {
      ptys.killAll() // 저장이 실패해도 셸 정리는 한다
    }
  })

  void app.whenReady().then(() => {
    installAppMenu()
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
