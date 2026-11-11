import { describe, expect, it } from 'vitest'
import { weekRange, weeklySummary, weeklyMarkdown } from '../../src/shared/weekly'
import type { HistoryEntry } from '../../src/shared/history'

// 시간대 0 으로 계산 — 2026-11-09 은 월요일
const MON = Date.UTC(2026, 10, 9)
const H = 3600 * 1000
let n = 0
function e(taskId: string, at: number, ms: number, code: number | null): HistoryEntry {
  return { id: `h${++n}`, taskId, paneId: 'p', cmd: 'x', cwd: '/', startedAt: at, endedAt: at + ms, code, tail: [] }
}
const names = (id: string) => ({ a: 'A 일감', b: 'B 일감', c: 'C', d: 'D', e: 'E', f: 'F' })[id] ?? null

describe('weekRange', () => {
  it('월요일 0시 시작 · 7일, offset 으로 앞 주', () => {
    expect(weekRange(MON + 3 * 24 * H + 5 * H, 0, 0)).toEqual({ start: MON, end: MON + 7 * 24 * H })
    expect(weekRange(MON + 1, 0, -1)).toEqual({ start: MON - 7 * 24 * H, end: MON })
    // 일요일 밤은 그 주
    expect(weekRange(MON + 7 * 24 * H - 1, 0, 0).start).toBe(MON)
  })
  it('시간대(분, getTimezoneOffset 과 같은 부호) — 서울(-540) 의 월요일 0시는 UTC 일요일 15시', () => {
    expect(weekRange(MON + 10 * H, -540, 0).start).toBe(MON - 9 * H)
  })
})

describe('weeklySummary', () => {
  const list = [
    e('a', MON + 1 * H, 2 * H, 0),
    e('a', MON + 3 * H, 1 * H, 1),
    e('a', MON + 24 * H, 30 * 60 * 1000, 2),
    e('b', MON + 2 * 24 * H, 1 * H, 0),
    e('c', MON + 2 * 24 * H, 60_000, 0),
    e('d', MON + 3 * 24 * H, 60_000, 0),
    e('e', MON + 4 * 24 * H, 60_000, 0),
    e('f', MON + 5 * 24 * H, 60_000, null),
    e('a', MON - 1, 60_000, 1), // 앞 주 — 빠짐
    e('gone', MON + 6 * 24 * H, 60_000, 1), // 지운 일감 — 이름이 없으면 빠짐
  ]
  const s = weeklySummary(list, { start: MON, end: MON + 7 * 24 * H }, names)
  it('칸 4개 — 다룬 일감 · 터미널 시간 · 명령 · 실패(null 은 실패 아님)', () => {
    expect(s.tasks).toBe(6)
    expect(s.commands).toBe(8)
    expect(s.failed).toBe(2)
    expect(s.ms).toBe(2 * H + H + 30 * 60_000 + H + 4 * 60_000)
  })
  it('요일별 시간(월~일)', () => {
    expect(s.days).toHaveLength(7)
    expect(s.days[0]).toBe(3 * H)
    expect(s.days[6]).toBe(0)
  })
  it('일감 표는 시간 많은 순 상위 5 + 나머지', () => {
    expect(s.rows.map((r) => r.name)).toEqual(['A 일감', 'B 일감', 'C', 'D', 'E'])
    expect(s.rows[0]).toMatchObject({ commands: 3, failed: 2 })
    expect(s.rest).toEqual({ tasks: 1, ms: 60_000, commands: 1 })
  })
  it('맨 위 한 줄 — 실패가 몰린 일감, 실패가 없으면 null', () => {
    expect(s.insight).toBe('실패 2번 중 2번이 A 일감에서 났어요')
    expect(weeklySummary([e('b', MON, 1, 0)], { start: MON, end: MON + 7 * 24 * H }, names).insight).toBeNull()
  })
  it('빈 주', () => {
    const z = weeklySummary([], { start: MON, end: MON + 7 * 24 * H }, names)
    expect(z).toMatchObject({ tasks: 0, commands: 0, failed: 0, ms: 0, rows: [], rest: null, insight: null })
  })
  it('마크다운 — 제목 · 칸 · 표', () => {
    const md = weeklyMarkdown(s, '11월 9일 – 15일')
    expect(md).toContain('## 주간 정리 · 11월 9일 – 15일')
    expect(md).toContain('| 일감 | 시간 | 명령 | 실패 |')
    expect(md).toContain('| A 일감 | 3.5h | 3 | 2 |')
    expect(md).toContain('나머지 1개 일감')
  })
})
