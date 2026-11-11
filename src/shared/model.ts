import { FONT_DEFAULT, FONT_MAX, FONT_MIN } from './keymap'
import { isObj } from './guards'
import { parseQuickList, removeQuick, restoreQuick, upsertQuick, type QuickCommand } from './quick'
import { defaultExtraSettings, parseExtraSettings } from './settings'
import { clampRatio, cyclePane, hasPane, paneIds, removePane, setRatioAt, splitPane, type SplitPath } from './layout'
import type {
  AppState,
  Group,
  Id,
  Layout,
  LayoutSpec,
  NewTaskInput,
  Pane,
  PaneSpec,
  Settings,
  SplitDir,
  Status,
  Tab,
  Task,
  Template,
  TemplateTab,
} from './types'

/** id 를 만드는 함수. 시험에서는 순서가 정해진 함수를 넣는다. */
export type NewId = () => Id

// ─── 기본값 ────────────────────────────────────────────────

export function defaultSettings(): Settings {
  return {
    statuses: [
      { id: 'doing', name: '진행 중', color: '#79b8ff' },
      { id: 'wait', name: '대기', color: '#e5b567' },
      { id: 'done', name: '완료', color: '#8b9097' },
    ],
    groups: [],
    templates: [
      { id: 'tpl-basic', name: '기본', tabs: [{ layout: { pane: {} } }] },
      {
        id: 'tpl-claude',
        name: 'Claude + 셸',
        tabs: [{ layout: { split: 'right', ratio: 0.6, a: { pane: { command: 'claude' } }, b: { pane: {} } } }],
      },
      {
        id: 'tpl-dev',
        name: '개발 서버 + 셸',
        tabs: [{ title: '서버', layout: { split: 'down', ratio: 0.7, a: { pane: { command: 'npm run dev' } }, b: { pane: {} } } }],
      },
    ],
    fontSize: FONT_DEFAULT,
    shell: null,
    ...defaultExtraSettings(),
  }
}

export function emptyState(): AppState {
  return { version: 1, tasks: [], activeTaskId: null, settings: defaultSettings() }
}

// ─── 경로 (node:path 없이 — shared 는 renderer 에서도 쓴다) ───────────

function normalizePath(path: string): string {
  const prefix = path.startsWith('/') ? '/' : path === '~' || path.startsWith('~/') ? '~' : ''
  const rest = prefix === '~' ? path.slice(1) : path
  const parts: string[] = []
  for (const seg of rest.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (parts.length && parts[parts.length - 1] !== '..') parts.pop()
      else if (prefix !== '/') parts.push('..')
      continue
    }
    parts.push(seg)
  }
  if (prefix === '/') return '/' + parts.join('/')
  if (prefix === '~') return parts.length ? '~/' + parts.join('/') : '~'
  return parts.join('/') || '.'
}

/** 일감 폴더(base) 기준으로 pane 폴더를 푼다. rel 이 없으면 base, 절대 경로 · ~ 는 그대로. */
export function resolveCwd(base: string, rel?: string): string {
  if (!rel) return normalizePath(base)
  if (rel.startsWith('/') || rel === '~' || rel.startsWith('~/')) return normalizePath(rel)
  return normalizePath(`${base}/${rel}`)
}

/** resolveCwd 의 반대: base 안이면 상대 경로, 같으면 undefined, 밖이면 그대로. */
function relativeTo(base: string, path: string): string | undefined {
  const b = normalizePath(base)
  const p = normalizePath(path)
  if (p === b) return undefined
  const root = b.endsWith('/') ? b : b + '/'
  if (!p.startsWith(root)) return p
  const rel = p.slice(root.length)
  // '~' 라는 진짜 폴더가 resolveCwd 에서 홈 폴더로 읽히지 않게
  return rel === '~' || rel.startsWith('~/') ? './' + rel : rel
}

// ─── 일감 만들기 · 템플릿 ───────────────────────────────────

function makePane(id: Id, cwd: string, command?: string): Pane {
  return command ? { id, cwd, command, pendingCommand: command } : { id, cwd }
}

function expandSpec(spec: LayoutSpec, taskCwd: string, newId: NewId, panes: Record<Id, Pane>): Layout {
  if ('pane' in spec) {
    const id = newId()
    panes[id] = makePane(id, resolveCwd(taskCwd, spec.pane.cwd), spec.pane.command)
    return { type: 'pane', paneId: id }
  }
  const a = expandSpec(spec.a, taskCwd, newId, panes)
  const b = expandSpec(spec.b, taskCwd, newId, panes)
  return { type: 'split', dir: spec.split, ratio: clampRatio(spec.ratio ?? 0.5), a, b }
}

function expandTab(tt: TemplateTab, taskCwd: string, newId: NewId, panes: Record<Id, Pane>): Tab {
  const id = newId()
  const layout = expandSpec(tt.layout, taskCwd, newId, panes)
  const tab: Tab = { id, layout, activePaneId: paneIds(layout)[0] }
  if (tt.title !== undefined) tab.title = tt.title
  return tab
}

export function createTask(input: NewTaskInput, settings: Settings, newId: NewId, now: number): Task {
  const id = newId()
  // 빈 폴더로 만든 일감은 저장 파일 검증(normalizeState)에서 버려진다 → 홈 폴더로
  const cwd = input.cwd.trim() || '~'
  const template = settings.templates.find((t) => t.id === input.templateId)
  const tabSpecs: TemplateTab[] = template && template.tabs.length ? template.tabs : [{ layout: { pane: {} } }]
  const panes: Record<Id, Pane> = {}
  const tabs = tabSpecs.map((tt) => expandTab(tt, cwd, newId, panes))
  const statusOk = settings.statuses.some((s) => s.id === input.statusId)
  const groupOk = input.groupId !== null && settings.groups.some((g) => g.id === input.groupId)
  return {
    id,
    name: input.name.trim() || '새 일감',
    cwd,
    statusId: statusOk ? input.statusId : settings.statuses[0].id,
    groupId: groupOk ? input.groupId : null,
    color: input.color,
    tabs,
    activeTabId: tabs[0].id,
    panes,
    createdAt: now,
    // 템플릿의 빠른 명령은 일감에 복사한다(▤) — 템플릿을 나중에 고쳐도 이미 만든 일감은 그대로
    ...(template?.quickCommands?.length ? { quickCommands: template.quickCommands.map((q) => ({ ...q, fromTemplate: template.name })) } : {}),
  }
}

function toSpec(layout: Layout, task: Task): LayoutSpec {
  if (layout.type === 'pane') {
    const p = task.panes[layout.paneId]
    const spec: PaneSpec = {}
    if (p?.command) spec.command = p.command
    const rel = p ? relativeTo(task.cwd, p.cwd) : undefined
    if (rel !== undefined) spec.cwd = rel
    return { pane: spec }
  }
  return { split: layout.dir, ratio: layout.ratio, a: toSpec(layout.a, task), b: toSpec(layout.b, task) }
}

function tabToSpec(tab: Tab, task: Task): TemplateTab {
  const tt: TemplateTab = { layout: toSpec(tab.layout, task) }
  if (tab.title !== undefined) tt.title = tab.title
  return tt
}

/** 지금 일감의 탭 · 분할 · 시작 명령을 템플릿으로. 폴더는 일감 폴더 기준 상대 경로. */
/** 템플릿 이름 검사 — 저장 파일 검증(isId)이 버리는 이름(빈 이름 · 예약어)이면 그 이유. 이름 대화상자 · JSON 편집기 · 이름 바꾸기가 함께 쓴다. */
export function templateNameError(name: string): string | null {
  const n = name.trim()
  if (!n) return '이름이 비어 있습니다'
  if (RESERVED.has(n)) return `"${n}" 는 이름으로 쓸 수 없습니다`
  return null
}
const safeTemplateName = (name: string) => (templateNameError(name) ? '새 템플릿' : name.trim())

export function taskToTemplate(task: Task, name: string, newId: NewId): Template {
  // 저장 파일 검증이 버리는 이름이면 '새 템플릿'
  const template: Template = { id: newId(), name: safeTemplateName(name), tabs: task.tabs.map((tab) => tabToSpec(tab, task)) }
  // 빠른 명령도 같이 — 출처 표시는 새 템플릿으로 만든 일감에서 다시 붙는다
  if (task.quickCommands?.length) template.quickCommands = task.quickCommands.map(({ fromTemplate: _f, ...q }) => q)
  return template
}

/** 탭 하나를 템플릿으로 ("+ ▾" › 이 탭을 템플릿으로 저장). 없는 탭이면 null. */
export function tabToTemplate(task: Task, tabId: Id, name: string, newId: NewId): Template | null {
  const tab = task.tabs.find((t) => t.id === tabId)
  return tab ? { id: newId(), name: safeTemplateName(name), tabs: [tabToSpec(tab, task)] } : null
}

/** addTemplateTabs 가 만드는 새 id 수 (탭 + pane) — reducer 에 id 를 미리 만들어 넘길 때 */
export function templateIdCount(template: Template): number {
  const count = (l: LayoutSpec): number => ('pane' in l ? 1 : count(l.a) + count(l.b))
  return template.tabs.reduce((n, t) => n + 1 + count(t.layout), 0)
}

/** 템플릿의 탭들을 일감 끝에 붙인다 — 폴더는 일감 폴더 기준, 시작 명령은 셸이 뜰 때 한 번. 첫 새 탭이 활성. */
export function addTemplateTabs(task: Task, template: Template, newId: NewId): Task {
  if (template.tabs.length === 0) return task
  const panes = { ...task.panes }
  const tabs = template.tabs.map((tt) => expandTab(tt, task.cwd, newId, panes))
  return { ...task, tabs: [...task.tabs, ...tabs], activeTabId: tabs[0]!.id, panes }
}

// ─── 탭 · 분할 · pane ───────────────────────────────────────

function activeTab(task: Task): Tab | undefined {
  return task.tabs.find((t) => t.id === task.activeTabId)
}

function activePaneCwd(task: Task): string {
  const tab = activeTab(task)
  return (tab && task.panes[tab.activePaneId]?.cwd) || task.cwd
}

/** 새 탭 — spec 이 있으면 그 폴더 · 명령으로(빠른 명령 '새 탭', 20단계). 템플릿 시작 명령이 아니므로 command 는 남기지 않는다 */
export function addTab(task: Task, newId: NewId, spec?: SplitSpec): Task {
  const tabId = newId()
  const paneId = newId()
  const tab: Tab = { id: tabId, layout: { type: 'pane', paneId }, activePaneId: paneId }
  const pane: Pane = spec
    ? { id: paneId, cwd: spec.cwd, pendingCommand: spec.command, ...(spec.insert ? { pendingInsert: true as const } : {}) }
    : makePane(paneId, activePaneCwd(task))
  return {
    ...task,
    tabs: [...task.tabs, tab],
    activeTabId: tabId,
    panes: { ...task.panes, [paneId]: pane },
  }
}

// 바뀐 것이 없으면 같은 객체를 돌려준다 — reducer 가 같은 상태를 돌려줘 저장을 건너뛰게.

export function selectTab(task: Task, tabId: Id): Task {
  if (task.activeTabId === tabId || !task.tabs.some((t) => t.id === tabId)) return task
  return { ...task, activeTabId: tabId }
}

/** n번째 탭(1부터) — 9 는 탭 수와 상관없이 마지막 탭 (⌘1~9). 없는 번호면 그대로. */
export function selectTabAt(task: Task, n: number): Task {
  const tab = n === 9 ? task.tabs.at(-1) : task.tabs[n - 1]
  return tab ? selectTab(task, tab.id) : task
}

/** 다음 · 이전 탭, 끝에서 돈다 (⇧⌘[ ]). */
export function cycleTab(task: Task, step: 1 | -1): Task {
  const i = task.tabs.findIndex((t) => t.id === task.activeTabId)
  if (i < 0) return task
  return selectTab(task, task.tabs[(i + step + task.tabs.length) % task.tabs.length].id)
}

/** 활성 탭 안에서 다음 · 이전 pane (⌘[ ]). */
export function cycleActivePane(task: Task, step: 1 | -1): Task {
  const tab = activeTab(task)
  return tab ? focusPane(task, cyclePane(tab.layout, tab.activePaneId, step)) : task
}

/** 빈 이름이면 title 을 지워 기본 이름(tabLabel)으로 돌아간다. */
export function renameTab(task: Task, tabId: Id, title: string): Task {
  const tab = task.tabs.find((t) => t.id === tabId)
  const name = title.trim()
  if (!tab || (tab.title ?? '') === name) return task
  return {
    ...task,
    tabs: task.tabs.map((t) => {
      if (t.id !== tabId) return t
      const { title: _old, ...rest } = t
      return name ? { ...rest, title: name } : rest
    }),
  }
}

/** 탭에 보일 이름: 정한 이름, 없으면 활성 pane 폴더의 끝 이름 (`~` · `/` 는 그대로). */
export function tabLabel(task: Task, tab: Tab): string {
  if (tab.title) return tab.title
  const cwd = normalizePath(task.panes[tab.activePaneId]?.cwd ?? task.cwd)
  if (cwd === '~' || cwd === '/') return cwd
  return cwd.slice(cwd.lastIndexOf('/') + 1)
}

/** pane 을 활성으로: 그 pane 이 든 탭을 활성 탭으로, 그 탭의 활성 pane 으로. */
export function focusPane(task: Task, paneId: Id): Task {
  const tab = task.tabs.find((t) => hasPane(t.layout, paneId))
  if (!tab || (task.activeTabId === tab.id && tab.activePaneId === paneId)) return task
  return {
    ...task,
    activeTabId: tab.id,
    tabs: task.tabs.map((t) => (t === tab ? { ...tab, activePaneId: paneId } : t)),
  }
}

export function setTabRatio(task: Task, tabId: Id, path: SplitPath, ratio: number): Task {
  const tab = task.tabs.find((t) => t.id === tabId)
  if (!tab) return task
  const layout = setRatioAt(tab.layout, path, ratio)
  if (layout === tab.layout) return task
  return { ...task, tabs: task.tabs.map((t) => (t === tab ? { ...tab, layout } : t)) }
}

export function findPaneTask(state: AppState, paneId: Id): Id | null {
  return state.tasks.find((t) => Object.hasOwn(t.panes, paneId))?.id ?? null
}

/** 새 pane 을 다른 폴더 · 명령으로 (19단계 기록의 ⌥↩) — insert: 실행하지 않고 입력줄에 넣기만(위험 명령) */
export interface SplitSpec {
  cwd: string
  command: string
  insert?: boolean
}

export function splitActivePane(task: Task, dir: SplitDir, newId: NewId, spec?: SplitSpec): Task {
  const tab = activeTab(task)
  if (!tab || !hasPane(tab.layout, tab.activePaneId)) return task
  const paneId = newId()
  const next: Tab = { ...tab, layout: splitPane(tab.layout, tab.activePaneId, dir, paneId), activePaneId: paneId }
  // 기록에서 다시 돌리는 명령은 템플릿의 시작 명령(command)이 아니다 — 보낼 것만 남긴다
  const pane: Pane = spec
    ? { id: paneId, cwd: spec.cwd, pendingCommand: spec.command, ...(spec.insert ? { pendingInsert: true as const } : {}) }
    : makePane(paneId, activePaneCwd(task))
  return {
    ...task,
    tabs: task.tabs.map((t) => (t.id === tab.id ? next : t)),
    panes: { ...task.panes, [paneId]: pane },
  }
}

/** 셸 안의 cd (OSC 7 · lsof) — 복원할 때 그 폴더에서 셸을 연다. 같은 폴더 · 없는 pane · 빈 경로면 같은 객체(저장하지 않게). */
export function setPaneCwd(task: Task, paneId: Id, cwd: string): Task {
  const p = task.panes[paneId]
  if (!p || !cwd || p.cwd === cwd) return task
  return { ...task, panes: { ...task.panes, [paneId]: { ...p, cwd } } }
}

/** 시작 명령을 셸에 보냈다 — 다시 보내지 않게 pendingCommand 만 지운다. */
export function markCommandSent(task: Task, paneId: Id): Task {
  const p = task.panes[paneId]
  if (!p || p.pendingCommand === undefined) return task
  const { pendingCommand: _sent, pendingInsert: _insert, ...rest } = p
  return { ...task, panes: { ...task.panes, [paneId]: rest } }
}

function withoutPanes(panes: Record<Id, Pane>, ids: Id[]): Record<Id, Pane> {
  const out = { ...panes }
  for (const id of ids) delete out[id]
  return out
}

export function closeTab(task: Task, tabId: Id): Task {
  const idx = task.tabs.findIndex((t) => t.id === tabId)
  if (idx < 0) return task
  const tabs = task.tabs.filter((t) => t.id !== tabId)
  // 닫힌 탭이 활성이면 오른쪽 이웃(이제 같은 자리), 없으면 왼쪽
  const activeTabId = task.activeTabId === tabId ? (tabs[idx] ?? tabs[idx - 1])?.id ?? null : task.activeTabId
  return { ...task, tabs, activeTabId, panes: withoutPanes(task.panes, paneIds(task.tabs[idx].layout)) }
}

export function closePane(task: Task, paneId: Id): Task {
  const tab = task.tabs.find((t) => hasPane(t.layout, paneId))
  if (!tab) return task
  const layout = removePane(tab.layout, paneId)
  if (layout === null) return closeTab(task, tab.id)
  const activePaneId = tab.activePaneId === paneId ? paneIds(layout)[0] : tab.activePaneId
  return {
    ...task,
    tabs: task.tabs.map((t) => (t.id === tab.id ? { ...tab, layout, activePaneId } : t)),
    panes: withoutPanes(task.panes, [paneId]),
  }
}

// ─── 상태 · 묶음 ────────────────────────────────────────────

/** 상태를 지운다. 그 상태의 일감은 남은 첫 상태로. 마지막 하나는 지우지 않는다. */
export function removeStatus(state: AppState, statusId: Id): AppState {
  const { statuses } = state.settings
  if (statuses.length <= 1 || !statuses.some((s) => s.id === statusId)) return state
  const remaining = statuses.filter((s) => s.id !== statusId)
  const fallback = remaining[0].id
  return {
    ...state,
    settings: { ...state.settings, statuses: remaining },
    tasks: state.tasks.map((t) => (t.statusId === statusId ? { ...t, statusId: fallback } : t)),
  }
}

export function removeGroup(state: AppState, groupId: Id): AppState {
  if (!state.settings.groups.some((g) => g.id === groupId)) return state
  return {
    ...state,
    settings: { ...state.settings, groups: state.settings.groups.filter((g) => g.id !== groupId) },
    tasks: state.tasks.map((t) => (t.groupId === groupId ? { ...t, groupId: null } : t)),
  }
}

/** 목록에서 id 항목을 한 칸 옮긴다. 끝이거나 없으면 같은 배열. */
function moveItem<T extends { id: Id }>(list: T[], id: Id, step: 1 | -1): T[] {
  const i = list.findIndex((x) => x.id === id)
  const j = i + step
  if (i < 0 || j < 0 || j >= list.length) return list
  const out = [...list]
  ;[out[i], out[j]] = [out[j]!, out[i]!]
  return out
}

function withSettings(state: AppState, patch: Partial<Settings>): AppState {
  return { ...state, settings: { ...state.settings, ...patch } }
}

export function addStatus(state: AppState, id: Id, name: string, color: string): AppState {
  return withSettings(state, { statuses: [...state.settings.statuses, { id, name: name.trim() || '새 상태', color }] })
}

/** 이름 · 색 바꾸기. 빈 이름은 무시한다. 바뀐 것이 없으면 같은 상태. */
export function updateStatus(state: AppState, id: Id, patch: { name?: string; color?: string }): AppState {
  const cur = state.settings.statuses.find((s) => s.id === id)
  if (!cur) return state
  const name = patch.name?.trim() || cur.name
  const color = patch.color ?? cur.color
  if (name === cur.name && color === cur.color) return state
  return withSettings(state, { statuses: state.settings.statuses.map((s) => (s === cur ? { ...s, name, color } : s)) })
}

export function moveStatus(state: AppState, id: Id, step: 1 | -1): AppState {
  const statuses = moveItem(state.settings.statuses, id, step)
  return statuses === state.settings.statuses ? state : withSettings(state, { statuses })
}

export function addGroup(state: AppState, id: Id, name: string): AppState {
  return withSettings(state, { groups: [...state.settings.groups, { id, name: name.trim() || '새 묶음' }] })
}

export function renameGroup(state: AppState, id: Id, name: string): AppState {
  const n = name.trim()
  const cur = state.settings.groups.find((g) => g.id === id)
  if (!cur || !n || n === cur.name) return state
  return withSettings(state, { groups: state.settings.groups.map((g) => (g === cur ? { ...g, name: n } : g)) })
}

export function moveGroup(state: AppState, id: Id, step: 1 | -1): AppState {
  const groups = moveItem(state.settings.groups, id, step)
  return groups === state.settings.groups ? state : withSettings(state, { groups })
}

/** 사이드바 묶음 접기 · 펴기 */
export function toggleGroup(state: AppState, id: Id): AppState {
  const cur = state.settings.groups.find((g) => g.id === id)
  if (!cur) return state
  const { collapsed, ...rest } = cur
  const next: Group = collapsed ? rest : { ...rest, collapsed: true }
  return withSettings(state, { groups: state.settings.groups.map((g) => (g === cur ? next : g)) })
}

export function renameTemplate(state: AppState, id: Id, name: string): AppState {
  const n = name.trim()
  const cur = state.settings.templates.find((t) => t.id === id)
  if (!cur || templateNameError(n) || n === cur.name) return state
  return withSettings(state, { templates: state.settings.templates.map((t) => (t === cur ? { ...t, name: n } : t)) })
}

/** 템플릿 추가 (이 탭/일감을 템플릿으로 · JSON 편집기의 새 템플릿). 같은 id 가 있으면 그대로. */
export function addTemplate(state: AppState, template: Template): AppState {
  if (state.settings.templates.some((t) => t.id === template.id)) return state
  return withSettings(state, { templates: [...state.settings.templates, template] })
}

/** JSON 편집기에서 고친 이름 · 탭으로 바꾼다. id · 목록 안 자리는 그대로. */
/** JSON 편집기는 이름 · 탭만 고친다 — 빠른 명령(20단계) 같은 다른 칸은 남긴다 */
export function replaceTemplate(state: AppState, id: Id, next: Pick<Template, 'name' | 'tabs'>): AppState {
  if (!state.settings.templates.some((t) => t.id === id)) return state
  return withSettings(state, { templates: state.settings.templates.map((t) => (t.id === id ? { ...t, name: next.name, tabs: next.tabs } : t)) })
}

/** 템플릿을 지운다. 기본 템플릿이었으면 기본은 없음(셸 하나). 이미 만든 일감은 그대로. */
export function removeTemplate(state: AppState, id: Id): AppState {
  if (!state.settings.templates.some((t) => t.id === id)) return state
  return withSettings(state, {
    templates: state.settings.templates.filter((t) => t.id !== id),
    defaultTemplateId: state.settings.defaultTemplateId === id ? null : state.settings.defaultTemplateId,
  })
}

export interface TaskEdit {
  name?: string
  statusId?: Id
  groupId?: Id | null
  color?: string | null
}

/** 일감 이름 · 상태 · 묶음 · 색 (우클릭 메뉴). 빈 이름 · 없는 상태 · 묶음은 거절(같은 상태). */
export function editTask(state: AppState, taskId: Id, patch: TaskEdit): AppState {
  const task = state.tasks.find((t) => t.id === taskId)
  if (!task) return state
  if (patch.name !== undefined && !patch.name.trim()) return state
  if (patch.statusId !== undefined && !state.settings.statuses.some((s) => s.id === patch.statusId)) return state
  if (patch.groupId != null && !state.settings.groups.some((g) => g.id === patch.groupId)) return state
  const next: Task = {
    ...task,
    ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
    ...(patch.statusId !== undefined ? { statusId: patch.statusId } : {}),
    ...(patch.groupId !== undefined ? { groupId: patch.groupId } : {}),
    ...(patch.color !== undefined ? { color: patch.color } : {}),
  }
  const same = next.name === task.name && next.statusId === task.statusId && next.groupId === task.groupId && next.color === task.color
  return same ? state : { ...state, tasks: state.tasks.map((t) => (t === task ? next : t)) }
}

/** 새 일감 대화상자의 처음 폴더: 설정한 폴더 → 가장 나중에 만든 일감의 폴더 → ~ */
export function defaultTaskCwd(state: AppState): string {
  const set = state.settings.defaultCwd.trim()
  if (set) return set
  const last = state.tasks.reduce<Task | null>((a, t) => (!a || t.createdAt >= a.createdAt ? t : a), null)
  return last?.cwd ?? '~'
}

// ─── 저장 파일 검증 ─────────────────────────────────────────
// 디스크에서 읽은 JSON 은 손상 · 옛 형식일 수 있다. 버릴 것은 버리고 참조는 고쳐 항상 쓸 수 있는 AppState 로.

const isStr = (v: unknown): v is string => typeof v === 'string'
// '__proto__' 같은 이름을 id 로 받으면 일반 객체에 넣을 때 원형이 바뀐다
const RESERVED = new Set(['__proto__', 'constructor', 'prototype'])
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && !RESERVED.has(v)
const isDir = (v: unknown): v is SplitDir => v === 'right' || v === 'down'

function uniqueById<T extends { id: Id }>(items: (T | null)[]): T[] {
  const seen = new Set<Id>()
  const out: T[] = []
  for (const it of items) {
    if (it && !seen.has(it.id)) {
      seen.add(it.id)
      out.push(it)
    }
  }
  return out
}

function parseStatus(v: unknown): Status | null {
  return isObj(v) && isId(v.id) && isStr(v.name) && isStr(v.color) ? { id: v.id, name: v.name, color: v.color } : null
}

function parseGroup(v: unknown): Group | null {
  if (!isObj(v) || !isId(v.id) || !isStr(v.name)) return null
  return v.collapsed === true ? { id: v.id, name: v.name, collapsed: true } : { id: v.id, name: v.name }
}

function parseLayoutSpec(v: unknown): LayoutSpec | null {
  if (!isObj(v)) return null
  if ('pane' in v) {
    const p = v.pane
    if (!isObj(p)) return null
    const spec: PaneSpec = {}
    for (const key of ['command', 'cwd'] as const) {
      if (p[key] === undefined) continue
      if (!isStr(p[key])) return null
      spec[key] = p[key]
    }
    return { pane: spec }
  }
  if (!isDir(v.split)) return null
  const a = parseLayoutSpec(v.a)
  const b = parseLayoutSpec(v.b)
  if (!a || !b) return null
  const out: LayoutSpec = { split: v.split, a, b }
  if (typeof v.ratio === 'number') out.ratio = clampRatio(v.ratio)
  return out
}

function parseTemplate(v: unknown): Template | null {
  if (!isObj(v) || !isId(v.id) || !isId(v.name) || !Array.isArray(v.tabs)) return null
  const tabs: TemplateTab[] = []
  for (const t of v.tabs) {
    if (!isObj(t)) return null
    const layout = parseLayoutSpec(t.layout)
    if (!layout) return null
    const tab: TemplateTab = { layout }
    if (isStr(t.title)) tab.title = t.title
    tabs.push(tab)
  }
  const quick = parseQuickList(v.quickCommands)
  return quick.length ? { id: v.id, name: v.name, tabs, quickCommands: quick } : { id: v.id, name: v.name, tabs }
}

/** 빈 배열은 사용자가 모두 지운 것 → 그대로. 항목이 있었는데 하나도 못 쓰면 손상 → 기본 템플릿. */
function parseTemplates(v: unknown, fallback: Template[]): Template[] {
  if (!Array.isArray(v)) return fallback
  const parsed = uniqueById(v.map(parseTemplate))
  return v.length > 0 && parsed.length === 0 ? fallback : parsed
}

function parseSettings(v: unknown): Settings {
  const d = defaultSettings()
  if (!isObj(v)) return d
  const statuses = Array.isArray(v.statuses) ? uniqueById(v.statuses.map(parseStatus)) : []
  const fs = v.fontSize
  const templates = parseTemplates(v.templates, d.templates)
  return {
    statuses: statuses.length ? statuses : d.statuses,
    groups: Array.isArray(v.groups) ? uniqueById(v.groups.map(parseGroup)) : d.groups,
    templates,
    fontSize: Number.isInteger(fs) && (fs as number) >= FONT_MIN && (fs as number) <= FONT_MAX ? (fs as number) : d.fontSize,
    shell: isId(v.shell) ? v.shell : null,
    ...parseExtraSettings(v, templates.map((t) => t.id)),
  }
}

function parseLayout(v: unknown): Layout | null {
  if (!isObj(v)) return null
  if (v.type === 'pane') return isId(v.paneId) ? { type: 'pane', paneId: v.paneId } : null
  if (v.type !== 'split' || !isDir(v.dir)) return null
  const a = parseLayout(v.a)
  const b = parseLayout(v.b)
  if (!a || !b) return null
  return { type: 'split', dir: v.dir, ratio: clampRatio(typeof v.ratio === 'number' ? v.ratio : 0.5), a, b }
}

function parsePane(id: Id, v: unknown, taskCwd: string): Pane | null {
  if (!isObj(v)) return null
  const pane: Pane = { id, cwd: isId(v.cwd) ? v.cwd : taskCwd }
  if (isStr(v.command)) pane.command = v.command
  if (isStr(v.pendingCommand)) pane.pendingCommand = v.pendingCommand
  if (pane.pendingCommand !== undefined && v.pendingInsert === true) pane.pendingInsert = true
  return pane
}

/** 모든 일감에 걸쳐 이미 쓴 id — pty · 스크롤 저장은 pane id 로 찾으므로 일감 사이에서도 겹치면 안 된다 */
interface SeenIds {
  panes: Set<Id>
  tabs: Set<Id>
}

function parseTask(v: unknown, settings: Settings, newId: NewId, seen: SeenIds): Task | null {
  if (!isObj(v) || !isId(v.id) || !isStr(v.name) || !isId(v.cwd)) return null
  const cwd = v.cwd
  const rawPanes = isObj(v.panes) ? v.panes : {}
  const used = seen.panes
  const panes: Record<Id, Pane> = {}
  const tabs: Tab[] = []
  for (const t of Array.isArray(v.tabs) ? v.tabs : []) {
    if (!isObj(t)) continue
    const layout = parseLayout(t.layout)
    if (!layout) continue
    const ids = paneIds(layout)
    const parsed = ids.map((id) => (Object.hasOwn(rawPanes, id) ? parsePane(id, rawPanes[id], cwd) : null))
    // 모르는 pane 참조 · 같은 탭 안 중복 · 다른 탭(다른 일감 포함)과 겹침 → 그 탭을 버린다 (pty 하나를 두 화면이 나눠 쓰지 않게)
    if (parsed.some((p) => p === null) || new Set(ids).size !== ids.length || ids.some((id) => used.has(id))) continue
    const tabId = isId(t.id) && !seen.tabs.has(t.id) ? t.id : newId()
    seen.tabs.add(tabId)
    for (const p of parsed as Pane[]) {
      used.add(p.id)
      panes[p.id] = p
    }
    const tab: Tab = { id: tabId, layout, activePaneId: isId(t.activePaneId) && ids.includes(t.activePaneId) ? t.activePaneId : ids[0] }
    if (isStr(t.title)) tab.title = t.title
    tabs.push(tab)
  }
  return {
    id: v.id,
    name: v.name,
    cwd,
    statusId: settings.statuses.some((s) => s.id === v.statusId) ? (v.statusId as Id) : settings.statuses[0].id,
    groupId: settings.groups.some((g) => g.id === v.groupId) ? (v.groupId as Id) : null,
    color: isStr(v.color) ? v.color : null,
    tabs,
    activeTabId: tabs.some((t) => t.id === v.activeTabId) ? (v.activeTabId as Id) : (tabs[0]?.id ?? null),
    panes,
    createdAt: typeof v.createdAt === 'number' && Number.isFinite(v.createdAt) ? v.createdAt : 0,
    ...(Array.isArray(v.quickCommands) && v.quickCommands.length ? { quickCommands: parseQuickList(v.quickCommands) } : {}),
  }
}

export function normalizeState(raw: unknown, newId: NewId): AppState {
  if (!isObj(raw)) return emptyState()
  const settings = parseSettings(raw.settings)
  const seen: SeenIds = { panes: new Set(), tabs: new Set() }
  const taskIds = new Set<Id>()
  const tasks: Task[] = []
  for (const t of Array.isArray(raw.tasks) ? raw.tasks : []) {
    // 겹치는 일감 id 는 탭 · pane 을 seen 에 넣기 전에 걸러야 앞 일감의 id 를 막지 않는다
    if (isObj(t) && isId(t.id) && taskIds.has(t.id)) continue
    const task = parseTask(t, settings, newId, seen)
    if (task) {
      taskIds.add(task.id)
      tasks.push(task)
    }
  }
  const activeTaskId = tasks.some((t) => t.id === raw.activeTaskId) ? (raw.activeTaskId as Id) : (tasks[0]?.id ?? null)
  return { version: 1, tasks, activeTaskId, settings }
}

// ─── 빠른 명령 (20단계) ─────────────────────────────────────

/** 단추가 사는 곳 — 그 일감 · 모든 일감(◎) */
export type QuickScope = { taskId: Id } | 'all'

function quickListOf(state: AppState, scope: QuickScope): QuickCommand[] | null {
  if (scope === 'all') return state.settings.quickCommands
  const task = state.tasks.find((t) => t.id === scope.taskId)
  return task ? (task.quickCommands ?? []) : null
}

function withQuickList(state: AppState, scope: QuickScope, list: QuickCommand[]): AppState {
  if (scope === 'all') return { ...state, settings: { ...state.settings, quickCommands: list } }
  return {
    ...state,
    tasks: state.tasks.map((t) => {
      if (t.id !== scope.taskId) return t
      if (list.length > 0) return { ...t, quickCommands: list }
      const { quickCommands: _q, ...rest } = t
      return rest
    }),
  }
}

/** 만들기 · 고치기 — 일감이 그 사이 지워졌으면 그대로(같은 객체) */
export function saveQuick(state: AppState, scope: QuickScope, qc: QuickCommand): AppState {
  const list = quickListOf(state, scope)
  return list ? withQuickList(state, scope, upsertQuick(list, qc)) : state
}

/** 지우기 — 되돌리기용으로 지운 것과 자리를 돌려준다 */
export function dropQuick(state: AppState, scope: QuickScope, id: Id): { state: AppState; removed: QuickCommand | null; index: number } {
  const list = quickListOf(state, scope)
  if (!list) return { state, removed: null, index: -1 }
  const r = removeQuick(list, id)
  return r.removed ? { state: withQuickList(state, scope, r.list), removed: r.removed, index: r.index } : { state, removed: null, index: -1 }
}

export function putBackQuick(state: AppState, scope: QuickScope, qc: QuickCommand, index: number): AppState {
  const list = quickListOf(state, scope)
  if (!list) return state
  const next = restoreQuick(list, qc, index)
  return next === list ? state : withQuickList(state, scope, next)
}

/** 단추 하나를 id 로 다시 찾기 — 확인 창 · 메뉴가 연 뒤 누르는 순간에 */
export function findQuick(state: AppState, scope: QuickScope, id: Id): QuickCommand | null {
  return quickListOf(state, scope)?.find((q) => q.id === id) ?? null
}
