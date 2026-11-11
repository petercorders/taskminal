// 상태 백업 규칙 (17단계 Backup). 순수 함수 — main 의 BackupStore 와 renderer 의 설정 › 백업이 함께 쓴다.
import { paneIds } from './layout'
import type { NewId } from './model'
import { redact } from './redact'
import type { AppState, Id, Layout, Settings, Task } from './types'

export type BackupReason = 'start' | 'version' | 'delete' | 'settings' | 'auto' | 'restore' | 'import' | 'recover'
export const BACKUP_REASONS: readonly BackupReason[] = ['start', 'version', 'delete', 'settings', 'auto', 'restore', 'import', 'recover']
export const REASON_LABEL: Record<BackupReason, string> = {
  start: '시작',
  version: '버전 올리기 전',
  delete: '지움',
  settings: '설정 바꿈',
  auto: '자동',
  restore: '되돌리기 전',
  import: '가져오기 전',
  recover: '복구',
}

export interface BackupEntry {
  name: string
  at: number
  reason: BackupReason
}

/** 목록 한 줄 — main 이 파일을 읽어 일감 수를 채운다 */
export interface BackupInfo extends BackupEntry {
  bytes: number
  tasks: number | null
}

const HOUR = 3_600_000
const DAY = 24 * HOUR
export const KEEP_ALL_MS = DAY
export const KEEP_DAILY_MS = 30 * DAY
export const KEEP_VERSION_MS = 90 * DAY
/** '설정 바꿈' 백업은 이 간격에 한 번까지 — 연달아 바꾸면 처음 모습이 남게 */
export const SETTINGS_BACKUP_GAP_MS = 10 * 60_000
/** 바뀐 게 있으면 이 주기로 '자동' */
export const AUTO_BACKUP_MS = HOUR

const two = (n: number, w = 2) => String(n).padStart(w, '0')
function stamp(at: number): string {
  const d = new Date(at)
  return `${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}T${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}${two(d.getUTCMilliseconds(), 3)}Z`
}

export const backupName = (at: number, reason: BackupReason): string => `state-${stamp(at)}-${reason}.json`

const NAME = /^state-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z-([a-z]+)\.json$/
/** 파일 이름 → 시각 · 이유. 모르는 모양(경로 · 다른 파일)은 null — 이 이름만 읽고 지운다 */
export function parseBackupName(name: string): BackupEntry | null {
  const m = NAME.exec(name)
  if (!m) return null
  const reason = m[8] as BackupReason
  if (!BACKUP_REASONS.includes(reason)) return null
  const [y, mo, d, h, mi, s, ms] = m.slice(1, 8).map(Number) as [number, number, number, number, number, number, number]
  const at = Date.UTC(y, mo - 1, d, h, mi, s, ms)
  return Number.isFinite(at) && stamp(at) === name.slice(6, 25) ? { name, at, reason } : null
}

/** 이 Mac 시간대의 날짜 열쇠. tzOffsetMin = Date#getTimezoneOffset (서울 -540) */
export const dayKey = (at: number, tzOffsetMin: number): string => new Date(at - tzOffsetMin * 60_000).toISOString().slice(0, 10)

/**
 * 보존 규칙 — 지울 이름. 24시간 안은 모두 · 30일 안은 하루 하나(그날 마지막) · '버전 올리기 전' 은 90일 · 가장 새 것은 언제나.
 */
export function pruneBackups(entries: readonly BackupEntry[], now: number, tzOffsetMin: number): string[] {
  const sorted = [...entries].sort((a, b) => b.at - a.at)
  const days = new Set<string>()
  const drop: string[] = []
  sorted.forEach((e, i) => {
    const age = now - e.at
    if (i === 0 || age <= KEEP_ALL_MS) return
    if (e.reason === 'version' && age <= KEEP_VERSION_MS) return
    if (age <= KEEP_DAILY_MS) {
      const key = dayKey(e.at, tzOffsetMin)
      if (!days.has(key)) {
        days.add(key)
        return
      }
    }
    drop.push(e.name)
  })
  return drop
}

export type BackupGroupId = 'today' | 'yesterday' | 'week' | 'older'
const GROUP_TITLE: Record<BackupGroupId, string> = { today: '오늘', yesterday: '어제', week: '이번 주', older: '그 전' }

/** 목록 묶음 — 새 것부터. 빈 묶음은 뺀다 */
export function groupBackups<T extends BackupEntry>(entries: readonly T[], now: number, tzOffsetMin: number): Array<{ id: BackupGroupId; title: string; items: T[] }> {
  const today = dayKey(now, tzOffsetMin)
  const yesterday = dayKey(now - DAY, tzOffsetMin)
  const groups: Record<BackupGroupId, T[]> = { today: [], yesterday: [], week: [], older: [] }
  for (const e of [...entries].sort((a, b) => b.at - a.at)) {
    const key = dayKey(e.at, tzOffsetMin)
    const id: BackupGroupId = key === today ? 'today' : key === yesterday ? 'yesterday' : now - e.at <= 7 * DAY ? 'week' : 'older'
    groups[id].push(e)
  }
  return (Object.keys(groups) as BackupGroupId[]).filter((id) => groups[id].length > 0).map((id) => ({ id, title: GROUP_TITLE[id], items: groups[id] }))
}

/** 설정에서 사이드바 묶음 접기처럼 '모습' 만 바꾸는 것은 백업 이유로 치지 않는다 */
function settingsKey(s: Settings): string {
  return JSON.stringify({ ...s, groups: s.groups.map((g) => ({ id: g.id, name: g.name })) })
}

/**
 * main 이 새 상태를 쓰기 직전에 — 직전 상태(prev)와 비교해 백업할 이유. 일감 · 탭이 사라짐 = 지움, 설정이 바뀜 = 설정.
 */
export function backupReasonFor(prev: AppState | null, next: AppState): 'delete' | 'settings' | null {
  if (!prev) return null
  const nextTasks = new Set(next.tasks.map((t) => t.id))
  const nextTabs = new Set(next.tasks.flatMap((t) => t.tabs.map((tab) => tab.id)))
  if (prev.tasks.some((t) => !nextTasks.has(t.id) || t.tabs.some((tab) => !nextTabs.has(tab.id)))) return 'delete'
  return settingsKey(prev.settings) === settingsKey(next.settings) ? null : 'settings'
}

// ─── 미리 보기 ───────────────────────────────────────────

export interface TaskLine {
  id: Id
  name: string
  tabs: number
}
export interface StateDiff {
  /** 백업에만 있음 — 되돌리면 다시 생김 */
  back: TaskLine[]
  /** 지금만 있음 — 전체 되돌리기면 사라짐 */
  gone: TaskLine[]
  /** 둘 다 있지만 이름 · 탭이 다름 */
  changed: Array<TaskLine & { tabsNow: number; nameNow: string }>
  /** 바뀐 설정 칸 이름 */
  settings: string[]
  templates: { back: string[]; gone: string[] }
  same: boolean
}

const SETTING_LABEL: Partial<Record<keyof Settings, string>> = {
  statuses: '상태',
  groups: '묶음',
  templates: '템플릿',
  fontSize: '글자 크기',
  shell: '셸',
  startup: '앱을 열 때',
  theme: '테마',
  accent: '강조색',
  keys: '단축키',
  notify: '알림',
  restoreScrollback: '이전 출력 되살리기',
  maskScreen: '화면에서 비밀값 가리기',
  secretAllow: '가리지 않기로 한 값',
  secretCustom: '내 종류',
}

const line = (t: Task): TaskLine => ({ id: t.id, name: t.name, tabs: t.tabs.length })

export function diffStates(cur: AppState, snap: AppState): StateDiff {
  const curById = new Map(cur.tasks.map((t) => [t.id, t]))
  const snapIds = new Set(snap.tasks.map((t) => t.id))
  const back: TaskLine[] = []
  const changed: StateDiff['changed'] = []
  for (const t of snap.tasks) {
    const now = curById.get(t.id)
    if (!now) back.push(line(t))
    else if (now.name !== t.name || JSON.stringify(now.tabs) !== JSON.stringify(t.tabs)) changed.push({ ...line(t), tabsNow: now.tabs.length, nameNow: now.name })
  }
  const gone = cur.tasks.filter((t) => !snapIds.has(t.id)).map(line)
  const keys = new Set([...Object.keys(cur.settings), ...Object.keys(snap.settings)]) as Set<keyof Settings>
  const settings: string[] = []
  for (const k of keys) {
    if (JSON.stringify(cur.settings[k]) !== JSON.stringify(snap.settings[k])) settings.push(SETTING_LABEL[k] ?? k)
  }
  const curTpl = new Set(cur.settings.templates.map((t) => t.id))
  const snapTpl = new Set(snap.settings.templates.map((t) => t.id))
  const templates = {
    back: snap.settings.templates.filter((t) => !curTpl.has(t.id)).map((t) => t.name),
    gone: cur.settings.templates.filter((t) => !snapTpl.has(t.id)).map((t) => t.name),
  }
  return { back, gone, changed, settings, templates, same: back.length + gone.length + changed.length + settings.length === 0 }
}

// ─── 되살리기 ────────────────────────────────────────────

export interface Restored {
  state: AppState
  /** 결과에서 사라지는 pane — renderer 가 셸을 끝낸다 */
  kill: Id[]
}

const allPanes = (s: AppState): Id[] => s.tasks.flatMap((t) => Object.keys(t.panes))

function mapLayout(l: Layout, ids: Map<Id, Id>): Layout {
  return l.type === 'pane' ? { type: 'pane', paneId: ids.get(l.paneId) ?? l.paneId } : { ...l, a: mapLayout(l.a, ids), b: mapLayout(l.b, ids) }
}

/** 다른 일감과 겹치는 탭 · pane id 를 새 id 로 — pty 하나를 두 화면이 나눠 쓰지 않게 */
function freshIds(task: Task, usedTabs: Set<Id>, usedPanes: Set<Id>, newId: NewId): Task {
  const paneMap = new Map<Id, Id>()
  for (const id of Object.keys(task.panes)) if (usedPanes.has(id)) paneMap.set(id, newId())
  const tabMap = new Map<Id, Id>()
  for (const tab of task.tabs) if (usedTabs.has(tab.id)) tabMap.set(tab.id, newId())
  if (paneMap.size === 0 && tabMap.size === 0) return task
  const panes: Task['panes'] = {}
  for (const [id, p] of Object.entries(task.panes)) {
    const nid = paneMap.get(id) ?? id
    panes[nid] = { ...p, id: nid }
  }
  const tabs = task.tabs.map((tab) => ({ ...tab, id: tabMap.get(tab.id) ?? tab.id, layout: mapLayout(tab.layout, paneMap), activePaneId: paneMap.get(tab.activePaneId) ?? tab.activePaneId }))
  return { ...task, panes, tabs, activeTabId: task.activeTabId ? (tabMap.get(task.activeTabId) ?? task.activeTabId) : null }
}

/** 일감이 가리키는 상태 · 묶음이 지금 설정에 없으면 가져온 쪽 설정에서 더한다(없으면 첫 상태 · 묶음 없음) */
function bringRefs(settings: Settings, task: Task, from: Settings): { settings: Settings; task: Task } {
  let s = settings
  let t = task
  if (!s.statuses.some((x) => x.id === t.statusId)) {
    const st = from.statuses.find((x) => x.id === t.statusId)
    if (st) s = { ...s, statuses: [...s.statuses, st] }
    else t = { ...t, statusId: s.statuses[0]!.id }
  }
  if (t.groupId !== null && !s.groups.some((g) => g.id === t.groupId)) {
    const g = from.groups.find((x) => x.id === t.groupId)
    if (g) s = { ...s, groups: [...s.groups, g] }
    else t = { ...t, groupId: null }
  }
  return { settings: s, task: t }
}

/**
 * 일감 하나만 되살린다. 지금 있으면 그 자리에서 바꾸고, 없으면 백업의 순서 자리에(지금 목록 길이를 넘지 않게).
 * 되살린 일감을 연다. 없는 일감이면 null.
 */
export function restoreTask(cur: AppState, snap: AppState, taskId: Id, newId: NewId): Restored | null {
  const from = snap.tasks.find((t) => t.id === taskId)
  if (!from) return null
  const at = cur.tasks.findIndex((t) => t.id === taskId)
  const others = cur.tasks.filter((t) => t.id !== taskId)
  const usedTabs = new Set(others.flatMap((t) => t.tabs.map((tab) => tab.id)))
  const usedPanes = new Set(others.flatMap((t) => Object.keys(t.panes)))
  const fixed = bringRefs(cur.settings, freshIds(from, usedTabs, usedPanes, newId), snap.settings)
  const tasks = [...others]
  tasks.splice(at >= 0 ? at : Math.min(snap.tasks.indexOf(from), others.length), 0, fixed.task)
  const keep = new Set(Object.keys(fixed.task.panes))
  const kill = at >= 0 ? Object.keys(cur.tasks[at]!.panes).filter((id) => !keep.has(id)) : []
  return { state: { ...cur, settings: fixed.settings, tasks, activeTaskId: fixed.task.id }, kill }
}

/** 이 시점으로 모두 — 설정까지 백업 그대로. 지금만 있는 pane 의 셸은 끝낸다 */
export function restoreAll(cur: AppState, snap: AppState): Restored {
  const keep = new Set(allPanes(snap))
  return { state: snap, kill: allPanes(cur).filter((id) => !keep.has(id)) }
}

/** 가져오기 '합치기' — 없는 일감 · 템플릿 · 상태 · 묶음만 더한다. 겹치는 탭 · pane id 는 새 id */
export function mergeState(cur: AppState, incoming: AppState, newId: NewId): { state: AppState; added: number } {
  let settings: Settings = {
    ...cur.settings,
    statuses: [...cur.settings.statuses, ...incoming.settings.statuses.filter((s) => !cur.settings.statuses.some((c) => c.id === s.id))],
    groups: [...cur.settings.groups, ...incoming.settings.groups.filter((g) => !cur.settings.groups.some((c) => c.id === g.id))],
    templates: [...cur.settings.templates, ...incoming.settings.templates.filter((t) => !cur.settings.templates.some((c) => c.id === t.id))],
  }
  const tasks = [...cur.tasks]
  const usedTabs = new Set(tasks.flatMap((t) => t.tabs.map((tab) => tab.id)))
  const usedPanes = new Set(allPanes(cur))
  let added = 0
  for (const t of incoming.tasks) {
    if (tasks.some((c) => c.id === t.id)) continue
    const fixed = bringRefs(settings, freshIds(t, usedTabs, usedPanes, newId), incoming.settings)
    settings = fixed.settings
    for (const tab of fixed.task.tabs) usedTabs.add(tab.id)
    for (const id of Object.keys(fixed.task.panes)) usedPanes.add(id)
    tasks.push(fixed.task)
    added++
  }
  return { state: { ...cur, settings, tasks }, added }
}

/** 내보내기 글 — 상태 JSON 을 가린 것(명령 · 이름 속 키도). 출력 · 스크롤은 상태에 없다 */
export function exportText(state: AppState): string {
  return redact(JSON.stringify(state, null, 2)) + '\n'
}

/** 일감이 쓰는 pane 수 (확인 창 글) */
export const paneCount = (tasks: readonly Task[]): number => tasks.reduce((n, t) => n + t.tabs.reduce((m, tab) => m + paneIds(tab.layout).length, 0), 0)
