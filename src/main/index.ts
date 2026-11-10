import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { IPC, type AppInfo } from '../shared/ipc'
import { normalizeState } from '../shared/model'
import { Debouncer } from '../shared/persist'
import { isPaneId, validSize, validWrite } from '../shared/pty'
import type { AppState } from '../shared/types'
import { installAppMenu } from './menu'
import { PtyManager } from './pty-manager'
import { StateFile } from './state-file'

// e2e 는 임시 폴더를 넘긴다 — 실제 ~/Library/Application Support/Taskminal 을 건드리지 않게. ready 전에 정해야 한다.
const userDataOverride = process.env['TASKMINAL_USER_DATA']
if (userDataOverride) app.setPath('userData', userDataOverride)

const devServerUrl = process.env['ELECTRON_RENDERER_URL']
const rendererFile = join(__dirname, '../renderer/index.html')

let mainWindow: BrowserWindow | null = null
const ptys = new PtyManager()

const MAX_STATE_BYTES = 5 * 1024 * 1024
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

  // 셸 정리 — 종료 경로 4개 중 창에 딸린 3개 (앱 종료는 will-quit).
  const wc = win.webContents
  wc.on('destroyed', () => ptys.killOwner(wc)) // ① 창 닫기
  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) ptys.killOwner(wc) // ② 새로 고침 — 새 페이지가 다시 띄운다
  })
  wc.on('render-process-gone', () => ptys.killOwner(wc)) // ③ 렌더러 충돌

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
    return { name: app.getName(), version: app.getVersion() }
  })

  ipcMain.handle(IPC.ptySpawn, (event, paneId: unknown, opts: unknown) => {
    if (!fromOurWindow(event)) throw new Error('알 수 없는 프레임의 요청')
    const o = (opts ?? {}) as Record<string, unknown>
    if (!isPaneId(paneId) || typeof o['cwd'] !== 'string' || !validSize(o['cols'], o['rows'])) {
      throw new Error('잘못된 pty 인자')
    }
    ptys.spawn(event.sender, paneId, { cwd: o['cwd'], cols: o['cols'] as number, rows: o['rows'] as number })
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

  ipcMain.handle(IPC.pickFolder, async (event): Promise<string | null> => {
    if (!fromOurWindow(event)) throw new Error('알 수 없는 프레임의 요청')
    const win = BrowserWindow.fromWebContents(event.sender)
    const options = { title: '작업 폴더 선택', properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'> }
    const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return r.canceled ? null : (r.filePaths[0] ?? null)
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
