import { describe, expect, it } from 'vitest'
import { restoreBanner, saveLines, SAVE_LINES_MAX } from '../../src/shared/scrollback'

describe('스크롤 되살리기 도움 함수 (13단계)', () => {
  it('저장 줄 수는 설정값과 상한 중 작은 것', () => {
    expect(saveLines(1000)).toBe(1000)
    expect(saveLines(100_000)).toBe(SAVE_LINES_MAX)
  })

  it('이전 세션 줄: 저장 시각(월-일 시:분)을 흐리게, 앞 글의 색은 지운다', () => {
    const t = new Date(2026, 10, 10, 20, 31).getTime()
    const b = restoreBanner(t)
    expect(b).toContain('── 이전 세션 · 11-10 20:31 ──')
    expect(b.startsWith('\x1b[0m\r\n\x1b[2m')).toBe(true)
    expect(b.endsWith('\x1b[0m\r\n')).toBe(true)
  })

  it('시각이 이상하면 시각 없이', () => {
    expect(restoreBanner(Number.NaN)).toContain('── 이전 세션 ──')
  })
})
