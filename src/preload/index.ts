import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type AppInfo, type LoadedState, type PtyExit, type ScrollbackEntry } from '../shared/ipc'
import type { TaskminalApi } from './api'

// renderer 에 여는 유일한 통로. ipcRenderer 자체나 채널 이름을 받는 함수는 열지 않는다.
// 이벤트 객체(sender 등)는 renderer 에 넘기지 않는다.
const subscribe = <A extends unknown[]>(channel: string, listener: (...args: A) => void): (() => void) => {
  const wrapped = (_event: IpcRendererEvent, ...args: unknown[]) => listener(...(args as A))
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

const api: TaskminalApi = {
  appInfo: () => ipcRenderer.invoke(IPC.appInfo) as Promise<AppInfo>,
  pickFolder: () => ipcRenderer.invoke(IPC.pickFolder) as Promise<string | null>,
  onCommand: (listener) => subscribe<[unknown]>(IPC.appCommand, listener),
  setQuitGuard: (busy) => ipcRenderer.send(IPC.quitGuard, busy),
  setBadge: (count) => ipcRenderer.send(IPC.badge, count),
  beep: () => ipcRenderer.send(IPC.beep),
  openLink: (url) => ipcRenderer.send(IPC.openLink, url),
  setMenuKeys: (keys) => ipcRenderer.send(IPC.menuKeys, keys),
  pty: {
    spawn: (paneId, opts) => ipcRenderer.invoke(IPC.ptySpawn, paneId, opts) as Promise<void>,
    write: (paneId, data) => ipcRenderer.send(IPC.ptyWrite, paneId, data),
    resize: (paneId, cols, rows) => ipcRenderer.send(IPC.ptyResize, paneId, cols, rows),
    kill: (paneId) => ipcRenderer.send(IPC.ptyKill, paneId),
    onData: (listener) => subscribe<[string, string]>(IPC.ptyData, listener),
    onExit: (listener) => subscribe<[string, PtyExit]>(IPC.ptyExit, listener),
    cwds: (paneIds) => ipcRenderer.invoke(IPC.ptyCwds, paneIds) as Promise<Record<string, string>>,
  },
  scrollback: {
    load: (paneId) => ipcRenderer.invoke(IPC.scrollbackLoad, paneId) as Promise<ScrollbackEntry | null>,
    save: (req) => ipcRenderer.send(IPC.scrollbackSave, req),
    saveNow: (req) => {
      ipcRenderer.sendSync(IPC.scrollbackSaveSync, req)
    },
  },
  state: {
    load: () => ipcRenderer.invoke(IPC.stateLoad) as Promise<LoadedState>,
    save: (state) => ipcRenderer.send(IPC.stateSave, state),
    onError: (listener) => subscribe<[string]>(IPC.stateError, listener),
  },
}

contextBridge.exposeInMainWorld('taskminal', api)
