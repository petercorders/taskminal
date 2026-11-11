// 오류 기록(18단계)의 순수 규칙 — 줄 모양 · 읽기 · 묶기 · 파일 이름 · 보존.
// 기록은 이 Mac 에만(~/Library/Logs/Taskminal) — 밖으로 보내지 않는다. 터미널 출력은 넣지 않는다.

export type LogLevel = 'error' | 'warn'
export interface LogEntry {
  t: number
  level: LogLevel
  /** 같은 오류를 묶는 이름 (state-save · pty-spawn …) */
  key: string
  /** 사용자 말 */
  msg: string
  /** 원문 (오류 코드 · 메시지) */
  detail?: string
}
/** 화면의 한 줄 — 같은 오류를 묶은 것. t = 마지막 */
export interface LogRow extends LogEntry {
  count: number
  first: number
}

export const LOG_KEEP_DAYS = 7
/** 기록 폴더 전체 상한 — 넘으면 오늘은 더 쓰지 않는다 */
export const LOG_MAX_BYTES = 5 * 1024 * 1024
const DAY = 24 * 60 * 60 * 1000
const MAX_TEXT = 2000

const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const NAME = /^main-(\d{4})-(\d{2})-(\d{2})\.log$/

export const logFileName = (t: number): string => `main-${ymd(t)}.log`
export const isLogFileName = (name: string): boolean => NAME.test(name)

/** 7일 지난 기록 파일 — 날짜(이 Mac 시간대) 기준. 모르는 이름은 넣지 않는다 */
export function expiredLogFiles(names: readonly string[], now: number): string[] {
  const today = new Date(now)
  const keepFrom = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (LOG_KEEP_DAYS - 1)).getTime()
  return names.filter((n) => {
    const m = NAME.exec(n)
    return m !== null && new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() < keepFrom
  })
}

const cut = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s)
export const logLine = (e: LogEntry): string =>
  JSON.stringify({ t: e.t, level: e.level, key: cut(e.key), msg: cut(e.msg), ...(e.detail ? { detail: cut(e.detail) } : {}) }) + '\n'

/** 기록 파일 글 → 줄들. JSON 이 아니거나 모양이 틀린 줄은 버린다 */
export function parseLog(text: string): LogEntry[] {
  const out: LogEntry[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let v: unknown
    try {
      v = JSON.parse(line)
    } catch {
      continue
    }
    const o = (v ?? {}) as Record<string, unknown>
    if (typeof o['t'] !== 'number' || (o['level'] !== 'error' && o['level'] !== 'warn') || typeof o['key'] !== 'string' || typeof o['msg'] !== 'string') continue
    out.push({ t: o['t'], level: o['level'], key: o['key'], msg: o['msg'], ...(typeof o['detail'] === 'string' ? { detail: o['detail'] } : {}) })
  }
  return out
}

/** 최근 7일 · 같은 level+key+msg 를 한 줄로(횟수 · 처음 · 마지막 원문), 최근 것부터 */
export function groupLog(entries: readonly LogEntry[], now: number, level?: LogLevel): LogRow[] {
  const rows = new Map<string, LogRow>()
  for (const e of entries) {
    if (e.t < now - LOG_KEEP_DAYS * DAY || (level && e.level !== level)) continue
    const id = `${e.level}\u0000${e.key}\u0000${e.msg}`
    const r = rows.get(id)
    if (!r) rows.set(id, { ...e, count: 1, first: e.t })
    else {
      r.count++
      r.first = Math.min(r.first, e.t)
      if (e.t >= r.t) {
        r.t = e.t
        if (e.detail) r.detail = e.detail
        else delete r.detail
      }
    }
  }
  return [...rows.values()].sort((a, b) => b.t - a.t)
}

/** [복사] — 사용자 말 + 원문 + 횟수 · 마지막 시각 */
export function copyText(r: LogRow): string {
  const d = new Date(r.t)
  const when = `${ymd(r.t)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  return [r.msg, r.detail, `${r.level === 'error' ? '오류' : '경고'} · ${r.count}번 · 마지막 ${when}`].filter(Boolean).join('\n')
}
