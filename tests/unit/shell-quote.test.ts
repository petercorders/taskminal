import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { shellQuotePaths } from '../../src/shared/shell-quote'

describe('shellQuotePaths — 끌어 놓은 파일 경로를 셸 입력으로 (58c)', () => {
  it('안전한 글자만이면 따옴표 없이, 끝에 공백 하나', () => {
    expect(shellQuotePaths(['/usr/local/bin/node'])).toBe('/usr/local/bin/node ')
    expect(shellQuotePaths(['/tmp/a-b_c.v1.2/x@y%z+w:1,2'])).toBe('/tmp/a-b_c.v1.2/x@y%z+w:1,2 ')
  })

  it('공백이 든 경로는 작은따옴표로', () => {
    expect(shellQuotePaths(['/Users/me/My File.txt'])).toBe(`'/Users/me/My File.txt' `)
  })

  it(`작은따옴표는 '\\'' 로 — 따옴표를 닫고 · 글자 ' · 다시 연다`, () => {
    expect(shellQuotePaths([`/tmp/it's.txt`])).toBe(`'/tmp/it'\\''s.txt' `)
  })

  it('한글 이름도 따옴표로 감싸 그대로', () => {
    expect(shellQuotePaths(['/Users/me/문서/보고서 최종.pdf'])).toBe(`'/Users/me/문서/보고서 최종.pdf' `)
  })

  it('$ · 백틱 · 큰따옴표 · ~ · = 는 작은따옴표 안에서 글자 그대로', () => {
    expect(shellQuotePaths(['/tmp/$HOME/a$(id).txt'])).toBe(`'/tmp/$HOME/a$(id).txt' `)
    expect(shellQuotePaths(['/tmp/`id`'])).toBe("'/tmp/`id`' ")
    expect(shellQuotePaths(['/tmp/"a"b'])).toBe(`'/tmp/"a"b' `)
    expect(shellQuotePaths(['~/a'])).toBe(`'~/a' `)
    expect(shellQuotePaths(['=ls'])).toBe(`'=ls' `) // zsh 의 =명령 펼치기 · 변수 넣기로 읽히지 않게
  })

  it('여러 개는 공백 하나로 잇고 끝에 공백 하나', () => {
    expect(shellQuotePaths(['/tmp/a', '/tmp/b c', `/tmp/d'e`])).toBe(`/tmp/a '/tmp/b c' '/tmp/d'\\''e' `)
  })

  it('빈 목록 · 빈 경로(디스크에 없는 파일)는 아무것도 넣지 않는다', () => {
    expect(shellQuotePaths([])).toBe('')
    expect(shellQuotePaths([''])).toBe('')
    expect(shellQuotePaths(['', '/tmp/a'])).toBe('/tmp/a ')
  })

  it('실행하지 않는다 — 줄바꿈 · \\r 로 끝나지 않고, 줄바꿈 · 제어 글자가 든 이름은 건너뛴다', () => {
    expect(shellQuotePaths(['/tmp/a', '/tmp/b c'])).not.toMatch(/[\r\n]/)
    expect(shellQuotePaths(['/tmp/a\nrm -rf x'])).toBe('')
    expect(shellQuotePaths(['/tmp/a\rb', '/tmp/ok'])).toBe('/tmp/ok ')
    expect(shellQuotePaths(['/tmp/esc\x1b[201~', '/tmp/ctrl\x03c', '/tmp/del\x7f', '/tmp/tab\tx'])).toBe('')
  })

  it('실제 셸이 넣은 값을 원래 경로 그대로 낱말로 읽는다', () => {
    const paths = ['/tmp/plain', '/Users/me/My File.txt', `/tmp/it's "q" \`b\` $HOME $(id) * ? ! # & ; | < > ( ) { } [ ] ~`, '/Users/me/문서/보고서.pdf', '=ls', '-n']
    const out = execFileSync('/bin/sh', ['-c', `printf '%s\\0' ${shellQuotePaths(paths)}`], { encoding: 'utf8' })
    expect(out.split('\0').slice(0, -1)).toEqual(paths)
  })
})

// 58 리뷰: fish 는 작은따옴표 안의 \ 를 탈출 글자로 읽는다 — 셸을 모르니 \ 가 든 경로는 넣지 않는다
it('백슬래시가 든 경로는 건너뛴다 (fish 의 작은따옴표 규칙이 달라서)', () => {
  expect(shellQuotePaths(['/tmp/notes\\', '/tmp/ok.txt'])).toBe('/tmp/ok.txt ')
})

// Windows 셸(cmd · PowerShell)은 작은따옴표 규칙이 서로 다르다 — 둘 다 같은 뜻인 큰따옴표만 쓰고, 안에서 펼쳐질 수 있는 글자가 든 경로는 넣지 않는다
it('Windows: 공백 · 한글 경로는 큰따옴표로, 안전한 글자뿐이면 그대로', () => {
  expect(shellQuotePaths(['C:\\Users\\me\\My File.txt', 'C:\\work\\a.txt', 'D:\\자료\\표.csv'], true)).toBe('"C:\\Users\\me\\My File.txt" C:\\work\\a.txt "D:\\자료\\표.csv" ')
})

it('Windows: 큰따옴표 안에서도 펼쳐지는 글자($ · % · ` · " · & · ^ · !)가 든 경로는 건너뛴다', () => {
  for (const bad of ['C:\\a$b.txt', 'C:\\%TEMP%\\x', 'C:\\a`b', 'C:\\a"b', 'C:\\a&b', 'C:\\a^b', 'C:\\a!b', "C:\\it's"]) expect(shellQuotePaths([bad], true)).toBe('')
})
