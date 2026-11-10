// renderer 가 보는 preload API 타입 (window.taskminal). 구현은 preload/index.ts.
import type { AppInfo, LoadedState, PtyExit, PtySpawnOptions, ScrollbackEntry, ScrollbackSave } from '../shared/ipc'
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
  /** 셸 통합이 없는 셸의 작업 폴더(lsof) — 이 창의 pane 만, 모르면 빠진다 */
  cwds(paneIds: string[]): Promise<Record<string, string>>
}

export interface ScrollbackApi {
  /** 저장해 둔 이전 출력 (없거나 못 읽으면 null) */
  load(paneId: string): Promise<ScrollbackEntry | null>
  /** 주기 저장 — 바뀐 pane 만. live 밖의 파일은 main 이 지운다 */
  save(req: ScrollbackSave): void
  /** 페이지가 내려갈 때 — main 이 다 쓴 뒤 돌아온다(동기) */
  saveNow(req: ScrollbackSave): void
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
  /** 실행 중인 명령 수 — 0 이 아니면 main 이 앱 끝내기 · 창 닫기 전에 묻는다. 끄기 전 확인이 꺼져 있으면 0 을 보낸다 */
  setQuitGuard(busy: number): void
  /** Dock 배지 수 (0 = 지움) */
  setBadge(count: number): void
  /** 알림 소리만 (macOS 알림 없이) */
  beep(): void
  /** 폴더마다 git 브랜치(저장소가 아니면 null) — `~` 는 main 이 푼다 */
  gitBranches(dirs: string[]): Promise<Record<string, string | null>>
  /** 터미널 링크를 바깥 브라우저로 — http(s) 가 아니면 main 이 무시 */
  openLink(url: string): void
  /** 바꾼 단축키 — 앱 메뉴의 표시를 맞춘다 */
  setMenuKeys(keys: Record<string, string>): void
  pty: PtyApi
  scrollback: ScrollbackApi
  state: StateApi
}

declare global {
  interface Window {
    taskminal: TaskminalApi
  }
}
