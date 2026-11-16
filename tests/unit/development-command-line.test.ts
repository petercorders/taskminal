import { describe, expect, it } from 'vitest'
import { commandLine } from '../../src/shared/development-tools'

// 56단계: 환경 준비 미리보기의 명령을 JSON 대신 한 줄로 — 신뢰 확인 화면이라 인자 경계 · 안 보이는 글자가 드러나야 한다
describe('commandLine', () => {
  it('평범한 인자는 그대로 띄어 쓴다', () => {
    expect(commandLine({ file: 'npm', args: ['ci'] })).toBe('npm ci')
    expect(commandLine({ file: '/usr/bin/env', args: ['--flag=a,b', 'path/to/file.txt'] })).toBe('/usr/bin/env --flag=a,b path/to/file.txt')
  })
  it('공백 · 따옴표 · 셸 글자 · 빈 인자는 작은따옴표로 감싸 경계를 보인다', () => {
    expect(commandLine({ file: 'echo', args: ['hello world', "it's", '', '$HOME', 'a;b'] })).toBe(`echo 'hello world' 'it'\\''s' '' '$HOME' 'a;b'`)
  })
  it('제어 · 방향 바꿈 글자는 \\u{…} 로 드러낸다', () => {
    expect(commandLine({ file: 'node', args: ['a\nb', 'x\u202ey'] })).toBe(`node 'a\\u{000a}b' 'x\\u{202e}y'`)
  })
})
