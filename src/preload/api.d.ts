// renderer 가 보는 preload API 타입 (window.taskminal). 구현은 preload/index.ts.
import type { AppInfo, PtyExit, PtySpawnOptions } from '../shared/ipc'

export interface PtyApi {
  /** 같은 paneId 의 셸이 이미 있으면 새로 만들지 않는다. */
  spawn(paneId: string, opts: PtySpawnOptions): Promise<void>
  write(paneId: string, data: string): void
  resize(paneId: string, cols: number, rows: number): void
  kill(paneId: string): void
  /** 구독 해제 함수를 돌려준다. */
  onData(listener: (paneId: string, data: string) => void): () => void
  onExit(listener: (paneId: string, exit: PtyExit) => void): () => void
}

export interface TaskminalApi {
  appInfo(): Promise<AppInfo>
  pty: PtyApi
}

declare global {
  interface Window {
    taskminal: TaskminalApi
  }
}
