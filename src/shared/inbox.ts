// 66단계 알림 받은편지함 — 지난 알림(입력 기다림 · 끝남 · 실패 · 셸 닫힘)의 기록. main(파일) · renderer(화면)가 함께 쓰는 순수 규칙.
import type { NotifyKind } from './types'

/** 남기는 알림 수 상한 */
export const INBOX_MAX = 300
/** 이보다 오래된 알림은 버린다 */
export const INBOX_DAYS = 30
const DAY = 24 * 60 * 60 * 1000
/** 제목 · 본문 글자 수 상한 — 넘으면 자른다(명령 글이 길어도 기록이 버려지지 않게) */
export const INBOX_TITLE_MAX = 200
export const INBOX_BODY_MAX = 2000
const KINDS: readonly NotifyKind[] = ['wait', 'long', 'fail', 'exit']

export interface InboxEntry {
  /** renderer 가 만든 번호 — 같은 번호는 한 줄(다시 보냄) */
  id: string
  at: number
  kind: NotifyKind
  taskId: string
  paneId: string
  /** 알림 제목 · 본문(가린 글) */
  title: string
  body: string
  read: boolean
}

export const INBOX_TITLE: Record<NotifyKind, string> = {
  wait: '입력을 기다립니다',
  long: '명령이 끝났습니다',
  fail: '명령이 실패했습니다',
  exit: '셸이 닫혔습니다',
}

const ID = /^[\w-]{1,100}$/
/** id · 일감 · pane 번호 모양(IPC 검사도 이것을 쓴다) */
export const isInboxId = (v: unknown): v is string => typeof v === 'string' && ID.test(v)
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max

/** 비신뢰 값(파일 · IPC) → 항목. 모양이 다르면 null */
export function parseInboxEntry(v: unknown): InboxEntry | null {
  if (!v || typeof v !== 'object') return null
  const e = v as Record<string, unknown>
  if (typeof e['id'] !== 'string' || !ID.test(e['id'])) return null
  if (typeof e['at'] !== 'number' || !Number.isFinite(e['at']) || e['at'] < 0) return null
  if (!KINDS.includes(e['kind'] as NotifyKind)) return null
  if (typeof e['taskId'] !== 'string' || !ID.test(e['taskId']) || typeof e['paneId'] !== 'string' || !ID.test(e['paneId'])) return null
  if (!text(e['title'], INBOX_TITLE_MAX) || !text(e['body'], INBOX_BODY_MAX)) return null
  return { id: e['id'], at: e['at'], kind: e['kind'] as NotifyKind, taskId: e['taskId'], paneId: e['paneId'], title: e['title'], body: e['body'], read: e['read'] === true }
}

/** 새것부터 · 30일 안 · 300개까지 */
export function pruneInbox(entries: readonly InboxEntry[], now: number): InboxEntry[] {
  return entries
    .filter((e) => now - e.at <= INBOX_DAYS * DAY)
    .sort((a, b) => b.at - a.at)
    .slice(0, INBOX_MAX)
}

/** 같은 id 는 하나로 — 읽음은 어느 쪽이든 읽었으면 읽음(읽음이 안 읽음으로 돌아가지 않는다) */
export function mergeInbox(a: readonly InboxEntry[], b: readonly InboxEntry[], now: number): InboxEntry[] {
  const byId = new Map<string, InboxEntry>()
  for (const e of [...a, ...b]) {
    const prior = byId.get(e.id)
    byId.set(e.id, prior ? { ...prior, read: prior.read || e.read } : e)
  }
  return pruneInbox([...byId.values()], now)
}

export type InboxRead = { ids: string[] } | { paneId: string; until: number } | { all: true }

/** 읽음 표시 — id 들 · pane 하나의 그 시각까지 · 모두. 바뀐 것이 없으면 같은 배열을 돌려준다 */
export function markInboxRead(entries: readonly InboxEntry[], how: InboxRead): readonly InboxEntry[] {
  const hit = (e: InboxEntry) => ('all' in how ? true : 'ids' in how ? how.ids.includes(e.id) : e.paneId === how.paneId && e.at <= how.until)
  if (!entries.some((e) => !e.read && hit(e))) return entries
  return entries.map((e) => (!e.read && hit(e) ? { ...e, read: true } : e))
}

/** IPC 로 받은 읽음 표시 모양 검사 */
export function parseInboxRead(v: unknown): InboxRead | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  if (r['all'] === true) return { all: true }
  if (Array.isArray(r['ids'])) return r['ids'].length <= INBOX_MAX && r['ids'].every((id) => typeof id === 'string' && ID.test(id)) ? { ids: r['ids'] as string[] } : null
  if (typeof r['paneId'] === 'string' && ID.test(r['paneId']) && typeof r['until'] === 'number' && Number.isFinite(r['until'])) return { paneId: r['paneId'], until: r['until'] }
  return null
}

export const inboxUnread = (entries: readonly InboxEntry[]): number => entries.filter((e) => !e.read).length

export interface InboxApi {
  list(): Promise<InboxEntry[]>
  add(entry: InboxEntry): Promise<void>
  read(how: InboxRead): Promise<void>
  removeTask(taskId: string): Promise<void>
  clear(): Promise<void>
}
