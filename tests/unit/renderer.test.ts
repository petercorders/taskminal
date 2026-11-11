import { describe, expect, it } from 'vitest'
import { MAX_WEBGL, MAX_WEBGL_FAILURES, rendererFromEnv, wantWebgl, webglBlock } from '../../src/shared/renderer'

// 15e: 보이는 pane 만 WebGL — 창당 컨텍스트 한도 · 실패 되풀이 막기
const base = { mode: 'webgl' as const, visible: true, inUse: 0, failures: 0, dpr: 2 }

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

describe('webglBlock (15e 리뷰)', () => {
  it('이유: 상한이면 cap(자리가 나면 다시) · 실패 · 숨음 · 모드', () => {
    expect(webglBlock({ ...base, inUse: MAX_WEBGL })).toBe('cap')
    expect(webglBlock({ ...base, failures: MAX_WEBGL_FAILURES, inUse: MAX_WEBGL })).toBe('failed')
    expect(webglBlock({ ...base, visible: false })).toBe('hidden')
    expect(webglBlock({ ...base, mode: 'dom' })).toBe('mode')
    expect(webglBlock(base)).toBeNull()
  })
})

describe('화면 배율 (27단계)', () => {
  it('배율 2 미만이면 DOM — WebGL 글자 아틀라스가 작고 띄엄띄엄 그려진다', () => {
    expect(webglBlock({ ...base, dpr: 1 })).toBe('lowdpi')
    expect(webglBlock({ ...base, dpr: 1.5 })).toBe('lowdpi')
    expect(webglBlock({ ...base, dpr: 2 })).toBeNull()
  })
  it("webgl-always(시험 · 환경 변수 TASKMINAL_RENDERER=webgl)는 배율과 상관없이 WebGL", () => {
    expect(webglBlock({ ...base, mode: 'webgl-always', dpr: 1 })).toBeNull()
    expect(webglBlock({ ...base, mode: 'webgl-always', dpr: 1, visible: false })).toBe('hidden')
  })
  it('rendererFromEnv: dom · webgl(항상) · 그 밖은 기본(배율 보고)', () => {
    expect(rendererFromEnv('dom')).toBe('dom')
    expect(rendererFromEnv('webgl')).toBe('webgl-always')
    expect(rendererFromEnv(undefined)).toBe('webgl')
    expect(rendererFromEnv('x')).toBe('webgl')
  })
})
