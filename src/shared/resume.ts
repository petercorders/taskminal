// 이어받기 요약 (24단계) — 오래 안 본 일감을 열면 '그 사이 일' 을 규칙으로 모은 카드. AI 없이 사실만.
// 맨 위 한 줄 = 확인 필요 → 에이전트 인계 메모 → 내 첫 할 일. 아래 목록 = 확인 필요 → 실패 → 실행 중 → 에이전트 말 → 바뀐 파일 → 끝난 명령 · 할 일.
import { formatDuration, type PaneActivity } from './activity'
import type { HistoryEntry } from './history'
import { hasPane } from './layout'
import { tabLabel } from './model'
import type { Id, Task } from './types'

export const RESUME_LINES = 5

export type FactKind = 'attention' | 'failed' | 'running' | 'agent' | 'note' | 'changed' | 'done' | 'todo'
/** ↩ 로 갈 곳 */
export type FactGo = { to: 'pane'; paneId: Id } | { to: 'review' } | { to: 'notes' } | { to: 'history' }

export interface Fact {
  kind: FactKind
  text: string
  sub?: string
  go: FactGo
  /** 단추 이름 — 터미널 보기 · 대화 보기 · 변경 보기 · 메모 열기 · 기록 보기 */
  button: string
}

export interface ResumeInput {
  task: Task
  now: number
  /** 마지막으로 본 때 — 이 뒤의 일만 '새 사실' */
  since: number
  activity: Readonly<Record<string, PaneActivity>>
  /** 명령 기록 (가린 것) */
  history: readonly HistoryEntry[]
  /** 그 사이 턴이 끝난 대화 pane 의 마지막 글 (가린 것) */
  chats: ReadonlyArray<{ paneId: Id; text: string }>
  /** 변경 검토의 바뀐 파일 수 (모르면 undefined) */
  changed?: number
  /** 화면에 보이는 명령 · 알림 글 가리기 */
  mask?: (s: string) => string
}

export interface ResumeCard {
  top: Fact | null
  facts: Fact[]
  /** 5줄 넘어 못 보인 수 */
  more: number
  /** 그 사이 새로 생긴 사실이 있나 (카드를 띄울지) */
  fresh: boolean
  awayMs: number
}

const cut = (s: string, n = 120) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

function where(task: Task, paneId: Id): string {
  const tab = task.tabs.find((t) => hasPane(t.layout, paneId))
  return tab ? tabLabel(task, tab) : ''
}

function paneGo(task: Task, paneId: Id): { go: FactGo; button: string } {
  return { go: { to: 'pane', paneId }, button: task.panes[paneId]?.kind === 'chat' ? '대화 보기' : '터미널 보기' }
}

export function resumeCard(input: ResumeInput): ResumeCard {
  const { task, since, now } = input
  const mask = input.mask ?? ((s: string) => s)
  const paneIds = Object.keys(task.panes)
  const list: Fact[] = []

  const attention = paneIds.filter((id) => input.activity[id]?.attention)
  for (const id of attention) {
    const a = input.activity[id]!
    const failedHere = a.state === 'failed'
    list.push({ kind: 'attention', text: `확인 필요 · ${where(task, id)}`, sub: failedHere ? `${a.command ? cut(mask(a.command)) + ' · ' : ''}exit ${a.exitCode ?? '?'}` : a.message ? cut(mask(a.message)) : '입력을 기다려요', ...paneGo(task, id) })
  }
  const mine = input.history.filter((e) => e.taskId === task.id && e.endedAt !== null && e.endedAt > since)
  const failed = mine.filter((e) => e.code !== null && e.code !== 0)
  // 확인 필요로 이미 올린 pane 의 마지막 실패는 겹치지 않게
  for (const e of failed.slice().reverse()) {
    if (attention.includes(e.paneId) && input.activity[e.paneId]?.state === 'failed') continue
    list.push({ kind: 'failed', text: `실패 · ${cut(e.cmd)}`, sub: `exit ${e.code} · ${where(task, e.paneId) || '닫힌 pane'}`, ...(task.panes[e.paneId] ? paneGo(task, e.paneId) : { go: { to: 'history' }, button: '기록 보기' }) })
  }
  for (const id of paneIds) {
    const a = input.activity[id]
    if (!a?.busy || attention.includes(id)) continue
    list.push({ kind: 'running', text: `실행 중 · ${a.command ? cut(mask(a.command)) : where(task, id)}`, sub: a.startedAt !== undefined ? `${formatDuration(now - a.startedAt)}째 · ${where(task, id)}` : where(task, id), ...paneGo(task, id) })
  }
  for (const c of input.chats) {
    if (!c.text.trim() || !task.panes[c.paneId]) continue
    list.push({ kind: 'agent', text: `에이전트 · ${cut(c.text.split('\n').filter(Boolean).at(-1) ?? c.text)}`, sub: where(task, c.paneId), ...paneGo(task, c.paneId) })
  }
  const agentNotes = (task.notes ?? []).filter((n) => n.by === 'agent' && !n.done && n.at > since)
  for (const n of agentNotes.slice().reverse()) list.push({ kind: 'note', text: `에이전트가 남김 · ${cut(n.text)}`, go: { to: 'notes' }, button: '메모 열기' })
  if (input.changed !== undefined && input.changed > 0) list.push({ kind: 'changed', text: `바뀐 파일 ${input.changed}개`, sub: '커밋하지 않은 변경', go: { to: 'review' }, button: '변경 보기' })
  const ok = mine.filter((e) => e.code === 0)
  if (ok.length > 0) list.push({ kind: 'done', text: `끝난 명령 ${ok.length}개`, sub: `마지막 · ${cut(ok.at(-1)!.cmd)}`, go: { to: 'history' }, button: '기록 보기' })
  const todos = (task.notes ?? []).filter((n) => n.by !== 'agent' && !n.done)
  if (todos.length > 0) list.push({ kind: 'todo', text: `할 일 · ${cut(todos[0]!.text)}`, ...(todos.length > 1 ? { sub: `외 ${todos.length - 1}개` } : {}), go: { to: 'notes' }, button: '메모 열기' })

  // 맨 위: 확인 필요 → 에이전트 인계 메모(가장 최근) → 내 첫 할 일. 올린 줄은 아래에서 뺀다
  const top = list.find((f) => f.kind === 'attention') ?? list.find((f) => f.kind === 'note') ?? list.find((f) => f.kind === 'todo') ?? null
  const rest = list.filter((f) => f !== top)
  const facts = rest.slice(0, RESUME_LINES)
  const fresh = attention.length > 0 || mine.length > 0 || input.chats.some((c) => c.text.trim() !== '') || agentNotes.length > 0
  return { top, facts, more: rest.length - facts.length, fresh, awayMs: Math.max(0, now - since) }
}

/** 카드를 띄울까 — 켜져 있고 · 본 적이 있고 · 그 뒤 기준(분) 넘게 지났고 · 새 사실이 있을 때 */
export function shouldShowResume(task: Task, now: number, afterMs: number, enabled: boolean): boolean {
  return enabled && task.lastViewedAt !== undefined && now - task.lastViewedAt >= afterMs
}
