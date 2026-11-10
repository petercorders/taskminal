import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type AppInfo } from '../shared/ipc'
import type { TaskminalApi } from './api'

// renderer 에 여는 유일한 통로. ipcRenderer 자체나 채널 이름을 받는 함수는 열지 않는다.
const api: TaskminalApi = {
  appInfo: () => ipcRenderer.invoke(IPC.appInfo) as Promise<AppInfo>,
}

contextBridge.exposeInMainWorld('taskminal', api)
