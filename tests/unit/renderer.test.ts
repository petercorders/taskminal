import { describe, expect, it } from 'vitest'
import { MAX_WEBGL, MAX_WEBGL_FAILURES, wantWebgl } from '../../src/shared/renderer'

// 15e: 보이는 pane 만 WebGL — 창당 컨텍스트 한도 · 실패 되풀이 막기
const base = { mode: 'webgl' as const, visible: true, inUse: 0, failures: 0 }

describe('wantWebgl', () => {
  it('보이고 여유 있으면 WebGL', () => {
    expect(wantWebgl(base)).toBe(true)
    expect(wantWebgl({ ...base, inUse: MAX_WEBGL - 1 })).toBe(true)
  })
  it('숨은 pane 은 DOM', () => {
    expect(wantWebgl({ ...base, visible: false })).toBe(false)
  })
  it('dom 모드(시험 · 환경 변수)면 늘 DOM', () => {
    expect(wantWebgl({ ...base, mode: 'dom' })).toBe(false)
  })
  it(`동시에 ${MAX_WEBGL}개를 쓰는 중이면 DOM`, () => {
    expect(wantWebgl({ ...base, inUse: MAX_WEBGL })).toBe(false)
  })
  it(`실패가 ${MAX_WEBGL_FAILURES}번이면 다시 시도하지 않는다`, () => {
    expect(wantWebgl({ ...base, failures: MAX_WEBGL_FAILURES - 1 })).toBe(true)
    expect(wantWebgl({ ...base, failures: MAX_WEBGL_FAILURES })).toBe(false)
  })
})
