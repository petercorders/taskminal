import { app, BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { IPC, type AppInfo } from '../shared/ipc'

// e2e 는 임시 폴더를 넘긴다 — 실제 ~/Library/Application Support/Taskminal 을 건드리지 않게. ready 전에 정해야 한다.
const userDataOverride = process.env['TASKMINAL_USER_DATA']
if (userDataOverride) app.setPath('userData', userDataOverride)

const devServerUrl = process.env['ELECTRON_RENDERER_URL']
const rendererFile = join(__dirname, '../renderer/index.html')

let mainWindow: BrowserWindow | null = null

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

  if (devServerUrl) void win.loadURL(devServerUrl)
  else void win.loadFile(rendererFile)
  return win
}

// 우리 창의 맨 위 프레임에서 온 요청만 받는다.
const fromOurWindow = (event: IpcMainInvokeEvent): boolean =>
  mainWindow !== null && event.senderFrame === mainWindow.webContents.mainFrame

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  ipcMain.handle(IPC.appInfo, (event): AppInfo => {
    if (!fromOurWindow(event)) throw new Error('알 수 없는 프레임의 요청')
    return { name: app.getName(), version: app.getVersion() }
  })

  void app.whenReady().then(() => {
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
