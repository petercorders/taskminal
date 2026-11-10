import { describe, expect, it } from 'vitest'
import { linkToOpen, webUrl } from '../../src/shared/links'

// 15b: 터미널 출력의 링크 — 남이 만든 글이라 http(s) 만, ⌘+클릭일 때만 연다.
describe('webUrl', () => {
  it('http · https 만 통과', () => {
    expect(webUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
    expect(webUrl('http://localhost:5173/')).toBe('http://localhost:5173/')
    expect(webUrl('HTTPS://EXAMPLE.com')).toBe('https://example.com/')
  })
  it('검사한 값을 연다 — 앞뒤 공백 · 제어 문자가 붙은 주소는 다듬은 href (15b 리뷰)', () => {
    expect(webUrl('  https://example.com/x\n')).toBe('https://example.com/x')
  })
  it('긴 주소도 http(s) 면 연다 — window.open · 이동 길에 길이 제한을 걸지 않는다 (15b 리뷰)', () => {
    const long = 'https://e.com/' + 'a'.repeat(3000)
    expect(webUrl(long)).toBe(long)
  })
  it('다른 스킴 · 깨진 글 · 빈 글 · 글이 아닌 값은 null', () => {
    for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'ssh://host', 'vscode://file/x', 'mailto:a@b.c', 'not a url', '', '//example.com']) {
      expect(webUrl(u)).toBeNull()
    }
    expect(webUrl(42 as unknown as string)).toBeNull()
  })
})

describe('linkToOpen', () => {
  it('⌘ 를 누른 클릭만 연다', () => {
    expect(linkToOpen('https://example.com', true)).toBe('https://example.com/')
    expect(linkToOpen('https://example.com', false)).toBeNull()
  })
  it('⌘ 를 눌러도 http(s) 가 아니면 열지 않는다', () => {
    expect(linkToOpen('file:///etc/passwd', true)).toBeNull()
  })
})
