import { describe, expect, it } from 'vitest'
import { copyText, expiredLogFiles, groupLog, isLogFileName, logFileName, logLine, parseLog, type LogEntry } from '../../src/shared/errlog'

const DAY = 24 * 60 * 60 * 1000
const at = (s: string) => new Date(s).getTime()

describe('파일 이름', () => {
  it('이 Mac 시간대 날짜로 main-YYYY-MM-DD.log', () => {
    expect(logFileName(at('2026-11-11T09:30:00'))).toBe('main-2026-11-11.log')
    expect(isLogFileName('main-2026-11-11.log')).toBe(true)
    expect(isLogFileName('../main-2026-11-11.log')).toBe(false)
    expect(isLogFileName('state.json')).toBe(false)
  })
  it('7일 지난 파일만 지울 목록에 (모르는 이름은 건드리지 않음)', () => {
    const now = at('2026-11-11T09:00:00')
    expect(expiredLogFiles(['main-2026-11-11.log', 'main-2026-11-05.log', 'main-2026-11-04.log', 'main-2026-10-01.log', 'notes.txt'], now)).toEqual([
      'main-2026-11-04.log',
      'main-2026-10-01.log',
    ])
  })
})

describe('줄 읽기', () => {
  it('JSON 한 줄씩 — 깨진 줄 · 모양이 틀린 줄은 버린다', () => {
    const good: LogEntry = { t: 1, level: 'error', key: 'state-save', msg: '상태를 저장하지 못했어요', detail: 'ENOSPC' }
    const text = [logLine(good), '{깨짐', JSON.stringify({ t: 'x', level: 'error', key: 'a', msg: 'b' }), JSON.stringify({ t: 2, level: 'info', key: 'a', msg: 'b' }), ''].join('\n')
    expect(parseLog(text)).toEqual([good])
  })
  it('logLine 은 줄바꿈 하나로 끝난다(글 안의 줄바꿈은 JSON 이스케이프)', () => {
    const line = logLine({ t: 1, level: 'warn', key: 'k', msg: '두\n줄' })
    expect(line.endsWith('\n')).toBe(true)
    expect(line.slice(0, -1)).not.toContain('\n')
  })
})

describe('groupLog', () => {
  const now = at('2026-11-11T15:00:00')
  const e = (t: number, key: string, msg = key, level: LogEntry['level'] = 'error', detail?: string): LogEntry => ({ t, level, key, msg, ...(detail ? { detail } : {}) })
  it('같은 level · key · msg 는 한 줄로 횟수 · 처음 · 마지막, 최근 것부터', () => {
    const rows = groupLog([e(now - 3000, 'spawn', '셸을 띄우지 못했어요', 'error', 'a'), e(now - 2000, 'disk'), e(now - 1000, 'spawn', '셸을 띄우지 못했어요', 'error', 'b')], now)
    expect(rows.map((r) => [r.key, r.count, r.t, r.first, r.detail])).toEqual([
      ['spawn', 2, now - 1000, now - 3000, 'b'],
      ['disk', 1, now - 2000, now - 2000, undefined],
    ])
  })
  it('7일보다 오래된 줄은 빼고, 거르기는 level 로', () => {
    const rows = groupLog([e(now - 8 * DAY, 'old'), e(now - 1, 'w', 'w', 'warn'), e(now - 2, 'x')], now)
    expect(rows.map((r) => r.key)).toEqual(['w', 'x'])
    expect(groupLog([e(now - 1, 'w', 'w', 'warn'), e(now - 2, 'x')], now, 'error').map((r) => r.key)).toEqual(['x'])
  })
})

it('copyText: 사용자 말 + 원문 + 횟수 · 시각', () => {
  const t = at('2026-11-11T14:02:00')
  expect(copyText({ t, first: t, count: 14, level: 'error', key: 'spawn', msg: '셸을 띄우지 못했어요', detail: 'posix_spawnp failed' })).toBe(
    '셸을 띄우지 못했어요\nposix_spawnp failed\n오류 · 14번 · 마지막 2026-11-11 14:02',
  )
})
