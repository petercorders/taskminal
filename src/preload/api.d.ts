// renderer 가 보는 preload API 타입 (window.taskminal). 구현은 preload/index.ts.
import type { AppInfo, LoadedState, PtyExit, PtySpawnOptions } from '../shared/ipc'
import type { AppState } from '../shared/types'

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

export interface StateApi {
  load(): Promise<LoadedState>
  /** main 이 300ms 디바운스해 원자적으로 쓴다. 읽기 전용 파일이면 무시된다. */
  save(state: AppState): void
}

export interface TaskminalApi {
  appInfo(): Promise<AppInfo>
  pty: PtyApi
  state: StateApi
}

declare global {
  interface Window {
    taskminal: TaskminalApi
  }
}
