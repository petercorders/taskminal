// 52단계: Claude 한도(5시간 · 주간) 실수치 — 대화 rate_limit_event · 터미널 statusLine 해석, 더 새 값만, 색 · 알림 · 글자.
import { describe, expect, it } from 'vitest'
import {
  crossedDanger,
  formatResetIn,
  mergeUsage,
  normalizeUsageMap,
  parseStatusFile,
  usageFromRateLimitInfo,
  usageFromStatusLine,
  usageTone,
} from '../../src/shared/usage'

const NOW = 1_794_800_000_000
// 스파이크(2026-11-16, claude 2.1.325 -p)에서 받은 모양 그대로(숫자만)
const SPIKE = {
  status: 'allowed_warning',
  resetsAt: 1794906000,
  rateLimitType: 'seven_day',
  utilization: 0.79,
  unifiedWindows: {
    five_hour: { utilization: 0.25, resetsAt: 1794816000, status: 'allowed' },
    seven_day: { utilization: 0.79, resetsAt: 1794906000, status: 'allowed_warning', surpassedThreshold: 0.75 },
  },
}

describe('원천 해석', () => {
  it('대화 rate_limit_event: utilization 0~1 → 퍼센트, resetsAt 초 → ms', () => {
    expect(usageFromRateLimitInfo(SPIKE, NOW)).toEqual({
      fiveHour: { used: 25, resetsAt: 1794816000_000 },
      sevenDay: { used: 79, resetsAt: 1794906000_000 },
      at: NOW,
      source: 'chat',
    })
  })
  it('창이 없거나 숫자가 아니면 그 창은 빼고, 둘 다 없으면 null', () => {
    expect(usageFromRateLimitInfo({ unifiedWindows: { five_hour: { utilization: 'x', resetsAt: 1 } } }, NOW)).toBeNull()
    expect(usageFromRateLimitInfo({}, NOW)).toBeNull()
    expect(usageFromRateLimitInfo({ unifiedWindows: { seven_day: { utilization: 1.2, resetsAt: 5 } } }, NOW)).toEqual({ sevenDay: { used: 120, resetsAt: 5000 }, at: NOW, source: 'chat' })
  })
  it('터미널 statusLine rate_limits: used_percentage 0~100 · resets_at 초', () => {
    expect(usageFromStatusLine({ five_hour: { used_percentage: 12.5, resets_at: 1794816000 } }, NOW)).toEqual({
      fiveHour: { used: 12.5, resetsAt: 1794816000_000 },
      at: NOW,
      source: 'terminal',
    })
    expect(usageFromStatusLine(null, NOW)).toBeNull()
  })
  it('statusLine 기록 파일: v1⇥설정 폴더⇥rate_limits JSON 한 줄', () => {
    expect(parseStatusFile('v1\t/acc/c1\t{"five_hour":{"used_percentage":3,"resets_at":9}}\n')).toEqual({ configDir: '/acc/c1', rateLimits: { five_hour: { used_percentage: 3, resets_at: 9 } } })
    expect(parseStatusFile('v1\t\t{"seven_day":{}}')).toEqual({ configDir: '', rateLimits: { seven_day: {} } })
    expect(parseStatusFile('v2\tx\t{}')).toBeNull()
    expect(parseStatusFile('v1\tx\tnot json')).toBeNull()
  })
})

describe('더 새 값만 · 창별로 합치기', () => {
  const a = { fiveHour: { used: 10, resetsAt: NOW + 3_600_000 }, sevenDay: { used: 50, resetsAt: NOW + 86_400_000 }, at: NOW, source: 'chat' as const }
  it('늦게 도착한 옛 값은 버린다(null)', () => {
    expect(mergeUsage(a, { ...a, fiveHour: { used: 5, resetsAt: NOW + 3_600_000 }, at: NOW - 1 }, NOW)).toBeNull()
  })
  it('같은 값이면 바뀌지 않음(null) — 화면 전송은 바뀐 값만', () => {
    expect(mergeUsage(a, { ...a, at: NOW + 5 }, NOW + 5)).toBeNull()
  })
  it('새 값에 없는 창은 초기화 전이면 앞 값을 남기고, 지났으면 버린다', () => {
    const next = { fiveHour: { used: 20, resetsAt: NOW + 3_600_000 }, at: NOW + 10, source: 'terminal' as const }
    expect(mergeUsage(a, next, NOW + 10)).toEqual({ fiveHour: { used: 20, resetsAt: NOW + 3_600_000 }, sevenDay: a.sevenDay, at: NOW + 10, source: 'terminal' })
    expect(mergeUsage(a, next, NOW + 90_000_000)).toEqual({ fiveHour: { used: 20, resetsAt: NOW + 3_600_000 }, at: NOW + 10, source: 'terminal' })
  })
  it('앞 값이 없으면 그대로 받는다', () => {
    expect(mergeUsage(undefined, a, NOW)).toEqual(a)
  })
})

describe('색 · 알림 · 글자', () => {
  it('70% 노랑 · 90% 빨강', () => {
    expect([usageTone(69.9), usageTone(70), usageTone(89.9), usageTone(90)]).toEqual(['ok', 'warn', 'warn', 'danger'])
  })
  it('90% 를 새로 넘은 창만 — 같은 창(초기화 시각)에서 두 번 알리지 않는다', () => {
    const p = { fiveHour: { used: 80, resetsAt: 1000 }, at: 1, source: 'chat' as const }
    expect(crossedDanger(p, { fiveHour: { used: 91, resetsAt: 1000 }, at: 2, source: 'chat' })).toEqual(['fiveHour'])
    expect(crossedDanger({ ...p, fiveHour: { used: 91, resetsAt: 1000 } }, { fiveHour: { used: 95, resetsAt: 1000 }, at: 3, source: 'chat' })).toEqual([])
    expect(crossedDanger({ ...p, fiveHour: { used: 95, resetsAt: 1000 } }, { fiveHour: { used: 92, resetsAt: 9000 }, at: 3, source: 'chat' })).toEqual(['fiveHour'])
    expect(crossedDanger(undefined, { sevenDay: { used: 90, resetsAt: 1 }, at: 1, source: 'chat' })).toEqual(['sevenDay'])
  })
  it('초기화까지 남은 시간', () => {
    expect(formatResetIn(NOW + 2 * 3_600_000 + 13 * 60_000, NOW)).toBe('2시간 13분 뒤 초기화')
    expect(formatResetIn(NOW + 3 * 86_400_000 + 5 * 3_600_000, NOW)).toBe('3일 5시간 뒤 초기화')
    expect(formatResetIn(NOW + 30_000, NOW)).toBe('곧 초기화')
    expect(formatResetIn(NOW - 1, NOW)).toBe('초기화됨')
  })
  it('저장 파일 읽기: 모양이 틀린 계정 · 창은 버린다', () => {
    expect(
      normalizeUsageMap({ 'default-claude': { fiveHour: { used: 1, resetsAt: 2 }, at: 3, source: 'chat' }, bad: { at: 'x' }, worse: 5, x: { sevenDay: { used: 'a' }, at: 1, source: 'terminal' } }),
    ).toEqual({ 'default-claude': { fiveHour: { used: 1, resetsAt: 2 }, at: 3, source: 'chat' } })
    expect(normalizeUsageMap(null)).toEqual({})
  })
})

describe('계정 화면 값', () => {
  it('창 목록 · 받은 지 얼마나', async () => {
    const { accountWindows, usageAgo } = await import('../../src/shared/usage')
    expect(accountWindows({ fiveHour: { used: 25, resetsAt: 5 }, sevenDay: { used: 79, resetsAt: 9 }, at: 1, source: 'chat' })).toEqual([
      { label: '5시간', used: 25, resetsAt: 5 },
      { label: '주간', used: 79, resetsAt: 9 },
    ])
    expect(accountWindows(undefined)).toEqual([])
    expect([usageAgo(NOW - 10_000, NOW), usageAgo(NOW - 5 * 60_000, NOW), usageAgo(NOW - 3 * 3_600_000, NOW), usageAgo(NOW - 2 * 86_400_000, NOW)]).toEqual([
      '방금',
      '5분 전',
      '3시간 전',
      '2일 전',
    ])
  })
})
