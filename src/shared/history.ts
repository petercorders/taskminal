// 명령 기록 (19단계) — 셸 통합 신호(OSC 133 C/D · 6973 · 7)로 끝난 명령마다 한 줄. 순수 함수.
// 저장은 main(HistoryStore — <userData>/history/<taskId>.jsonl, 가린 뒤), 화면은 history-ui.tsx.

export interface HistoryEntry {
  id: string
  taskId: string
  paneId: string
  cmd: string
  cwd: string
  startedAt: number
  endedAt: number
  /** 셸이 알려 준 종료 코드 — 코드 없이 끝났으면 null */
  code: number | null
  /** 끝날 때의 마지막 출력(최대 20줄, 가린 뒤) */
  tail: string[]
}

export const HISTORY_MAX = 5000
export const HISTORY_DAYS = 90
export const CMD_MAX = 8192
export const TAIL_LINES = 20
export const TAIL_LINE_MAX = 1024
/** '짧은 명령 숨기기' — 이보다 빨리 성공한 명령 */
export const SHORT_MS = 500
/** 하루에 처음 보이는 줄 수 — 넘으면 '이날 더 보기 (n)' */
export const DAY_LIMIT = 50

const DAY = 24 * 60 * 60 * 1000
const ID = /^[A-Za-z0-9_-]{1,128}$/
export const isHistoryId = (v: unknown): v is string => typeof v === 'string' && ID.test(v)
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

/** renderer 가 보낸 값 · 파일에서 읽은 줄 — 모양이 틀리면 null, 꼬리는 잘라서 받는다 */
export function parseEntry(v: unknown): HistoryEntry | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (!isHistoryId(o.id) || !isHistoryId(o.taskId) || !isHistoryId(o.paneId)) return null
  if (typeof o.cmd !== 'string' || o.cmd.trim() === '' || o.cmd.length > CMD_MAX) return null
  if (typeof o.cwd !== 'string' || o.cwd.length > CMD_MAX) return null
  if (!isTime(o.startedAt) || !isTime(o.endedAt) || o.endedAt < o.startedAt) return null
  if (o.code !== null && !Number.isInteger(o.code)) return null
  if (!Array.isArray(o.tail)) return null
  const tail = o.tail.filter((l): l is string => typeof l === 'string').slice(-TAIL_LINES).map((l) => l.slice(0, TAIL_LINE_MAX))
  return { id: o.id, taskId: o.taskId, paneId: o.paneId, cmd: o.cmd, cwd: o.cwd, startedAt: o.startedAt, endedAt: o.endedAt, code: o.code as number | null, tail }
}

const byEnd = (a: HistoryEntry, b: HistoryEntry) => a.endedAt - b.endedAt

/** 90일 넘은 것을 버리고 최근 5,000개 — 끝난 시각 순(오래된 것 먼저) */
export function prune(entries: readonly HistoryEntry[], now: number): HistoryEntry[] {
  const kept = entries.filter((e) => now - e.endedAt <= HISTORY_DAYS * DAY).sort(byEnd)
  return kept.length > HISTORY_MAX ? kept.slice(kept.length - HISTORY_MAX) : kept
}

/** 처음 읽은 목록 + 그 사이 생긴 줄 — 같은 id 는 한 번, 끝난 시각 순 */
export function mergeEntries(a: readonly HistoryEntry[], b: readonly HistoryEntry[]): HistoryEntry[] {
  const seen = new Map<string, HistoryEntry>()
  for (const e of [...a, ...b]) if (!seen.has(e.id)) seen.set(e.id, e)
  return [...seen.values()].sort(byEnd)
}

/** 저장 전에 가린 자리(‹가림:종류›)가 든 명령 — 그대로 다시 실행하면 원래 값이 아니라 가린 글자가 들어간다 */
export const hasMask = (cmd: string): boolean => cmd.includes('‹가림:')

/**
 * 입력줄에 넣기만 해도 되는가 — xterm 의 붙여넣기는 \n 을 \r 로 바꿔 보내므로, 셸이 괄호 붙여넣기(2004)를 켜지 않았으면
 * 여러 줄 명령의 줄바꿈이 그대로 실행된다. 한 줄은 ↩ 가 없어 늘 안전
 */
export const safeToInsert = (text: string, bracketedPaste: boolean): boolean => bracketedPaste || !/[\r\n]/.test(text)

export const isFailed = (e: Pick<HistoryEntry, 'code'>): boolean => e.code !== null && e.code !== 0

export type HistoryScope = 'pane' | 'task' | 'all'
export const HISTORY_SCOPES: readonly HistoryScope[] = ['pane', 'task', 'all']
export const HISTORY_SCOPE_LABEL: Record<HistoryScope, string> = { pane: '이 pane', task: '이 일감', all: '모든 일감' }

export interface HistoryFilter {
  scope: HistoryScope
  taskId: string | null
  paneId: string | null
  failedOnly: boolean
  hideShort: boolean
  query: string
}

/** 범위 · 거르기 · 찾기(명령 · 폴더 글자) — 최근 것부터 */
export function filterHistory(entries: readonly HistoryEntry[], f: HistoryFilter): HistoryEntry[] {
  const q = f.query.trim().toLowerCase()
  const out = entries.filter((e) => {
    if (f.scope === 'task' && e.taskId !== f.taskId) return false
    if (f.scope === 'pane' && e.paneId !== f.paneId) return false
    if (f.failedOnly && !isFailed(e)) return false
    if (f.hideShort && !isFailed(e) && e.endedAt - e.startedAt < SHORT_MS) return false
    if (q && !e.cmd.toLowerCase().includes(q) && !e.cwd.toLowerCase().includes(q)) return false
    return true
  })
  return out.sort((a, b) => b.endedAt - a.endedAt)
}

const pad = (n: number) => String(n).padStart(2, '0')
const WEEK = ['일', '월', '화', '수', '목', '금', '토']
const dayKey = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** '오늘 · 11-11' · '어제 · 11-10' · '11-09 (월)' (이 Mac 시간대) */
export function dayLabel(t: number, now: number): string {
  const d = new Date(t)
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  if (dayKey(t) === dayKey(now)) return `오늘 · ${md}`
  if (dayKey(t) === dayKey(now - DAY)) return `어제 · ${md}`
  return `${md} (${WEEK[d.getDay()]})`
}

export interface HistoryDay {
  key: string
  label: string
  rows: HistoryEntry[]
  /** 접혀 있는 줄 수 ('이날 더 보기 (n)') */
  more: number
  /** 그날 줄이 모두 앱을 다시 켜기 전 것 */
  prev: boolean
}

/** 최근 것부터 온 줄을 날마다 묶는다 — 펼친 날(expanded)이 아니면 50줄까지 */
export function groupByDay(entries: readonly HistoryEntry[], now: number, expanded: ReadonlySet<string>, isPrev: (e: HistoryEntry) => boolean): HistoryDay[] {
  const days: Array<{ key: string; all: HistoryEntry[] }> = []
  for (const e of entries) {
    const key = dayKey(e.endedAt)
    const last = days[days.length - 1]
    if (last && last.key === key) last.all.push(e)
    else days.push({ key, all: [e] })
  }
  return days.map(({ key, all }) => {
    const open = expanded.has(key)
    const rows = open ? all : all.slice(0, DAY_LIMIT)
    return { key, label: dayLabel(all[0]!.endedAt, now), rows, more: all.length - rows.length, prev: all.every(isPrev) }
  })
}

/** 끝날 때 뜬 줄들 → 끝 공백 · 끝 빈 줄을 버린 마지막 20줄 */
export function tailLines(lines: readonly string[]): string[] {
  const out = lines.map((l) => l.trimEnd())
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out.slice(-TAIL_LINES).map((l) => l.slice(0, TAIL_LINE_MAX))
}
