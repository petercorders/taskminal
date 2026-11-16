// 전체 보기는 사이드바와 같은 흐름을 쓰되, 실제 탭에 속한 pane만 대상으로 삼는다.
import type { PaneActivity } from '../shared/activity'
import { AGENT_NAME } from '../shared/chat'
import type { Branches } from '../shared/git'
import { paneIds } from '../shared/layout'
import type { AppState, Id, Task } from '../shared/types'
import { flowSections, lastActive, lastLine, type PaneTarget } from './sidebar-model'

export interface OverviewPane extends PaneTarget {
  label: string
  activity?: PaneActivity
}

export interface OverviewCard {
  task: Task
  group: string | null
  branch: string | null
  panes: OverviewPane[]
  target: PaneTarget | null
  line: ReturnType<typeof lastLine>
  lastAt: number | null
  unread: boolean
}

export interface OverviewSection {
  key: string
  title: string
  cards: OverviewCard[]
}

function liveTask(task: Task): Task {
  const ids = new Set(task.tabs.flatMap((tab) => paneIds(tab.layout)))
  return { ...task, panes: Object.fromEntries(Object.entries(task.panes).filter(([id]) => ids.has(id))) }
}

function targets(task: Task, activity: Readonly<Record<Id, PaneActivity>>): OverviewPane[] {
  return task.tabs.flatMap((tab, ti) => paneIds(tab.layout).flatMap((paneId, pi) => {
    const pane = task.panes[paneId]
    if (!pane) return []
    const kind = pane.kind === 'chat' ? AGENT_NAME[pane.chat?.agent ?? 'claude'] : pane.kind === 'review' ? '변경 검토' : '터미널'
    return [{ taskId: task.id, tabId: tab.id, paneId, label: `${tab.title ?? `탭 ${ti + 1}`} · ${kind}${paneIds(tab.layout).length > 1 ? ` ${pi + 1}` : ''}`, activity: activity[paneId] }]
  }))
}

/** 조작 직전에 확인. 옛 카드의 pane을 다른 일감/탭의 현재 pane으로 대체하지 않는다. */
export function overviewTarget(state: AppState, target: PaneTarget): PaneTarget | null {
  const task = state.tasks.find((t) => t.id === target.taskId && t.archivedAt === undefined)
  const tab = task?.tabs.find((t) => t.id === target.tabId)
  return task?.panes[target.paneId] && tab && paneIds(tab.layout).includes(target.paneId) ? target : null
}

export function overviewSections(state: AppState, activity: Readonly<Record<Id, PaneActivity>>, branches: Branches, unread: ReadonlySet<Id>, query: string): OverviewSection[] {
  const q = query.trim().toLocaleLowerCase()
  const groups = state.settings.groups
  const tasks = state.tasks.filter((t) => t.archivedAt === undefined).map(liveTask).filter((t) => {
    if (!q) return true
    return [t.name, t.cwd, branches[t.cwd] ?? '', groups.find((g) => g.id === t.groupId)?.name ?? '', ...targets(t, activity).map((p) => p.label)]
      .some((text) => text.toLocaleLowerCase().includes(q))
  })
  return flowSections({ ...state, tasks }, activity, unread, '', branches).map((section) => ({
    key: section.key,
    title: section.title,
    cards: section.tasks.map((task) => {
      const panes = targets(task, activity)
      const chosen = panes.find((p) => p.activity?.attention) ?? panes.find((p) => p.activity?.busy) ?? panes.find((p) => p.paneId === task.tabs.find((t) => t.id === task.activeTabId)?.activePaneId) ?? panes[0]
      const target = chosen ? { taskId: chosen.taskId, tabId: chosen.tabId, paneId: chosen.paneId } : null
      return { task, panes, target, group: groups.find((g) => g.id === task.groupId)?.name ?? null, branch: branches[task.cwd] ?? null, line: lastLine(task, activity), lastAt: lastActive(task, activity), unread: unread.has(task.id) }
    }),
  }))
}
