// renderer 가 보는 preload API 타입 (window.taskminal). 구현은 preload/index.ts.
import type { AppInfo } from '../shared/ipc'

export interface TaskminalApi {
  appInfo(): Promise<AppInfo>
}

declare global {
  interface Window {
    taskminal: TaskminalApi
  }
}
