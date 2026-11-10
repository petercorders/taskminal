import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_SCROLLBACK_BYTES, ScrollbackStore } from '../../src/main/scrollback-store'

// 실제 임시 폴더로 시험한다 (권한 · rename 은 mock 으로 대신하지 않는다).
let root: string
let dir: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'taskminal-scroll-'))
  dir = join(root, 'scrollback')
})
afterEach(() => {
  if (existsSync(dir)) chmodSync(dir, 0o700)
  rmSync(root, { recursive: true, force: true })
})

describe('ScrollbackStore (13단계)', () => {
  it('저장한 글을 다시 읽고, 저장 시각을 함께 준다', () => {
    const s = new ScrollbackStore(dir)
    expect(s.save({ live: ['p1'], panes: { p1: '한글 표식\r\n$ ' } })).toBeNull()
    const got = s.load('p1')
    expect(got?.text).toBe('한글 표식\r\n$ ')
    expect(typeof got?.savedAt).toBe('number')
    expect(s.load('p2')).toBeNull()
  })

  it('파일 0600 · 폴더 0700 · 임시 파일이 남지 않는다', () => {
    const s = new ScrollbackStore(dir)
    s.save({ live: ['p1'], panes: { p1: 'x' } })
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(dir, 'p1.txt')).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir)).toEqual(['p1.txt'])
  })

  it('live 에 없는 pane 의 파일은 지우고, live 인데 이번에 안 보낸 pane 은 남긴다', () => {
    const s = new ScrollbackStore(dir)
    s.save({ live: ['a', 'b', 'c'], panes: { a: 'A', b: 'B', c: 'C' } })
    s.save({ live: ['a', 'c'], panes: { a: 'A2' } })
    expect(s.load('a')?.text).toBe('A2')
    expect(s.load('b')).toBeNull()
    expect(s.load('c')?.text).toBe('C')
    expect(readdirSync(dir).sort()).toEqual(['a.txt', 'c.txt'])
  })

  it('live 밖의 pane 글은 쓰지 않는다 (닫힌 pane 의 늦은 저장)', () => {
    const s = new ScrollbackStore(dir)
    s.save({ live: [], panes: { gone: 'late' } })
    expect(s.load('gone')).toBeNull()
  })

  it(`상한(${MAX_SCROLLBACK_BYTES} 바이트)을 넘는 글은 버리고 옛 파일을 지운다 — 한글은 바이트로 센다`, () => {
    const s = new ScrollbackStore(dir)
    s.save({ live: ['p'], panes: { p: 'old' } })
    const big = '가'.repeat(Math.floor(MAX_SCROLLBACK_BYTES / 3) + 1) // 글자 수는 상한 아래, 바이트는 위
    s.save({ live: ['p'], panes: { p: big } })
    expect(s.load('p')).toBeNull()
  })

  it('이상한 paneId(경로 조작) · 글이 아닌 값은 쓰지도 읽지도 않는다', () => {
    const s = new ScrollbackStore(dir)
    writeFileSync(join(root, 'secret.txt'), 'nope')
    expect(s.load('../secret')).toBeNull()
    s.save({ live: ['../x', 'ok'], panes: { '../x': 'bad', ok: 42 as unknown as string } })
    expect(existsSync(join(root, 'x.txt'))).toBe(false)
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([])
  })

  it('clear 는 모두 지운다 (설정에서 끔)', () => {
    const s = new ScrollbackStore(dir)
    s.save({ live: ['a', 'b'], panes: { a: 'A', b: 'B' } })
    s.clear()
    expect(readdirSync(dir)).toEqual([])
    expect(s.load('a')).toBeNull()
  })

  it('쓰기에 실패하면 오류를 돌려주고 던지지 않으며, 다른 pane 은 그대로 쓴다', () => {
    const s = new ScrollbackStore(dir)
    s.save({ live: ['b'], panes: { b: 'B' } })
    mkdirSync(join(dir, 'a.txt')) // rename 대상이 폴더 → 실패
    const error = s.save({ live: ['a', 'b'], panes: { a: 'A', b: 'B2' } })
    expect(error).toBeInstanceOf(Error)
    expect(readFileSync(join(dir, 'b.txt'), 'utf8')).toBe('B2')
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })

  it('깨진 파일 · 폴더가 없으면 null', () => {
    expect(new ScrollbackStore(dir).load('a')).toBeNull()
  })
})
