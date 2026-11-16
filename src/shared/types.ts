import type { ChatAgent, ChatPermission } from './chat'
import type { QuickCommand } from './quick'

export type Id = string

/** 사용자가 정의하는 일감 상태 (예: 진행 중 · 대기 · 완료) */
export interface Status {
  id: Id
  name: string
  color: string
}

/** 사이드바에서 일감을 묶는 단위 (예: 찍계부 · 서버 · 개인) */
export interface Group {
  id: Id
  name: string
  /** 사이드바에서 접어 둠 */
  collapsed?: boolean
}

/** 템플릿 안의 터미널 하나 */
export interface PaneSpec {
  /** 셸이 뜬 뒤 한 번 입력할 명령 (예: "claude", "flutter run") */
  command?: string
  /** 일감 폴더 기준 상대 경로 또는 절대 경로 */
  cwd?: string
}

export type LayoutSpec =
  | { pane: PaneSpec }
  | { split: SplitDir; ratio?: number; a: LayoutSpec; b: LayoutSpec }

export interface TemplateTab {
  title?: string
  layout: LayoutSpec
}

export interface Template {
  id: Id
  name: string
  tabs: TemplateTab[]
  /** 빠른 명령 (20단계) — 이 템플릿으로 만든 일감에 복사된다(▤) */
  quickCommands?: QuickCommand[]
}

/** right = 좌우로 나눔, down = 위아래로 나눔 */
export type SplitDir = 'right' | 'down'

export type Layout =
  | { type: 'pane'; paneId: Id }
  | { type: 'split'; dir: SplitDir; ratio: number; a: Layout; b: Layout }

export interface Pane {
  id: Id
  /** 마지막으로 알려진 작업 폴더 (복원할 때 여기서 셸을 연다) */
  cwd: string
  /** 아직 보내지 않은 시작 명령. 보낸 뒤에는 지운다 → 복원 때 다시 돌지 않는다 */
  pendingCommand?: string
  /** 템플릿으로 저장할 때 쓰는 원래 시작 명령 */
  command?: string
  /** pendingCommand 를 실행하지 않고 입력줄에 넣기만 (19단계 — 기록의 위험 명령) */
  pendingInsert?: true
  /** pane 종류 — 없으면 터미널. '대화' 는 셸 대신 에이전트와 채팅 (21단계) · '변경' 은 일감 폴더 저장소의 diff · 커밋 (23단계) */
  kind?: 'chat' | 'review'
  /** 작업 흐름 전용 대화: 일반 전송/되감기는 금지, 허락·질문 답은 유지 */
  workflowRunId?: string
  /** 대화 pane 의 에이전트 · 이어 할 세션 (Claude session_id · Codex thread id) · forkAt: 되감기 · 나누기 뒤 아직 안 보냄 — 다음 띄울 때 여기서 가른다 (22단계) */
  chat?: { agent: ChatAgent; sessionId?: string; forkAt?: string }
}

export interface Tab {
  id: Id
  title?: string
  layout: Layout
  activePaneId: Id
}

/** 일감: 관련된 터미널 세션 묶음 */
export interface Task {
  id: Id
  name: string
  cwd: string
  statusId: Id
  groupId: Id | null
  color: string | null
  tabs: Tab[]
  activeTabId: Id | null
  panes: Record<Id, Pane>
  createdAt: number
  /** 빠른 명령 (20단계) — 단추 줄 · ⌥1~9 */
  quickCommands?: QuickCommand[]
  /** 일감 메모 · 할 일 (24단계) — 사람은 더하기 · 체크 · 지우기, 에이전트(taskminal task note)는 덧붙이기만 */
  notes?: Note[]
  /** 이 일감을 마지막으로 본 때 (24단계 이어받기 요약) */
  lastViewedAt?: number
  /** 보관한 때 (25단계) — 셸은 끄고 탭 · 폴더 · 메모 · 명령 기록은 남김. 사이드바 · ⌘P 기본 목록에서 빠진다 */
  archivedAt?: number
  /** 원격 일감의 ssh 호스트 (25단계) — ~/.ssh/config 의 Host 이름이나 user@host. 있으면 cwd · pane cwd 는 그 호스트의 경로 */
  host?: string
  /** 원격 일감에서 서버의 tmux 로 '끊겨도 계속 돌게' (25단계, 기본 켬) */
  remoteTmux?: boolean
}

export interface Note {
  id: Id
  text: string
  done?: true
  /** 에이전트가 남김 (taskminal task note) */
  by?: 'agent'
  at: number
}

export type StartupMode = 'restore' | 'list' | 'blank'
export type Theme = 'dark' | 'light' | 'system'
export type CursorStyle = 'bar' | 'block' | 'underline'
export type SidebarDensity = 'two' | 'one'
/** 알릴 일: 입력 기다림 · 오래 걸린 명령 끝 · 명령 실패 · 셸 닫힘 */
export type NotifyKind = 'wait' | 'long' | 'fail' | 'exit'
export interface NotifyWay {
  /** macOS 알림 */
  banner: boolean
  sound: boolean
}

export interface Settings {
  statuses: Status[]
  groups: Group[]
  templates: Template[]
  fontSize: number
  /** null 이면 로그인 셸($SHELL) */
  shell: string | null
  // 일반
  startup: StartupMode
  /** 새 일감 기본 폴더. '' 이면 마지막에 만든 일감의 폴더 */
  defaultCwd: string
  defaultTemplateId: Id | null
  /** 실행 중인 명령이 있으면 끄기 전에 묻기 */
  confirmQuit: boolean
  /** Dock 아이콘에 확인 필요 일감 수 */
  dockBadge: boolean
  // 모양
  theme: Theme
  accent: string
  fontFamily: string
  lineHeight: number
  /** 포커스 아닌 분할 pane 의 밝기 (1 = 흐리지 않음) */
  dimOpacity: number
  sidebarDensity: SidebarDensity
  // 터미널
  shellIntegration: boolean
  /** 다시 열 때 이전 출력을 보여 주기 (pane 마다 디스크에 저장) */
  restoreScrollback: boolean
  scrollback: number
  cursorStyle: CursorStyle
  cursorBlink: boolean
  optionAsMeta: boolean
  copyOnSelect: boolean
  // 알림 · 활동
  notify: Record<NotifyKind, NotifyWay>
  /** '오래 걸린 명령' 기준 (초) */
  longAfterSec: number
  /** 앱이 앞에 있고 그 pane 을 보고 있으면 알리지 않기 */
  muteViewed: boolean
  // 단축키: 명령 → 바꾼 키(accel). '' 은 키 없음. 없는 명령은 기본 키
  keys: Record<string, string>
  // 개인정보 (17단계) — 디스크 가리기는 끌 수 없다
  /** 화면에서 비밀값 가리기 */
  maskScreen: boolean
  /** 화면에 가리지 않을 종류 (shared/redact SecretToggleId) */
  maskKindsOff: string[]
  /** 내 종류 */
  secretCustom: Array<{ name: string; pattern: string }>
  /** '비밀값 아님' 으로 고른 값 — 원문이 아니라 해시만 */
  secretAllow: SecretAllow[]
  // 업데이트 (18단계)
  /** 새 버전을 뒤에서 내려받아 두고 묻기 (끄면 확인만) */
  updateDownload: boolean
  /** '이 버전 건너뛰기' 로 고른 버전 ('' = 없음) */
  updateSkip: string
  // 매일 쓰는 작은 것 (20단계)
  /** 모든 일감에 있는 빠른 명령 (◎) */
  quickCommands: QuickCommand[]
  /** 숨긴 포트 — 칩 · ⌘P 에 보이지 않는다 */
  hiddenPorts: number[]
  /** '서버가 떴어요 · 눌러서 열어요' 를 이미 보였다 (처음 한 번만) */
  portTipSeen: boolean
  // 21단계
  /** 대화 허락 방식 — 처음 'ask'(매번 묻기), 바꾸면 유지 */
  chatPermission: ChatPermission
  /** 26단계: 새 일감의 시작 — 대화(Claude · Codex) 또는 터미널. 기본 Claude 대화 */
  newTaskStart: NewTaskStart
  /** 사이드바 보기 — 흐름(상태별 칸, 기본) · 묶음 */
  sidebarView: 'flow' | 'group'
  /** 흐름 보기에서 접은 칸 (상태 id · 'need') — 처음은 마지막 상태(완료)만 */
  sidebarClosed: string[]
  // 24단계 이어받기 요약
  /** 오래 안 본 일감을 열면 요약 카드 */
  resumeCard: boolean
  /** 본 지 몇 분 뒤부터 (RESUME_AFTER_CHOICES) */
  resumeAfterMin: number
  /** '30분 넘게 안 본 일감이라 …' 처음 한 번 */
  resumeTipSeen: boolean
}

export interface SecretAllow {
  hash: string
  kind: string
  /** 고른 곳(일감 이름) */
  where: string
  at: number
}

export interface AppState {
  version: 1
  tasks: Task[]
  activeTaskId: Id | null
  settings: Settings
}

/** 새 일감의 첫 칸 (26단계) */
export type NewTaskStart = 'chat-claude' | 'chat-codex' | 'terminal'

export interface NewTaskInput {
  name: string
  cwd: string
  templateId: Id | null
  statusId: Id
  groupId: Id | null
  color: string | null
  /** 원격 일감 (25단계) — cwd 는 그 호스트의 경로 */
  host?: string
  /** 서버의 tmux 로 이어 붙기 — 기본 켬 */
  remoteTmux?: boolean
  /** 26단계: 첫 칸 — 없으면 터미널(CLI · 옛 호출). 템플릿 · 원격이면 보지 않는다 */
  start?: NewTaskStart
}

/** 렌더러 ↔ main 사이 컨텍스트 메뉴 항목 */
export type MenuItemSpec =
  | { type: 'separator' }
  | { id?: string; label: string; checked?: boolean; enabled?: boolean; submenu?: MenuItemSpec[] }
