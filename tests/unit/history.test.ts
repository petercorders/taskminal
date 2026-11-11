import { describe, expect, it } from 'vitest'
import {
  CMD_MAX,
  DAY_LIMIT,
  HISTORY_DAYS,
  HISTORY_MAX,
  dayLabel,
  filterHistory,
  groupByDay,
  isFailed,
  mergeEntries,
  parseEntry,
  prune,
  tailLines,
  TAIL_LINE_MAX,
  TAIL_LINES,
  type HistoryEntry,
} from '../../src/shared/history'

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date(2026, 10, 11, 14, 10).getTime()

let seq = 0
const entry = (p: Partial<HistoryEntry> = {}): HistoryEntry => ({
  id: `e${++seq}`,
  taskId: 't1',
  paneId: 'p1',
  cmd: 'npm test',
  cwd: '~/a',
  startedAt: NOW - 5000,
  endedAt: NOW - 1000,
  code: 0,
  tail: [],
  ...p,
})

describe('parseEntry — main 이 renderer 값을 믿지 않는다', () => {
  it('맞는 모양은 그대로', () => {
    const e = entry()
    expect(parseEntry(e)).toEqual(e)
  })
  it('코드 null(신호가 코드 없이 끝남)도 받는다', () => {
    expect(parseEntry(entry({ code: null }))?.code).toBeNull()
  })
  it.each([
    ['id 가 경로', { id: '../x' }],
    ['taskId 없음', { taskId: undefined }],
    ['paneId 숫자', { paneId: 3 }],
    ['명령이 문자열이 아님', { cmd: 5 }],
    ['빈 명령', { cmd: '   ' }],
    ['명령이 너무 김', { cmd: 'x'.repeat(CMD_MAX + 1) }],
    ['시각이 숫자가 아님', { startedAt: 'a' }],
    ['끝이 시작보다 앞', { startedAt: NOW, endedAt: NOW - 10 }],
    ['코드가 소수', { code: 1.5 }],
    ['꼬리가 배열이 아님', { tail: 'x' }],
  ])('%s → null', (_name, patch) => {
    expect(parseEntry({ ...entry(), ...patch })).toBeNull()
  })
  it('꼬리는 마지막 20줄 · 줄마다 1KB 로 자른다 · 문자열 아닌 줄은 버림', () => {
    const tail = [...Array.from({ length: 30 }, (_, i) => `l${i}`), 'y'.repeat(TAIL_LINE_MAX + 50), 7]
    const out = parseEntry({ ...entry(), tail })!
    expect(out.tail).toHaveLength(TAIL_LINES)
    expect(out.tail.at(-1)).toHaveLength(TAIL_LINE_MAX)
    expect(out.tail[0]).toBe('l11')
  })
  it('null · 배열 · 문자열', () => {
    expect(parseEntry(null)).toBeNull()
    expect(parseEntry([])).toBeNull()
    expect(parseEntry('{}')).toBeNull()
  })
})

describe('prune — 일감마다 최근 5,000개 · 90일', () => {
  it('90일 넘은 것을 버린다', () => {
    const old = entry({ endedAt: NOW - (HISTORY_DAYS + 1) * DAY, startedAt: NOW - (HISTORY_DAYS + 1) * DAY })
    const fresh = entry()
    expect(prune([old, fresh], NOW)).toEqual([fresh])
  })
  it('5,000 개 넘으면 오래된 것부터', () => {
    const list = Array.from({ length: HISTORY_MAX + 3 }, (_, i) => entry({ endedAt: NOW - (HISTORY_MAX + 3 - i) * 1000, startedAt: NOW - DAY }))
    const out = prune(list, NOW)
    expect(out).toHaveLength(HISTORY_MAX)
    expect(out[0]).toBe(list[3])
    expect(out.at(-1)).toBe(list.at(-1))
  })
  it('끝난 시각 순으로 정렬해 돌려준다', () => {
    const a = entry({ endedAt: NOW - 10 })
    const b = entry({ endedAt: NOW - 20 })
    expect(prune([a, b], NOW)).toEqual([b, a])
  })
})

describe('mergeEntries — 처음 읽은 목록과 그 사이 생긴 줄을 id 로 합친다', () => {
  it('겹치는 id 는 한 번 · 끝난 시각 순', () => {
    const a = entry({ endedAt: NOW - 30 })
    const b = entry({ endedAt: NOW - 20 })
    const c = entry({ endedAt: NOW - 10 })
    expect(mergeEntries([a, b], [b, c]).map((e) => e.id)).toEqual([a.id, b.id, c.id])
  })
})

describe('filterHistory', () => {
  const t1a = entry({ taskId: 't1', paneId: 'p1', cmd: 'git status', endedAt: NOW - 3000 })
  const t1b = entry({ taskId: 't1', paneId: 'p2', cmd: './deploy.sh', code: 1, cwd: '~/srv/deploy', endedAt: NOW - 2000 })
  const t2 = entry({ taskId: 't2', paneId: 'p3', cmd: 'npm run e2e', endedAt: NOW - 1000 })
  const short = entry({ taskId: 't1', paneId: 'p1', cmd: 'ls', startedAt: NOW - 600, endedAt: NOW - 400 })
  const shortFail = entry({ taskId: 't1', paneId: 'p1', cmd: 'cd nope', code: 1, startedAt: NOW - 300, endedAt: NOW - 200 })
  const all = [t1a, t1b, t2, short, shortFail]
  const base = { scope: 'task' as const, taskId: 't1', paneId: 'p1', failedOnly: false, hideShort: false, query: '' }

  it('범위: 이 일감 · 이 pane · 모든 일감 — 최근 것부터', () => {
    expect(filterHistory(all, base).map((e) => e.cmd)).toEqual(['cd nope', 'ls', './deploy.sh', 'git status'])
    expect(filterHistory(all, { ...base, scope: 'pane' }).map((e) => e.cmd)).toEqual(['cd nope', 'ls', 'git status'])
    expect(filterHistory(all, { ...base, scope: 'all' })).toHaveLength(5)
  })
  it('실패만', () => {
    expect(filterHistory(all, { ...base, failedOnly: true }).map((e) => e.cmd)).toEqual(['cd nope', './deploy.sh'])
  })
  it('짧은 명령 숨기기 = 0.5초 미만이면서 성공한 것만 숨김', () => {
    expect(filterHistory(all, { ...base, hideShort: true }).map((e) => e.cmd)).toEqual(['cd nope', './deploy.sh', 'git status'])
  })
  it('찾기: 명령 · 폴더 글자, 대소문자 무시', () => {
    expect(filterHistory(all, { ...base, query: 'DEPLOY' }).map((e) => e.cmd)).toEqual(['./deploy.sh'])
    expect(filterHistory(all, { ...base, query: 'srv' }).map((e) => e.cmd)).toEqual(['./deploy.sh'])
  })
  it('isFailed: null 은 실패가 아니다', () => {
    expect(isFailed(entry({ code: null }))).toBe(false)
    expect(isFailed(entry({ code: 130 }))).toBe(true)
  })
})

describe('groupByDay', () => {
  it('날마다 묶고 50줄 넘으면 더 보기 수 · 펼친 날은 모두', () => {
    const today = Array.from({ length: DAY_LIMIT + 7 }, (_, i) => entry({ endedAt: NOW - i * 1000 }))
    const yesterday = [entry({ endedAt: NOW - DAY })]
    const days = groupByDay([...today, ...yesterday], NOW, new Set(), () => false)
    expect(days.map((d) => d.label)).toEqual(['오늘 · 11-11', '어제 · 11-10'])
    expect(days[0]!.rows).toHaveLength(DAY_LIMIT)
    expect(days[0]!.more).toBe(7)
    const open = groupByDay([...today, ...yesterday], NOW, new Set([days[0]!.key]), () => false)
    expect(open[0]!.rows).toHaveLength(DAY_LIMIT + 7)
    expect(open[0]!.more).toBe(0)
  })
  it('그날 줄이 모두 이전 세션이면 꼬리표', () => {
    const y = entry({ endedAt: NOW - DAY })
    const t = entry()
    const days = groupByDay([t, y], NOW, new Set(), (e) => e.id === y.id)
    expect(days.map((d) => d.prev)).toEqual([false, true])
  })
  it('dayLabel: 오늘 · 어제 · 그 전은 날짜와 요일', () => {
    expect(dayLabel(NOW, NOW)).toBe('오늘 · 11-11')
    expect(dayLabel(NOW - DAY, NOW)).toBe('어제 · 11-10')
    expect(dayLabel(NOW - 2 * DAY, NOW)).toBe('11-09 (월)')
  })
})

describe('tailLines — 끝날 때 뜬 마지막 출력', () => {
  it('끝 공백 · 끝 빈 줄을 버리고 마지막 20줄', () => {
    const lines = [...Array.from({ length: 25 }, (_, i) => `line ${i}   `), '', '  ']
    const out = tailLines(lines)
    expect(out).toHaveLength(TAIL_LINES)
    expect(out[0]).toBe('line 5')
    expect(out.at(-1)).toBe('line 24')
  })
  it('비면 빈 배열', () => {
    expect(tailLines(['', ' '])).toEqual([])
  })
})
