// 전체 보기는 사이드바와 같은 흐름을 쓰되, 실제 탭에 속한 pane만 대상으로 삼는다.
import type { PaneActivity } from '../shared/activity'
import { AGENT_NAME, type ChatAgent, type ChatEvent } from '../shared/chat'
import type { Branches } from '../shared/git'
import { paneIds } from '../shared/layout'
import type { AppState, Id, Task } from '../shared/types'
import type { InboxEntry } from '../shared/inbox'
import { flowSections, lastActive, lastLine, type PaneTarget } from './sidebar-model'

export interface OverviewPane extends PaneTarget {
  label: string
  /** 대화 pane 이면 그 에이전트 — 줄 앞에 로고를 그린다(59단계) */
  agent?: ChatAgent
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
    const agent = pane.kind === 'chat' ? (pane.chat?.agent ?? 'claude') : undefined
    const kind = agent ? AGENT_NAME[agent] : pane.kind === 'review' ? '변경 검토' : '터미널'
    return [{ taskId: task.id, tabId: tab.id, paneId, label: `${tab.title ?? `탭 ${ti + 1}`} · ${kind}${paneIds(tab.layout).length > 1 ? ` ${pi + 1}` : ''}`, ...(agent ? { agent } : {}), activity: activity[paneId] }]
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

/** 66단계 '지난 알림' 한 줄 — 일감 이름과 지금 열 수 있는 pane(닫혔거나 보관했으면 null) */
export interface InboxRow {
  entry: InboxEntry
  taskName: string
  target: PaneTarget | null
}
export function inboxRows(state: AppState, entries: readonly InboxEntry[]): InboxRow[] {
  return entries.map((entry) => {
    const task = state.tasks.find((t) => t.id === entry.taskId)
    const tab = task?.tabs.find((t) => paneIds(t.layout).includes(entry.paneId))
    const target = task && tab ? overviewTarget(state, { taskId: task.id, tabId: tab.id, paneId: entry.paneId }) : null
    return { entry, taskName: task?.name ?? '지운 일감', target }
  })
}

export interface ChatInboxSignal {
  pending: ReadonlySet<Id>
  outcome: 'failed' | 'done' | null
}

export function chatInboxSignal(previous: ChatInboxSignal | undefined, event: ChatEvent): ChatInboxSignal | undefined {
  switch (event.t) {
    case 'permission':
    case 'question':
      return { pending: new Set([...(previous?.pending ?? []), event.id]), outcome: null }
    case 'answered': {
      if (!previous?.pending.has(event.id)) return previous
      const pending = new Set(previous.pending)
      pending.delete(event.id)
      return pending.size ? { ...previous, pending } : undefined
    }
    case 'user':
    case 'stopped':
      return undefined
    case 'turn_end':
      return { pending: new Set(), outcome: event.ok ? 'done' : 'failed' }
    case 'error':
      return {
        pending: event.kind === 'crash' || event.kind === 'missing' ? new Set() : (previous?.pending ?? new Set()),
        outcome: 'failed',
      }
    default:
      return previous
  }
}

export const reviewStatusFor = (state: AppState) => state.settings.statuses.find((status) => status.name.includes('리뷰'))

export type InboxAction =
  | { kind: 'answer' | 'investigate'; taskId: Id; taskName: string; target: PaneTarget }
  | { kind: 'review'; taskId: Id; taskName: string }

export function activeInboxRows(
  state: AppState,
  activity: Readonly<Record<Id, PaneActivity>>,
  chat: Readonly<Record<Id, ChatInboxSignal | undefined>>,
  branches: Branches,
): InboxAction[] {
  const reviewStatus = reviewStatusFor(state)?.id
  const actions: InboxAction[] = []
  for (const task of state.tasks) {
    if (task.archivedAt !== undefined) continue
    let completed = false
    for (const pane of targets(task, activity)) {
      const current = chat[pane.paneId]
      const waiting = pane.agent ? (current?.pending.size ?? 0) > 0 : pane.activity?.state === 'waiting' && (!!pane.activity.agent || pane.activity.attention)
      const failed = pane.agent ? current?.outcome === 'failed' : pane.activity?.state === 'failed' && pane.activity.attention
      const target: PaneTarget = { taskId: pane.taskId, tabId: pane.tabId, paneId: pane.paneId }
      if (waiting) actions.push({ kind: 'answer', taskId: task.id, taskName: task.name, target })
      else if (failed) actions.push({ kind: 'investigate', taskId: task.id, taskName: task.name, target })
      if (current?.outcome === 'done') completed = true
    }
    const explicitlyReady = task.statusId === reviewStatus
    const closed = state.settings.statuses.length > 1 && task.statusId === state.settings.statuses.at(-1)?.id && !explicitlyReady
    if (!task.host && branches[task.cwd] && !closed && (explicitlyReady || completed)) {
      actions.push({ kind: 'review', taskId: task.id, taskName: task.name })
    }
  }
  const order = { answer: 0, investigate: 1, review: 2 }
  return actions.sort((a, b) => order[a.kind] - order[b.kind])
}
