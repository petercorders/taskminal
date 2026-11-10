import { describe, expect, it } from 'vitest'
import { cwdLike, expandHome, parseLsofCwd, parseOsc7 } from '../../src/shared/cwd'

describe('parseOsc7 — 셸 통합이 알려 주는 작업 폴더', () => {
  it('퍼센트 인코딩(한글 · 공백)을 푼다', () => {
    expect(parseOsc7('file://mac/Users/a/%ED%95%9C%EA%B8%80%20%ED%8F%B4%EB%8D%94', 'mac')).toBe('/Users/a/한글 폴더')
  })

  it('이 Mac 의 이름 · localhost · 빈 호스트만 받는다 (대소문자 · .local 무시)', () => {
    expect(parseOsc7('file://localhost/tmp', 'mac')).toBe('/tmp')
    expect(parseOsc7('file:///tmp', 'mac')).toBe('/tmp')
    expect(parseOsc7('file://MacBook-Pro.local/tmp', 'macbook-pro')).toBe('/tmp')
    expect(parseOsc7('file://macbook-pro/tmp', 'MacBook-Pro.local')).toBe('/tmp')
  })

  it('다른 호스트(ssh 안의 셸)는 버린다', () => {
    expect(parseOsc7('file://server/home/me', 'mac')).toBeNull()
  })

  it('file 주소가 아니거나 깨진 글은 null', () => {
    expect(parseOsc7('http://mac/tmp', 'mac')).toBeNull()
    expect(parseOsc7('file://mac/%E0%A4%A', 'mac')).toBeNull()
    expect(parseOsc7('', 'mac')).toBeNull()
    expect(parseOsc7('file://mac', 'mac')).toBeNull()
  })
})

describe('parseLsofCwd — `lsof -a -d cwd -Fpn -p …` 출력', () => {
  it('pid 마다 n 줄의 폴더', () => {
    const out = 'p101\nfcwd\nn/Users/a/한글\np202\nfcwd\nn/tmp\n'
    expect(parseLsofCwd(out)).toEqual({ 101: '/Users/a/한글', 202: '/tmp' })
  })

  it('n 줄이 없는 pid · 모르는 줄 · 상대 경로는 건너뛴다', () => {
    expect(parseLsofCwd('p1\nfcwd\np2\nx?\nnrel\np3\nn/ok\n')).toEqual({ 3: '/ok' })
    expect(parseLsofCwd('')).toEqual({})
  })
})

describe('cwdLike — 셸이 알려 준 절대 경로를 일감 폴더와 같은 모양으로 (13단계 리뷰)', () => {
  const home = '/Users/x'
  it('일감 폴더가 ~ 로 쓰였으면 홈 아래 경로를 ~ 로', () => {
    expect(cwdLike('/Users/x/proj', '~/proj', home)).toBe('~/proj')
    expect(cwdLike('/Users/x', '~', home)).toBe('~')
    expect(cwdLike('/Users/x/proj/한글 폴더', '~/proj', home)).toBe('~/proj/한글 폴더')
  })
  it('홈 밖 · 이름만 비슷한 폴더(/Users/xy) · 절대 경로로 쓴 일감은 그대로', () => {
    expect(cwdLike('/tmp/a', '~/proj', home)).toBe('/tmp/a')
    expect(cwdLike('/Users/xy/a', '~', home)).toBe('/Users/xy/a')
    expect(cwdLike('/Users/x/proj', '/Users/x/proj', home)).toBe('/Users/x/proj')
  })
  it('홈을 모르면 그대로', () => {
    expect(cwdLike('/Users/x/proj', '~/proj', '')).toBe('/Users/x/proj')
  })
})

describe('expandHome (15c 리뷰 — pty · git 이 같은 규칙)', () => {
  it('~ · ~/x 만 풀고 나머지는 그대로', () => {
    expect(expandHome('~', '/Users/a')).toBe('/Users/a')
    expect(expandHome('~/p/q', '/Users/a')).toBe('/Users/a/p/q')
    expect(expandHome('~other', '/Users/a')).toBe('~other')
    expect(expandHome('/tmp', '/Users/a')).toBe('/tmp')
  })
})
