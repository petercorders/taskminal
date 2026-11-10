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
  /** 저장 실패(디스크 가득 · 권한) 알림. 구독 해제 함수를 돌려준다. */
  onError(listener: (message: string) => void): () => void
}

export interface TaskminalApi {
  appInfo(): Promise<AppInfo>
  /** macOS 폴더 선택 대화상자. 취소하면 null */
  pickFolder(): Promise<string | null>
  /** 앱 메뉴에서 고른 명령. 값은 renderer 가 isAppCommand 로 검사한다. 구독 해제 함수를 돌려준다. */
  onCommand(listener: (command: unknown) => void): () => void
  pty: PtyApi
  state: StateApi
}

declare global {
  interface Window {
    taskminal: TaskminalApi
  }
}
