// 사이드바에 보일 칸 나누기. 순수 함수라 단위 시험한다.
import type { PaneActivity } from '../shared/activity'
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
