// 주간 정리 (25단계) — 19단계 명령 기록(가린 뒤)에서 한 주를 한 장으로. AI 토큰 칸은 원천이 없어 이번엔 없다(25단계 0절 스파이크)
import type { HistoryEntry } from './history'

const DAY = 24 * 3600 * 1000

/** 월요일 0시(그 시간대) 시작 한 주. tzOffsetMin 은 Date.getTimezoneOffset() 값(서울 -540). offset: 0 이번 주 · -1 앞 주 */
export function weekRange(now: number, tzOffsetMin: number, offset: number): { start: number; end: number } {
  const local = now - tzOffsetMin * 60_000
  const dayStart = Math.floor(local / DAY) * DAY
  const dow = (new Date(dayStart).getUTCDay() + 6) % 7 // 월 0 … 일 6
  const start = dayStart - dow * DAY + offset * 7 * DAY + tzOffsetMin * 60_000
  return { start, end: start + 7 * DAY }
}

export interface WeeklyRow {
  taskId: string
  name: string
  ms: number
  commands: number
  failed: number
}
export interface WeeklySummary {
  tasks: number
  ms: number
  commands: number
  failed: number
  /** 월~일, 명령이 돈 시간(ms) */
  days: number[]
  rows: WeeklyRow[]
  rest: { tasks: number; ms: number; commands: number } | null
  insight: string | null
}

const failed = (e: HistoryEntry) => e.code !== null && e.code !== 0

/** nameOf 가 null 이면(지운 일감) 뺀다 */
export function weeklySummary(list: readonly HistoryEntry[], range: { start: number; end: number }, nameOf: (taskId: string) => string | null): WeeklySummary {
  const by = new Map<string, WeeklyRow>()
  const days = [0, 0, 0, 0, 0, 0, 0]
  let ms = 0
  let commands = 0
  let fails = 0
  for (const e of list) {
    if (e.startedAt < range.start || e.startedAt >= range.end) continue
    const name = nameOf(e.taskId)
    if (name === null) continue
    const d = Math.max(0, e.endedAt - e.startedAt)
    const row = by.get(e.taskId) ?? { taskId: e.taskId, name, ms: 0, commands: 0, failed: 0 }
    row.ms += d
    row.commands++
    if (failed(e)) row.failed++
    by.set(e.taskId, row)
    days[Math.min(6, Math.floor((e.startedAt - range.start) / DAY))]! += d
    ms += d
    commands++
    if (failed(e)) fails++
  }
  const all = [...by.values()].sort((a, b) => b.ms - a.ms || b.commands - a.commands)
  const rows = all.slice(0, 5)
  const others = all.slice(5)
  const worst = [...all].sort((a, b) => b.failed - a.failed)[0]
  return {
    tasks: all.length,
    ms,
    commands,
    failed: fails,
    days,
    rows,
    rest: others.length ? { tasks: others.length, ms: others.reduce((s, r) => s + r.ms, 0), commands: others.reduce((s, r) => s + r.commands, 0) } : null,
    insight: worst && worst.failed > 0 ? `실패 ${fails}번 중 ${worst.failed}번이 ${worst.name}에서 났어요` : null,
  }
}

export function hours(ms: number): string {
  const h = ms / 3_600_000
  return h >= 10 ? `${Math.round(h)}h` : `${Math.round(h * 10) / 10}h`
}

/** '마크다운으로 복사' — 회고 · 주간 보고에 붙여 넣기 */
export function weeklyMarkdown(s: WeeklySummary, label: string): string {
  const lines = [
    `## 주간 정리 · ${label}`,
    '',
    `- 다룬 일감 ${s.tasks}개 · 터미널 시간 ${hours(s.ms)} · 명령 ${s.commands} · 실패 ${s.failed}`,
    ...(s.insight ? [`- ${s.insight}`] : []),
    '',
    '| 일감 | 시간 | 명령 | 실패 |',
    '|---|---|---|---|',
    ...s.rows.map((r) => `| ${r.name.replace(/\|/g, '\\|')} | ${hours(r.ms)} | ${r.commands} | ${r.failed} |`),
    ...(s.rest ? [`| 나머지 ${s.rest.tasks}개 일감 | ${hours(s.rest.ms)} | ${s.rest.commands} | |`] : []),
  ]
  return lines.join('\n') + '\n'
}
