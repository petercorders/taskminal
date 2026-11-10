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
}

export interface Settings {
  statuses: Status[]
  groups: Group[]
  templates: Template[]
  fontSize: number
  /** null 이면 로그인 셸($SHELL) */
  shell: string | null
}

export interface AppState {
  version: 1
  tasks: Task[]
  activeTaskId: Id | null
  settings: Settings
}

export interface NewTaskInput {
  name: string
  cwd: string
  templateId: Id | null
  statusId: Id
  groupId: Id | null
  color: string | null
}

/** 렌더러 ↔ main 사이 컨텍스트 메뉴 항목 */
export type MenuItemSpec =
  | { type: 'separator' }
  | { id?: string; label: string; checked?: boolean; enabled?: boolean; submenu?: MenuItemSpec[] }

export type AppCommand =
  | 'new-task'
  | 'new-tab'
  | 'split-right'
  | 'split-down'
  | 'close-pane'
  | 'next-tab'
  | 'prev-tab'
  | 'next-pane'
  | 'prev-pane'
  | 'next-task'
  | 'prev-task'
  | 'clear'
  | 'font-bigger'
  | 'font-smaller'
  | 'font-reset'
  | 'settings'
  | `task-${number}`
