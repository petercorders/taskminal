// renderer 가 보는 preload API 타입 (window.taskminal). 구현은 preload/index.ts.
import type { BackupInfo } from '../shared/backup'
import type { AppInfo, BackupMark, HostAction, HostView, LoadedState, PtyAttachResult, PtyExit, PtySpawnOptions, RedactStatus, ScrollbackEntry, ScrollbackSave } from '../shared/ipc'
import type { SessionInfo } from '../shared/ptyhost'
import type { AppState } from '../shared/types'

export interface PtyApi {
  /**
   * 셸 지킴이에 이 pane 의 셸이 남아 있으면 다시 붙는다 — 화면 · 명령 상태가 onData 로 먼저 온 뒤 답한다(16단계).
   * attached:false 면 되살리기 · spawn 을 한다.
   */
  attach(paneId: string): Promise<PtyAttachResult>
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
  /** 저장 창 → 가린 상태 JSON 을 쓴다(17단계). 저장한 경로 · 취소면 null */
  exportTo(): Promise<string | null>
  /** 열기 창 → 검증한 상태. 취소면 null · 못 읽으면 예외 */
  importFrom(): Promise<{ name: string; state: AppState } | null>
}

/** 상태 백업 (17단계) */
export interface BackupApi {
  /** 새 것부터 */
  list(): Promise<BackupInfo[]>
  /** 검증한 상태 — 못 쓰는 백업이면 예외 */
  read(name: string): Promise<AppState>
  /** 되돌리기 · 가져오기 직전에 지금 모습을 백업한다 — 실패면 예외(되돌리지 않는다) */
  mark(what: BackupMark): Promise<boolean>
  /** 백업 실패 글(null = 다시 됨) */
  onError(listener: (message: string | null) => void): () => void
}

/** 이미 남은 스크롤 파일 정리 (17단계) */
export interface RedactApi {
  status(): Promise<RedactStatus>
  onStatus(listener: (status: RedactStatus) => void): () => void
  fix(action: 'retry' | 'delete', name: string): void
}

/** 셸 지킴이 (16단계) — 앱 밖에서 셸을 갖고 있는 프로세스 */
export interface HostApi {
  view(): Promise<HostView>
  /** 상태가 바뀔 때마다. 구독 해제 함수를 돌려준다 */
  onView(listener: (view: HostView) => void): () => void
  /** 지킴이의 모든 셸. clearUnseen: '꺼져 있던 동안 생긴 것' 을 받고 지운다(앱이 처음 읽힐 때 한 번) */
  sessions(clearUnseen?: boolean): Promise<SessionInfo[]>
  /** 그 셸의 마지막 20줄 */
  tail(paneId: string): Promise<string>
  /** 주인 없는 셸 끝내기 — 어느 창도 쓰지 않는 pane 만 main 이 끝낸다 */
  kill(paneIds: string[]): void
  action(action: HostAction): void
}

/** 자동 업데이트 (18단계) */
export interface UpdateApi {
  view(): Promise<import('../shared/update').UpdateView>
  onView(listener: (view: import('../shared/update').UpdateView) => void): () => void
  action(action: import('../shared/ipc').UpdateAction): void
}

/** 오류 기록 (18단계) — 이 Mac 에만 */
export interface ErrlogApi {
  /** 최근 7일, 같은 오류는 묶어서 · level 로 거르기 */
  list(level?: 'error' | 'warn'): Promise<import('../shared/errlog').LogRow[]>
  openFolder(): void
}

/** 명령 기록 (19단계) — <userData>/history, main 이 가려서 쓴다 */
export interface HistoryApi {
  list(): Promise<import('../shared/history').HistoryEntry[]>
  /** 끝난 명령 몇 줄(50개까지) — 쓴 줄 수. 쓰기에 실패하면 예외 */
  append(entries: import('../shared/history').HistoryEntry[]): Promise<number>
  remove(taskId: string, ids: string[]): void
  removeTask(taskId: string): void
  clear(): Promise<void>
}

/** 포트 감지 (20단계) */
export interface PortsApi {
  /** 이 창의 pane 셸 자손이 듣는 포트 — 실패면 { ok: false } */
  probe(paneIds: string[]): Promise<import('../shared/ports').ProbeResult>
  /** 그 pane 의 그 포트를 듣는 pid 에 SIGTERM — main 이 끄기 직전에 다시 조사해 같을 때만 */
  kill(paneId: string, port: number, pid: number): Promise<'killed' | 'gone' | 'failed'>
}

/** pane 의 대화 정보 — 에이전트 · 세션 · 아직 안 보낸 갈라질 자리 (22단계) */
export interface ChatRefT {
  agent: import('../shared/chat').ChatAgent
  sessionId?: string
  forkAt?: string
}

/** 대화 pane (21 · 22단계) — main 이 claude · codex 프로세스를 띄우고 이벤트를 가려서 보낸다 */
export interface ChatApi {
  /** 새 턴. 실행 중이면 'busy'(보내지 않음), 실행 파일이 없으면 'missing'. images 는 붙인 그림(메모리에만) */
  send(paneId: string, text: string, cwd: string, chat: ChatRefT, images?: import('../shared/chat').ChatImage[]): Promise<'ok' | 'busy' | 'missing'>
  /** 되감기 (22단계) — 그 메시지 앞까지. 자리가 바뀌었거나 도는 중이면 null */
  rewind(
    paneId: string,
    index: number,
    at: number,
    chat: ChatRefT,
  ): Promise<{ events: import('../shared/chat').ChatEvent[]; upTo: number; forkAt: string | null; sessionId?: string; refill: string | null; masked: boolean } | null>
  /** 나누기 (22단계) — 그 메시지의 턴까지를 새 pane 기록으로 */
  branch(fromPaneId: string, toPaneId: string, index: number, at: number): Promise<{ forkAt: string; sessionId?: string } | null>
  /** 📎 그림 고르기 — main 이 읽어 돌려준다. 크기 · 종류가 맞지 않으면 skipped */
  pickImages(): Promise<{ images: import('../shared/chat').ChatImage[]; skipped: string[] }>
  /** 허락 · 질문 답 — 같은 요청에 두 번이면 main 이 버린다 */
  answer(paneId: string, requestId: string, decision: import('../shared/chat').ChatDecision): void
  interrupt(paneId: string): void
  /** 재시작 · 새로 고침 뒤 다시 그릴 앞 대화 (가린 것) */
  history(paneId: string): Promise<{ events: import('../shared/chat').ChatEvent[]; upTo: number }>
  /** pane 을 닫았다 — 프로세스를 끝내고, forget 이면 화면 기록도 지운다 */
  close(paneId: string, forget: boolean): void
  /** (paneId, 이벤트) — 값은 renderer 가 isChatEvent 로 검사한다 */
  onEvent(listener: (paneId: unknown, ev: unknown, n: unknown) => void): () => void
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
  /** 폴더의 저장소 옆에 새 브랜치 worktree 를 만든다 (15f) */
  gitWorktreeAdd(dir: string, branch: string): Promise<import('../shared/worktree').WorktreeResult>
  /** 폴더마다 git 브랜치(저장소가 아니면 null) — `~` 는 main 이 푼다 */
  gitBranches(dirs: string[]): Promise<Record<string, string | null>>
  /** 터미널 링크를 바깥 브라우저로 — http(s) 가 아니면 main 이 무시 */
  openLink(url: string): void
  /** 바꾼 단축키 — 앱 메뉴의 표시를 맞춘다 */
  setMenuKeys(keys: Record<string, string>): void
  pty: PtyApi
  scrollback: ScrollbackApi
  state: StateApi
  host: HostApi
  backup: BackupApi
  redact: RedactApi
  update: UpdateApi
  errlog: ErrlogApi
  /** 첫 실행 안내를 끝냈다 — 다시 띄우지 않는다 */
  firstRunDone(): void
  history: HistoryApi
  ports: PortsApi
  chat: ChatApi
  review: ReviewApi
}

/** 23단계 변경 검토 — 일감 폴더의 저장소. 패치는 main 이 만든다 */
export interface ReviewApi {
  load(dir: string, base: string | null): Promise<import('../shared/review').ReviewLoad>
  /** 고른 줄(`덩어리:줄`)만 되돌린다 — sig 는 본 diff 의 fileSig. 그 사이 바뀌었으면 changed */
  revertLines(dir: string, path: string, sig: string, keys: string[]): Promise<import('../shared/review').RevertResult>
  revertFile(dir: string, path: string, sig: string): Promise<import('../shared/review').RevertResult>
  restore(id: string): Promise<import('../shared/review').RestoreResult>
  reverted(root: string): Promise<import('../shared/review').RevertedView[]>
  clearReverted(): Promise<void>
  commit(dir: string, paths: string[], message: string): Promise<import('../shared/review').CommitResult>
  undoCommit(dir: string, hash: string): Promise<import('../shared/review').UndoResult>
  /** 보이는 동안만 폴더 감시 — null 이면 끔 */
  watch(paneId: string, root: string | null): void
  onChanged(listener: (paneId: string) => void): () => void
  openFile(root: string, path: string): void
}

declare global {
  interface Window {
    taskminal: TaskminalApi
  }
}
