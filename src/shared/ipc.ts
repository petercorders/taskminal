import type { RendererMode } from './renderer'
import type { AppState } from './types'

// main · preload 가 함께 쓰는 IPC 채널 이름. renderer 는 채널을 모르고 preload API 만 부른다.
export const IPC = {
  appInfo: 'app:info',
  ptySpawn: 'pty:spawn', // invoke
  ptyWrite: 'pty:write', // send
  ptyResize: 'pty:resize', // send
  ptyKill: 'pty:kill', // send
  ptyData: 'pty:data', // main → renderer
  ptyExit: 'pty:exit', // main → renderer
  stateLoad: 'state:load', // invoke
  stateSave: 'state:save', // send (main 이 디바운스)
  stateError: 'state:error', // main → renderer: 저장 실패
  pickFolder: 'dialog:pick-folder', // invoke → 경로 또는 null
  appCommand: 'app:command', // main → renderer: 메뉴에서 고른 명령 (AppCommand)
  quitGuard: 'app:quit-guard', // send: 실행 중 명령 수 (끄기 전 확인이 꺼져 있으면 0)
  badge: 'app:badge', // send: Dock 배지 수 (0 = 지움)
  beep: 'app:beep', // send: 알림 소리만
  openLink: 'app:open-link', // send: 터미널 링크(⌘+클릭) — main 이 http(s) 만 바깥 브라우저로
  menuKeys: 'menu:keys', // send: 바꾼 단축키 (settings.keys) → 메뉴 표시를 다시 만든다
  scrollbackLoad: 'scrollback:load', // invoke(paneId) → { text, savedAt } | null
  scrollbackSave: 'scrollback:save', // send: 주기 저장 { live, panes }
  scrollbackSaveSync: 'scrollback:save-sync', // sendSync: 페이지가 내려갈 때(앱 종료 · 창 닫기 · 새로 고침) — main 이 다 쓴 뒤 돌아온다
  gitBranches: 'git:branches', // invoke(폴더[]) → { 폴더: 브랜치 | null } — 사이드바 일감 둘째 줄 (15c)
  gitWorktreeAdd: 'git:worktree-add', // invoke(폴더, 브랜치) → { ok, path } | { ok: false, error } — 새 일감을 worktree 에서 (15f)
  ptyCwds: 'pty:cwds', // invoke(paneId[]) → { paneId: 폴더 } — 셸 통합이 없는 셸의 폴더(lsof)
  ptyAttach: 'pty:attach', // invoke(paneId) → PtyAttachResult — 셸 지킴이에 남은 셸에 다시 붙기 (16단계)
  hostView: 'host:view', // invoke → HostView / main → renderer: 바뀔 때마다
  hostSessions: 'host:sessions', // invoke(clearUnseen) → SessionInfo[]
  hostTail: 'host:tail', // invoke(paneId) → 마지막 20줄
  hostKill: 'host:kill', // send(paneId[]) — 주인 없는 셸 끝내기
  hostAction: 'host:action', // send(HostAction)
  // 17단계 데이터 안전
  backupList: 'backup:list', // invoke → BackupInfo[]
  backupRead: 'backup:read', // invoke(이름) → AppState (검증한 것)
  backupMark: 'backup:mark', // invoke('restore' | 'import') → 지금 모습을 백업한 뒤 돌아온다 (실패면 예외)
  backupError: 'backup:error', // main → renderer: 백업 실패 글 | null(다시 됨)
  stateExport: 'state:export', // invoke → 저장한 경로 | null(취소)
  stateImport: 'state:import', // invoke → { name, state } | null(취소) · 못 읽으면 예외
  redactStatus: 'redact:status', // invoke → RedactStatus / main → renderer: 바뀔 때마다
  redactFix: 'redact:fix', // send('retry' | 'delete', 파일 이름)
  // 18단계 출시 기본기
  updateView: 'update:view', // invoke → UpdateView / main → renderer: 바뀔 때마다
  updateAction: 'update:action', // send(UpdateAction)
  errlogList: 'errlog:list', // invoke(level?) → LogRow[] (최근 7일, 묶은 것)
  errlogOpen: 'errlog:open', // send — 오류 기록 폴더를 Finder 로
  firstRunDone: 'app:first-run-done', // send — 첫 실행 안내를 끝냄(다시 띄우지 않게)
  // 19단계 명령 기록
  historyList: 'history:list', // invoke → HistoryEntry[] (90일 · 5,000개 넘은 것은 main 이 버림)
  historyAppend: 'history:append', // invoke(HistoryEntry[] ≤50) → 쓴 줄 수 · 실패면 예외(저장 실패 줄)
  historyRemove: 'history:remove', // send(taskId, id[]) — 지우기 토스트가 끝난 뒤
  historyRemoveTask: 'history:remove-task', // send(taskId) — 일감을 지울 때
  historyClear: 'history:clear', // invoke — 설정 › 개인정보 › 명령 기록 모두 지우기
  // 20단계 포트
  portsProbe: 'ports:probe', // invoke(paneId[]) → ProbeResult — 그 창의 pane 셸 자손이 듣는 포트
  portsKill: 'ports:kill', // invoke(paneId, port, pid) → 'killed' | 'gone' | 'failed' — main 이 다시 조사한 뒤 SIGTERM
  // 21단계 대화
  chatSend: 'chat:send', // invoke(paneId, text, cwd, chat{agent,sessionId?,forkAt?}, images[]) → 'ok' | 'busy' | 'missing'
  chatRewind: 'chat:rewind', // invoke(paneId, index, at, chat) → { events, upTo, forkAt, refill, masked } | null (22단계)
  chatBranch: 'chat:branch', // invoke(fromPaneId, toPaneId, index, at) → { forkAt } | null (22단계)
  chatPickImages: 'chat:pick-images', // invoke() → ChatImage[] — main 의 파일 고르기 (22단계)
  chatAnswer: 'chat:answer', // send(paneId, requestId, Decision)
  chatInterrupt: 'chat:interrupt', // send(paneId) — ⌘.
  chatHistory: 'chat:history', // invoke(paneId) → ChatEvent[] (가린 것, 화면 다시 그리기)
  chatClose: 'chat:close', // send(paneId, forget) — pane 을 닫음 · forget 이면 화면 기록도 지움
  chatEvent: 'chat:event', // main → renderer: (paneId, ChatEvent) 가린 것
} as const

export const UPDATE_ACTIONS = ['check', 'download', 'install', 'move'] as const
export type UpdateAction = (typeof UPDATE_ACTIONS)[number]
export const isUpdateAction = (v: unknown): v is UpdateAction => typeof v === 'string' && (UPDATE_ACTIONS as readonly string[]).includes(v)

/** 이미 남은 스크롤 파일 정리(17단계) 상태 */
export interface RedactStatus {
  state: 'idle' | 'running' | 'done'
  done: number
  total: number
  /** 가린 비밀값 수 */
  masked: number
  /** 못 읽은 파일 이름(<paneId>.txt) */
  failed: string[]
  finishedAt?: number
}

export const BACKUP_MARKS = ['restore', 'import'] as const
export type BackupMark = (typeof BACKUP_MARKS)[number]
export const isBackupMark = (v: unknown): v is BackupMark => typeof v === 'string' && (BACKUP_MARKS as readonly string[]).includes(v)
export const isRedactFix = (v: unknown): v is 'retry' | 'delete' => v === 'retry' || v === 'delete'

/** 셸 지킴이에 렌더러가 부탁하는 일 */
export const HOST_ACTIONS = ['reconnect', 'restart', 'quit-all', 'replace-old', 'open-log'] as const
export type HostAction = (typeof HOST_ACTIONS)[number]
export const isHostAction = (v: unknown): v is HostAction => typeof v === 'string' && (HOST_ACTIONS as readonly string[]).includes(v)

/** 셸 지킴이 상태 — 설정 칸 · 위 줄(배너)이 그린다 */
export interface HostView {
  state: 'starting' | 'connected' | 'reconnecting' | 'down'
  /** 다시 연결 중 몇 번째 / 모두 몇 번 */
  attempt?: number
  of?: number
  error?: string
  pid?: number
  version?: number
  startedAt?: number
  /** 이번 실행에서 지킴이를 새로 띄웠다 — 셸이 이어지지 않았다(재부팅 · 지킴이 충돌) */
  fresh?: boolean
  sockPath?: string
  /** 마지막으로 잰 지킴이 메모리 · 셸 수 */
  rss?: number
  sessions?: number
  /** 메모리 · 셸 수가 기준을 넘었다 (실행마다 한 번) */
  memoryWarning?: boolean
  /** 다른 버전 지킴이가 셸을 갖고 있다 */
  oldHost?: { version: number; sessions: number } | null
}

export interface PtyAttachResult {
  attached: boolean
  /** 앱(창)이 떨어져 있던 시간 */
  detachedMs?: number
}

export interface AppInfo {
  name: string
  version: string
  /** 설정에서 고를 수 있는 셸(/etc/shells) — 그 밖의 경로는 $SHELL 로 연다 */
  shells: string[]
  /** 이 Mac 이름 — OSC 7 의 호스트가 이것 · localhost · 빈 값일 때만 폴더로 받는다 */
  host: string
  /** 홈 폴더 — 셸이 알려 준 폴더를 일감 폴더 모양(~)으로 맞출 때 */
  home: string
  /** 셸 통합 없는 셸의 폴더를 lsof 로 묻는 주기 (시험은 TASKMINAL_CWD_POLL_MS 로 줄인다) */
  cwdPollMs: number
  /** 포트 조사 주기 (20단계, 시험은 TASKMINAL_PORT_POLL_MS 로 줄인다) */
  portPollMs: number
  /** 대화 → 터미널 전환(⇧⌘J)에서 칠 명령 이름 — 보통 'claude', e2e 는 TASKMINAL_CLAUDE_TUI 로 가짜 경로(로그인 셸 PATH 가 진짜 claude 를 먼저 찾는다) */
  claudeTui: string
  /** 같은 것 — codex (22단계, TASKMINAL_CODEX_TUI) */
  codexTui: string
  /** 터미널 그리기 — 보이는 pane 은 WebGL(기본), 시험은 TASKMINAL_RENDERER=dom 으로 DOM (15e) */
  renderer: RendererMode
  /** 지난번 실행이 정상으로 끝나지 않았다(18단계 — running 표시 파일) */
  crashedLast: boolean
}

export interface ScrollbackEntry {
  text: string
  /** 저장한 시각 (ms) — '이전 세션' 줄에 보인다 */
  savedAt: number
}

export interface ScrollbackSave {
  /** 상태에 있는 모든 pane id — main 이 이 밖의 파일을 지운다 */
  live: string[]
  /** 이번에 바뀐 pane 의 글 */
  panes: Record<string, string>
}

export interface PtySpawnOptions {
  cwd: string
  cols: number
  rows: number
  /** 설정의 셸 경로 (null = 로그인 셸). main 이 /etc/shells 에 있는 것만 받는다 */
  shell?: string | null
  /** 셸 통합(zsh) — 끄면 사용자 설정만 읽는다 */
  integration?: boolean
}

export interface PtyExit {
  exitCode: number
  signal: number | null
}

export interface LoadedState {
  state: AppState
  /** 더 새 버전 앱이 만든 파일 — 이 앱은 그 파일을 절대 쓰지 않는다 */
  readOnly: boolean
  /**
   * corrupt: JSON 이 아니라 옮겨 둠(백업 없음 → 빈 상태) · recovered: 옮겨 두고 마지막 정상 백업으로 시작 ·
   * repaired: 검증이 일부를 버려 원본을 복사해 둠 · newer: 모르는 형식이라 읽기 전용
   */
  notice: null | 'corrupt' | 'recovered' | 'repaired' | 'newer'
  /** recovered: 되살린 백업의 시각 */
  recoveredAt?: number
  /** 처음 실행 — state.json 이 없었고 첫 실행 안내를 아직 끝내지 않았다 (18단계) */
  firstRun?: boolean
}
