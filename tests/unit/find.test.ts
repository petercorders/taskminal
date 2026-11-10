import { describe, expect, it } from 'vitest'
import { FIND_LIMIT, findCountLabel, findKeyAction } from '../../src/shared/find'

// 15d: ⌘F 찾기 막대의 순수 판정
describe('findCountLabel', () => {
  it('빈 입력이면 숨김(빈 글), 없으면 없음, 있으면 n/m', () => {
    expect(findCountLabel('', -1, 0)).toBe('')
    expect(findCountLabel('abc', -1, 0)).toBe('없음')
    expect(findCountLabel('abc', 0, 3)).toBe('1/3')
    expect(findCountLabel('abc', 2, 3)).toBe('3/3')
  })
  it('지금 위치를 모르면(-1) 수만, 상한을 넘으면 +', () => {
    expect(findCountLabel('a', -1, 5)).toBe('5')
    expect(findCountLabel('a', 4, FIND_LIMIT + 1)).toBe(`5/${FIND_LIMIT}+`)
  })
})

describe('findKeyAction', () => {
  it('↩ 다음 · ⇧↩ 이전 · Esc 닫기', () => {
    expect(findKeyAction('Enter', false, false)).toBe('next')
    expect(findKeyAction('Enter', true, false)).toBe('prev')
    expect(findKeyAction('Escape', false, false)).toBe('close')
  })
  it('한글 조합 중의 ↩ · Esc 는 글자 확정 — 아무것도 안 함', () => {
    expect(findKeyAction('Enter', false, true)).toBeNull()
    expect(findKeyAction('Escape', false, true)).toBeNull()
  })
  it('다른 키는 입력칸에 맡김', () => {
    expect(findKeyAction('a', false, false)).toBeNull()
  })
})
