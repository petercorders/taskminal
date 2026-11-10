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
    ],
    fontSize: 13,
    shell: null,
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

/** 지금 일감의 탭 · 분할 · 시작 명령을 템플릿으로. 폴더는 일감 폴더 기준 상대 경로. */
export function taskToTemplate(task: Task, name: string, newId: NewId): Template {
  return {
    id: newId(),
    // 빈 이름 템플릿은 저장 파일 검증에서 버려진다
    name: name.trim() || '새 템플릿',
    tabs: task.tabs.map((tab) => {
      const tt: TemplateTab = { layout: toSpec(tab.layout, task) }
      if (tab.title !== undefined) tt.title = tab.title
      return tt
    }),
  }
}

// ─── 탭 · 분할 · pane ───────────────────────────────────────

function activeTab(task: Task): Tab | undefined {
  return task.tabs.find((t) => t.id === task.activeTabId)
}

function activePaneCwd(task: Task): string {
  const tab = activeTab(task)
  return (tab && task.panes[tab.activePaneId]?.cwd) || task.cwd
}

export function addTab(task: Task, newId: NewId): Task {
  const tabId = newId()
  const paneId = newId()
  const tab: Tab = { id: tabId, layout: { type: 'pane', paneId }, activePaneId: paneId }
  return {
    ...task,
    tabs: [...task.tabs, tab],
    activeTabId: tabId,
    panes: { ...task.panes, [paneId]: makePane(paneId, activePaneCwd(task)) },
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

export function splitActivePane(task: Task, dir: SplitDir, newId: NewId): Task {
  const tab = activeTab(task)
  if (!tab || !hasPane(tab.layout, tab.activePaneId)) return task
  const paneId = newId()
  const next: Tab = { ...tab, layout: splitPane(tab.layout, tab.activePaneId, dir, paneId), activePaneId: paneId }
  return {
    ...task,
    tabs: task.tabs.map((t) => (t.id === tab.id ? next : t)),
    panes: { ...task.panes, [paneId]: makePane(paneId, activePaneCwd(task)) },
  }
}

/** 시작 명령을 셸에 보냈다 — 다시 보내지 않게 pendingCommand 만 지운다. */
export function markCommandSent(task: Task, paneId: Id): Task {
  const p = task.panes[paneId]
  if (!p || p.pendingCommand === undefined) return task
  const { pendingCommand: _sent, ...rest } = p
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

// ─── 저장 파일 검증 ─────────────────────────────────────────
// 디스크에서 읽은 JSON 은 손상 · 옛 형식일 수 있다. 버릴 것은 버리고 참조는 고쳐 항상 쓸 수 있는 AppState 로.

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
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
  return isObj(v) && isId(v.id) && isStr(v.name) ? { id: v.id, name: v.name } : null
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
  return { id: v.id, name: v.name, tabs }
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
  return {
    statuses: statuses.length ? statuses : d.statuses,
    groups: Array.isArray(v.groups) ? uniqueById(v.groups.map(parseGroup)) : d.groups,
    templates: parseTemplates(v.templates, d.templates),
    fontSize: typeof fs === 'number' && Number.isFinite(fs) && fs >= 8 && fs <= 32 ? fs : d.fontSize,
    shell: isId(v.shell) ? v.shell : null,
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
