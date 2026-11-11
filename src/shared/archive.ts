// 보관함 (25단계) — 보관 = 셸만 끄고 남김. 되살리기 · 보관 제안 · 찾기 · 최근 지운 것(17단계 '지움' 백업에서)
import { mapLayout } from './backup'
import type { AppState, Id, Task } from './types'

const DAY = 24 * 3600 * 1000
/** 완료한 지 이만큼 넘은 일감을 '보관할까요?' 로 제안 */
export const ARCHIVE_SUGGEST_MS = 7 * DAY
/** '최근 지운 것' 에 보이는 기간 — 17단계 백업의 하루 하나 보존과 같다 */
export const RECENT_DELETED_MS = 30 * DAY

export function isArchived(t: Task): boolean {
  return t.archivedAt !== undefined
}
export function visibleTasks(state: AppState): Task[] {
  return state.tasks.filter((t) => !isArchived(t))
}

/** 보관 — 활성이었으면 오른쪽(없으면 왼쪽) 보이는 일감으로. 이미 보관 · 없는 일감이면 그대로 */
export function archiveTask(state: AppState, taskId: Id, now: number): AppState {
  const i = state.tasks.findIndex((t) => t.id === taskId)
  const t = state.tasks[i]
  if (!t || isArchived(t)) return state
  const tasks = state.tasks.map((x) => (x.id === taskId ? { ...x, archivedAt: now } : x))
  let activeTaskId = state.activeTaskId
  if (activeTaskId === taskId) {
    const right = tasks.slice(i + 1).find((x) => !isArchived(x))
    const left = [...tasks.slice(0, i)].reverse().find((x) => !isArchived(x))
    activeTaskId = (right ?? left)?.id ?? null
  }
  return { ...state, tasks, activeTaskId }
}

/**
 * 되살리기 — 터미널 · 변경 pane 은 새 id(지킴이가 아직 끝내는 중인 옛 셸에 다시 붙지 않게, 새 셸이 그 폴더에서),
 * 대화 pane 은 같은 id(기록 · 세션 이어 하기). 보관 일감이 아니면 null
 */
export function unarchiveTask(state: AppState, taskId: Id, newId: () => Id): AppState | null {
  const t = state.tasks.find((x) => x.id === taskId)
  if (!t || !isArchived(t)) return null
  const ids = new Map<Id, Id>()
  for (const [id, p] of Object.entries(t.panes)) if (p.kind !== 'chat') ids.set(id, newId())
  const panes: Task['panes'] = {}
  for (const [id, p] of Object.entries(t.panes)) {
    const nid = ids.get(id) ?? id
    panes[nid] = { ...p, id: nid }
  }
  const { archivedAt: _a, ...rest } = t
  const back: Task = {
    ...rest,
    panes,
    tabs: t.tabs.map((tab) => ({ ...tab, layout: mapLayout(tab.layout, ids), activePaneId: ids.get(tab.activePaneId) ?? tab.activePaneId })),
  }
  return { ...state, tasks: state.tasks.map((x) => (x.id === taskId ? back : x)), activeTaskId: taskId }
}

/** 완료 칸의 '보관할까요? n' — 마지막 상태이고 마지막으로 본 때(없으면 만든 때)가 7일 넘음 */
export function archiveSuggestions(state: AppState, now: number): Task[] {
  const last = state.settings.statuses[state.settings.statuses.length - 1]?.id
  return state.tasks.filter((t) => !isArchived(t) && t.statusId === last && now - (t.lastViewedAt ?? t.createdAt) > ARCHIVE_SUGGEST_MS)
}

/** 보관함 찾기 — 이름 · 폴더 · 메모, 대소문자 무시. 최근 보관한 것 먼저 */
export function searchArchive(state: AppState, query: string): Task[] {
  const q = query.trim().toLowerCase()
  return state.tasks
    .filter(isArchived)
    .filter((t) => !q || [t.name, t.cwd, t.host ?? '', ...(t.notes ?? []).map((n) => n.text)].some((s) => s.toLowerCase().includes(q)))
    .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0))
}

export interface DeletedTask {
  task: Task
  /** 이 모습을 가진 백업 이름 — 되살리기는 이 백업에서 */
  backup: string
  at: number
}
/** 최근 지운 것 — '지움' 백업들에서 지금 없는 일감을 모은다. 같은 일감은 가장 새 백업의 모습 하나, 30일 밖은 뺀다 */
export function recentlyDeleted(backups: ReadonlyArray<{ name: string; at: number; state: AppState }>, cur: AppState, now: number): DeletedTask[] {
  const have = new Set(cur.tasks.map((t) => t.id))
  const seen = new Map<Id, DeletedTask>()
  for (const b of [...backups].sort((x, y) => y.at - x.at)) {
    if (now - b.at > RECENT_DELETED_MS) continue
    for (const t of b.state.tasks) if (!have.has(t.id) && !seen.has(t.id)) seen.set(t.id, { task: t, backup: b.name, at: b.at })
  }
  return [...seen.values()]
}
