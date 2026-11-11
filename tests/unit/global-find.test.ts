import { describe, expect, it } from 'vitest'
import {
  findInLines,
  isMaskQuery,
  makeMatcher,
  PER_PANE,
  prevSessionLine,
  secretHint,
  snippet,
  stripAnsi,
  type Matcher,
} from '../../src/shared/global-find'
import { maskOf } from '../../src/shared/redact'

const GHP = 'ghp_' + 'a1B2c3D4e5'.repeat(4)
const ok = (m: Matcher) => {
  if (!m.ok) throw new Error(m.error)
  return m
}
const L = (texts: string[]) => texts.map((text, line) => ({ line, text }))

describe('makeMatcher', () => {
  it('글자 그대로 · 대소문자 무시가 기본', () => {
    const m = ok(makeMatcher('Unresolved', { cs: false, re: false }))
    expect(m.test('e: unresolved reference')).toEqual({ at: 3, len: 10 })
    expect(m.test('nothing')).toBeNull()
  })
  it('Aa 켜면 대소문자를 가린다', () => {
    const m = ok(makeMatcher('Error', { cs: true, re: false }))
    expect(m.test('error')).toBeNull()
    expect(m.test('an Error')).toEqual({ at: 3, len: 5 })
  })
  it('정규식 · 대소문자', () => {
    const m = ok(makeMatcher('my(Share|Balance)', { cs: false, re: true }))
    expect(m.test('ref: MYBALANCE')).toEqual({ at: 5, len: 9 })
  })
  it('정규식에서 빈 일치는 맞은 것으로 치지 않는다', () => {
    const m = ok(makeMatcher('x*', { cs: false, re: true }))
    expect(m.test('abc')).toBeNull()
    expect(m.test('axx')).toEqual({ at: 1, len: 2 })
  })
  it('틀린 정규식은 읽을 수 있는 글로', () => {
    const m = makeMatcher('myShare(', { cs: false, re: true })
    expect(m.ok).toBe(false)
    if (!m.ok) expect(m.error).toBe('정규식을 읽을 수 없어요: ( 가 닫히지 않았어요')
    const n = makeMatcher('a[', { cs: false, re: true })
    if (!n.ok) expect(n.error).toMatch(/^정규식을 읽을 수 없어요: /)
  })
  it('정규식이 꺼져 있으면 기호도 글자 그대로', () => {
    expect(ok(makeMatcher('myShare(', { cs: false, re: false })).test('x myShare(1)')).toEqual({ at: 2, len: 8 })
  })
})

describe('findInLines — 가린 글로 판정 · 미리보기', () => {
  it('원문 비밀값으로는 찾지 못한다', () => {
    const m = ok(makeMatcher('ghp_a1B2', { cs: false, re: false }))
    const r = findInLines(L([`token ${GHP} here`]), m, { limit: 50, redact: {}, maskQuery: false })
    expect(r.hits).toEqual([])
  })
  it('비밀값이 든 줄의 다른 낱말로 찾으면 미리보기는 가린 글', () => {
    const m = ok(makeMatcher('token', { cs: false, re: false }))
    const r = findInLines(L([`token ${GHP} here`]), m, { limit: 50, redact: {}, maskQuery: false })
    expect(r.hits).toHaveLength(1)
    expect(r.hits[0]!.text).toBe(`token ${maskOf('GitHub 토큰')} here`)
    expect(r.hits[0]!.text).not.toContain(GHP)
  })
  it('‹가림: 종류 이름으로는 찾는다(모든 줄을 가려 판정)', () => {
    const q = '가림:GitHub'
    expect(isMaskQuery(q)).toBe(true)
    const m = ok(makeMatcher(q, { cs: false, re: false }))
    const r = findInLines(L(['clean', `x ${GHP}`]), m, { limit: 50, redact: {}, maskQuery: true })
    expect(r.hits.map((h) => h.line)).toEqual([1])
  })
  it('pane 당 상한 — 넘으면 more', () => {
    const m = ok(makeMatcher('err', { cs: false, re: false }))
    const lines = L(Array.from({ length: PER_PANE + 5 }, (_, i) => `err ${i}`))
    const r = findInLines(lines, m, { limit: PER_PANE, redact: {}, maskQuery: false })
    expect(r.hits).toHaveLength(PER_PANE)
    expect(r.more).toBe(true)
    expect(r.hits[0]!.line).toBe(0)
  })
  it('맞은 자리는 가린 글 안의 자리', () => {
    const m = ok(makeMatcher('here', { cs: false, re: false }))
    const r = findInLines(L([`${GHP} here`]), m, { limit: 50, redact: {}, maskQuery: false })
    const h = r.hits[0]!
    expect(h.text.slice(h.at, h.at + h.len)).toBe('here')
  })
})

describe('이전 세션 · 비밀값 힌트 · 조각', () => {
  it('되살린 글의 배너 줄 번호 (없으면 -1)', () => {
    expect(prevSessionLine(L(['old', '── 이전 세션 · 11-10 20:31 ──', 'new']))).toBe(1)
    expect(prevSessionLine(L(['a', 'b']))).toBe(-1)
  })
  it('비밀값처럼 보이는 낱말이면 그 종류로 찾는 길', () => {
    expect(secretHint(GHP)).toBe('가림:GitHub 토큰')
    expect(secretHint('myShare')).toBeNull()
  })
  it('snippet: 앞은 40자까지 줄이고 맞은 곳 · 뒤', () => {
    const text = 'x'.repeat(60) + 'HIT' + ' after'
    const s = snippet(text, 60, 3)
    expect(s.pre).toBe('…' + 'x'.repeat(40))
    expect(s.hit).toBe('HIT')
    expect(s.post).toBe(' after')
  })
  it('stripAnsi: 저장된 스크롤 글의 색 코드를 뺀다', () => {
    expect(stripAnsi('\x1b[31merror\x1b[0m: x')).toBe('error: x')
  })
})

describe('측정 — 일감 20 · pane 60 · pane 당 5000줄', () => {
  it('맞는 줄이 드물 때 1.5초 안에 훑는다', () => {
    const lines = L(Array.from({ length: 5000 }, (_, i) => `[${i}] > Task :compileKotlin w: Parameter 'ctx' is never used in SettlementService.kt line ${i}`))
    lines[4200]!.text += ' Unresolved reference: myShare'
    const m = ok(makeMatcher('Unresolved reference', { cs: false, re: false }))
    const t0 = performance.now()
    let found = 0
    for (let p = 0; p < 60; p++) found += findInLines(lines, m, { limit: PER_PANE, redact: {}, maskQuery: false }).hits.length
    const ms = performance.now() - t0
    expect(found).toBe(60)
    console.log(`[측정] 60 pane × 5000줄 글자 찾기: ${ms.toFixed(0)}ms`)
    expect(ms).toBeLessThan(1500)
  })
})
