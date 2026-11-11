// 사이드바에 보일 칸 나누기. 순수 함수라 단위 시험한다.
import { taskActivity, type PaneActivity } from '../shared/activity'
import { paneIds } from '../shared/layout'
import type { AppState, Group, Id, Task } from '../shared/types'

export interface SidebarSection {
  /** 묶음 이름. 묶음이 하나도 쓰이지 않으면 null(제목 없는 한 칸) */
  title: string | null
  group: Group | null
  tasks: Task[]
}

/** 묶음은 설정 순서대로, 묶음 없는 일감은 맨 끝. 일감이 없는 묶음은 숨긴다. */
export function sidebarSections(state: AppState): SidebarSection[] {
  const known = new Set(state.settings.groups.map((g) => g.id))
  const grouped: SidebarSection[] = state.settings.groups
    .map((group) => ({ title: group.name, group, tasks: state.tasks.filter((t) => t.groupId === group.id) }))
    .filter((s) => s.tasks.length > 0)
  const loose = state.tasks.filter((t) => t.groupId === null || !known.has(t.groupId))
  if (loose.length === 0) return grouped
  if (grouped.length === 0) return [{ title: null, group: null, tasks: loose }]
  return [...grouped, { title: '묶음 없음', group: null, tasks: loose }]
}

/** 사이드바에 보이는 순서로 다음 · 이전 일감 id (⌥⌘↑↓), 끝에서 돈다. 활성이 없으면 첫 일감, 일감이 없으면 null. */
export function adjacentTask(state: AppState, step: 1 | -1): string | null {
  const order = sidebarSections(state).flatMap((s) => s.tasks.map((t) => t.id))
  if (order.length === 0) return null
  const i = state.activeTaskId === null ? -1 : order.indexOf(state.activeTaskId)
  if (i < 0) return order[0]!
  return order[(i + step + order.length) % order.length]!
}

/** ⌃⌘← / ⌃⌘→: 설정 상태 순서에서 이전 · 다음 상태 id. 끝에서는 돌지 않고 null(완료 → 첫 상태로 넘어가면 실수).
 *  모르는 상태(지운 상태)는 첫 칸에 보이므로 다음은 둘째 상태, 이전은 첫 상태 자체(바른 id 로 고친다). 없는 일감 · 상태 하나면 null. */
export function stepStatus(state: AppState, taskId: Id, step: 1 | -1): string | null {
  const task = state.tasks.find((t) => t.id === taskId)
  const statuses = state.settings.statuses
  if (!task || statuses.length < 2) return null
  const here = statuses.findIndex((s) => s.id === task.statusId)
  if (here < 0) return statuses[step === 1 ? 1 : 0]!.id
  return statuses[here + step]?.id ?? null
}

export interface PaneTarget {
  taskId: Id
  tabId: Id
  paneId: Id
}

/** 모든 pane 을 사이드바 순서 → 탭 순서 → 화면 순서로 */
function orderedPanes(state: AppState): PaneTarget[] {
  return sidebarSections(state).flatMap((s) =>
    s.tasks.flatMap((task) => task.tabs.flatMap((tab) => paneIds(tab.layout).map((paneId) => ({ taskId: task.id, tabId: tab.id, paneId })))),
  )
}

/** ⇧⌘A: 지금 보는 pane 다음의 확인 필요 pane, 끝이면 처음으로. 없으면 null. */
export function nextAttention(state: AppState, activity: Readonly<Record<Id, PaneActivity>>, current: Id | null): PaneTarget | null {
  const all = orderedPanes(state)
  const here = current === null ? -1 : all.findIndex((p) => p.paneId === current)
  const targets = all.map((p, i) => ({ p, i })).filter(({ p }) => activity[p.paneId]?.attention)
  if (targets.length === 0) return null
  return (targets.find(({ i }) => i > here) ?? targets[0]!).p
}

/** 사이드바 둘째 줄용: 세 칸 넘는 경로는 끝 두 칸만 (`~/code/jjikgyebu/flutter` → `…/jjikgyebu/flutter`). */
export function shortPath(cwd: string): string {
  const trimmed = cwd.length > 1 ? cwd.replace(/\/+$/, '') : cwd
  const parts = trimmed.split('/').filter(Boolean)
  if (parts.length <= 3) return trimmed
  return `…/${parts.slice(-2).join('/')}`
}

// ─── 21단계 흐름 보기 (design-gaps 4 · Sidebar 보드) ───────────────────────

export interface FlowSection {
  /** 'need' 또는 상태 id */
  key: string
  title: string
  color: string
  tasks: Task[]
}

const lowerHas = (hay: string, q: string) => hay.toLowerCase().includes(q)

/** 사이드바 거르기 — 이름 · 폴더 · 브랜치 · 묶음 이름, 대소문자 무시. 빈 글이면 그대로 */
export function filterTasks(tasks: readonly Task[], query: string, groups: readonly Group[], branches: Readonly<Record<string, string | null>>): Task[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...tasks]
  return tasks.filter((t) => {
    const group = groups.find((g) => g.id === t.groupId)?.name ?? ''
    return [t.name, t.cwd, branches[t.cwd] ?? '', group].some((x) => lowerHas(x, q))
  })
}

/** 마지막 상태(기본 '완료') — 이 칸의 일감은 확인 필요로 올리지 않고 막대에서도 세지 않는다 */
function lastStatusId(state: AppState): string | null {
  const s = state.settings.statuses
  return s.length > 1 ? s[s.length - 1]!.id : null
}

function needs(task: Task, activity: Readonly<Record<Id, PaneActivity>>, unread: ReadonlySet<Id>, doneId: string | null): boolean {
  if (task.statusId === doneId) return false
  return unread.has(task.id) || Object.keys(task.panes).some((id) => activity[id]?.attention)
}

/** 흐름 보기 칸: 확인 필요(입력 기다림 · 보지 않은 실패 · 안 본 끝남) → 설정의 상태 순서. 모르는 상태는 첫 칸 */
export function flowSections(state: AppState, activity: Readonly<Record<Id, PaneActivity>>, unread: ReadonlySet<Id>, query: string, branches: Readonly<Record<string, string | null>> = {}): FlowSection[] {
  const tasks = filterTasks(state.tasks, query, state.settings.groups, branches)
  const statuses = state.settings.statuses
  const doneId = lastStatusId(state)
  const known = new Set(statuses.map((s) => s.id))
  const need = tasks.filter((t) => needs(t, activity, unread, doneId))
  const rest = tasks.filter((t) => !need.includes(t))
  return [
    { key: 'need', title: '확인 필요', color: 'var(--waiting)', tasks: need },
    ...statuses.map((s, i) => ({
      key: s.id,
      title: s.name,
      color: s.color,
      tasks: rest.filter((t) => t.statusId === s.id || (i === 0 && !known.has(t.statusId))),
    })),
  ]
}

export interface CountBar {
  need: number
  run: number
  done: number
  idle: number
}

/** 맨 위 개수 막대 (Orca 사이드바 대시보드 줄) — 마지막 상태 일감은 세지 않는다 */
export function countBar(state: AppState, activity: Readonly<Record<Id, PaneActivity>>, unread: ReadonlySet<Id>): CountBar {
  const doneId = lastStatusId(state)
  const c: CountBar = { need: 0, run: 0, done: 0, idle: 0 }
  for (const t of state.tasks) {
    if (t.statusId === doneId) continue
    if (needs(t, activity, unread, doneId)) c.need++
    else {
      const a = taskActivity(Object.keys(t.panes).map((id) => activity[id]))
      if (a.state === 'running') c.run++
      else if (a.state === 'done' || a.state === 'failed') c.done++
      else c.idle++
    }
  }
  return c
}

/** 안 본 일감: 마지막으로 본 시각 뒤에 끝난(끝남 · 실패) pane 이 있다. 지금 보는 일감은 아님 */
export function unreadTasks(state: AppState, activity: Readonly<Record<Id, PaneActivity>>, seenAt: Readonly<Record<Id, number>>): Set<Id> {
  const out = new Set<Id>()
  for (const t of state.tasks) {
    if (t.id === state.activeTaskId) continue
    const seen = seenAt[t.id] ?? 0
    if (Object.keys(t.panes).some((id) => (activity[id]?.endedAt ?? 0) > seen)) out.add(t.id)
  }
  return out
}

/** 줄 둘째 칸 — 일감에서 가장 최근에 움직인 pane 의 한 줄. 아무 일도 없었으면 null(폴더를 보인다) */
export function lastLine(task: Task, activity: Readonly<Record<Id, PaneActivity>>): { text: string; tone: 'err' | 'wait' | 'run' | 'dim' } | null {
  let best: PaneActivity | undefined
  let bestAt = -1
  for (const id of Object.keys(task.panes)) {
    const a = activity[id]
    if (!a || a.state === 'idle') continue
    const at = Math.max(a.endedAt ?? 0, a.startedAt ?? 0) + (a.attention ? 1e15 : 0)
    if (at > bestAt) {
      best = a
      bestAt = at
    }
  }
  if (!best) return null
  const cmd = best.command ?? ''
  if (best.attention && best.state !== 'failed') return { text: best.message ?? (cmd ? `입력 기다림 · ${cmd}` : '입력 기다림'), tone: 'wait' }
  switch (best.state) {
    case 'failed':
      return { text: `✗ ${cmd || '명령'}${best.exitCode !== undefined ? ` · exit ${best.exitCode}` : ''}`, tone: 'err' }
    case 'waiting':
      return { text: best.message ?? '입력 기다림', tone: 'wait' }
    case 'running':
      return { text: `● ${cmd || '실행 중'}`, tone: 'run' }
    default:
      return { text: `✓ ${cmd || '끝남'}`, tone: 'dim' }
  }
}

/** 몇 분 전 — 1분 안이면 '방금' */
export function timeAgo(at: number, now: number): string {
  const s = Math.max(0, now - at) / 1000
  if (s < 60) return '방금'
  if (s < 3600) return `${Math.floor(s / 60)}분`
  if (s < 86400) return `${Math.floor(s / 3600)}시간`
  return `${Math.floor(s / 86400)}일`
}

/** 일감에서 마지막으로 움직인 시각 (없으면 null) */
export function lastActive(task: Task, activity: Readonly<Record<Id, PaneActivity>>): number | null {
  let at = 0
  for (const id of Object.keys(task.panes)) {
    const a = activity[id]
    if (a) at = Math.max(at, a.endedAt ?? 0, a.startedAt ?? 0)
  }
  return at || null
}

/** 사이드바 둘째 줄의 칸 수 (26단계): 대화가 있으면 '대화 N · 셸 M', 셸만이면 예전처럼 '터미널 N'. 검토 칸은 세지 않는다. */
export function paneCountLabel(task: Task): string {
  let chat = 0
  let shell = 0
  for (const p of Object.values(task.panes)) {
    if (p.kind === 'chat') chat++
    else if (p.kind !== 'review') shell++
  }
  if (chat === 0) return `터미널 ${shell}`
  return shell ? `대화 ${chat} · 셸 ${shell}` : `대화 ${chat}`
}
