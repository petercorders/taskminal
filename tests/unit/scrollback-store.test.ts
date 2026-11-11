import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_SCROLLBACK_BYTES, ScrollbackStore, trimToBytes } from '../../src/main/scrollback-store'

// 실제 임시 폴더로 시험한다 (권한 · rename 은 mock 으로 대신하지 않는다).
let root: string
let dir: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'taskminal-scroll-'))
  dir = join(root, 'scrollback')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

// 같은 규칙을 비동기(주기 저장) · 동기(페이지가 내려갈 때) 둘 다 지킨다
const ways = [
  { name: '주기 저장(save)', save: (s: ScrollbackStore, live: unknown, panes: unknown) => s.save(live, panes) },
  { name: '내려갈 때(saveSync)', save: async (s: ScrollbackStore, live: unknown, panes: unknown) => s.saveSync(live, panes) },
]

describe.each(ways)('ScrollbackStore — $name (13단계)', ({ save }) => {
  it('저장한 글을 다시 읽고, 저장 시각을 함께 준다', async () => {
    const s = new ScrollbackStore(dir)
    expect(await save(s, ['p1'], { p1: '한글 표식\r\n$ ' })).toBeNull()
    const got = await s.load('p1')
    expect(got?.text).toBe('한글 표식\r\n$ ')
    expect(typeof got?.savedAt).toBe('number')
    expect(await s.load('p2')).toBeNull()
  })

  it('파일 0600 · 폴더 0700 · 임시 파일이 남지 않는다', async () => {
    const s = new ScrollbackStore(dir)
    await save(s, ['p1'], { p1: 'x' })
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(dir, 'p1.txt')).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir)).toEqual(['p1.txt'])
  })

  it('live 에 없는 pane 의 파일은 지우고, live 인데 이번에 안 보낸 pane 은 남긴다', async () => {
    const s = new ScrollbackStore(dir)
    await save(s, ['a', 'b', 'c'], { a: 'A', b: 'B', c: 'C' })
    await save(s, ['a', 'c'], { a: 'A2' })
    expect((await s.load('a'))?.text).toBe('A2')
    expect(await s.load('b')).toBeNull()
    expect((await s.load('c'))?.text).toBe('C')
    expect(readdirSync(dir).sort()).toEqual(['a.txt', 'c.txt'])
  })

  it('live=[] 면 모두 지운다 (설정에서 끔)', async () => {
    const s = new ScrollbackStore(dir)
    await save(s, ['a', 'b'], { a: 'A', b: 'B' })
    await save(s, [], {})
    expect(readdirSync(dir)).toEqual([])
  })

  it('live 밖의 pane 글은 쓰지 않는다 (닫힌 pane 의 늦은 저장)', async () => {
    const s = new ScrollbackStore(dir)
    await save(s, [], { gone: 'late' })
    expect(await s.load('gone')).toBeNull()
  })

  it(`상한(${MAX_SCROLLBACK_BYTES} 바이트)을 넘으면 최근 쪽만 남긴다 — 한글은 바이트로 센다`, async () => {
    const s = new ScrollbackStore(dir)
    const line = '가'.repeat(99) + '\n' // 298 바이트
    const big = 'OLDEST\n' + line.repeat(Math.ceil(MAX_SCROLLBACK_BYTES / 298) + 10) + 'NEWEST'
    expect(big.length).toBeLessThan(MAX_SCROLLBACK_BYTES) // 글자 수로는 상한 아래
    await save(s, ['p'], { p: big })
    const text = (await s.load('p'))!.text
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_SCROLLBACK_BYTES)
    expect(text.endsWith('NEWEST')).toBe(true)
    expect(text).not.toContain('OLDEST')
    expect(text.startsWith('가')).toBe(true) // 줄 처음부터 — 반쯤 잘린 글자가 없다
  })

  it('이상한 paneId(경로 조작) · 글이 아닌 값은 쓰지도 읽지도 않는다', async () => {
    const s = new ScrollbackStore(dir)
    writeFileSync(join(root, 'secret.txt'), 'nope')
    expect(await s.load('../secret')).toBeNull()
    await save(s, ['../x', 'ok'], { '../x': 'bad', ok: 42 })
    expect(existsSync(join(root, 'x.txt'))).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  })

  it('쓰기에 실패하면 오류를 돌려주고 던지지 않으며, 다른 pane 은 그대로 쓴다', async () => {
    const s = new ScrollbackStore(dir)
    await save(s, ['b'], { b: 'B' })
    mkdirSync(join(dir, 'a.txt')) // rename 대상이 폴더 → 실패
    const error = await save(s, ['a', 'b'], { a: 'A', b: 'B2' })
    expect(error).toBeInstanceOf(Error)
    expect(readFileSync(join(dir, 'b.txt'), 'utf8')).toBe('B2')
    expect(readdirSync(dir).filter((n) => n.includes('.tmp'))).toEqual([])
  })

  it('폴더가 없으면 load 는 null', async () => {
    expect(await new ScrollbackStore(dir).load('a')).toBeNull()
  })
})

describe('주기 저장과 내려갈 때 저장이 겹치면 (13단계 리뷰)', () => {
  it('늦게 끝나는 옛 주기 저장이 새 글을 덮지 않고, 새 pane 파일을 지우지 않는다', async () => {
    const s = new ScrollbackStore(dir)
    const old = s.save(['a'], { a: 'OLD' }) // 아직 끝나지 않음
    s.saveSync(['a', 'b'], { a: 'NEW', b: 'B' })
    await old
    expect((await s.load('a'))?.text).toBe('NEW')
    expect((await s.load('b'))?.text).toBe('B')
  })
})

describe('trimToBytes', () => {
  it('상한 안이면 그대로, 넘으면 줄 처음부터 최근 쪽, 줄바꿈이 없으면 빈 글', () => {
    expect(trimToBytes('abc', 10)).toBe('abc')
    expect(trimToBytes('111\n222\n333', 6)).toBe('333')
    expect(trimToBytes('x'.repeat(20), 5)).toBe('')
  })
})

const ANT = 'sk-ant-api03-' + 'Q'.repeat(60)
describe.each(ways)('ScrollbackStore 비밀값 가리기 — $name (17단계)', ({ save }) => {
  it('파일에 원문이 남지 않는다 — ‹가림:종류›', async () => {
    const s = new ScrollbackStore(dir)
    await save(s, ['p1'], { p1: `$ echo ${ANT}\r\n${ANT}\r\n` })
    const text = readFileSync(join(dir, 'p1.txt'), 'utf8')
    expect(text).not.toContain('sk-ant-api03')
    expect(text).toBe('$ echo ‹가림:Anthropic 키›\r\n‹가림:Anthropic 키›\r\n')
  })
  it('가리지 않기로 한 값은 옵션을 매번 새로 읽어 따른다', async () => {
    let allow = new Set<string>()
    const s = new ScrollbackStore(dir, () => ({ allow }))
    await save(s, ['p1'], { p1: 'DB_PASSWORD=hunter2long' })
    expect(readFileSync(join(dir, 'p1.txt'), 'utf8')).toBe('DB_PASSWORD=‹가림:비밀번호›')
    const { secretHash } = await import('../../src/shared/redact')
    allow = new Set([secretHash('hunter2long')])
    await save(s, ['p1'], { p1: 'DB_PASSWORD=hunter2long' })
    expect(readFileSync(join(dir, 'p1.txt'), 'utf8')).toBe('DB_PASSWORD=hunter2long')
  })
})

describe('ScrollbackStore.redactExisting — 이미 남은 파일 한 번 정리', () => {
  it('원문이 든 파일을 가려 다시 쓰고(0600) 진행을 알린 뒤 표시 파일을 만든다', async () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'p1.txt'), `key ${ANT}`, { mode: 0o644 })
    writeFileSync(join(dir, 'p2.txt'), 'nothing here')
    const marker = join(root, 'scrollback-redacted-v1')
    const seen: Array<[number, number]> = []
    const s = new ScrollbackStore(dir)
    const r = await s.redactExisting(marker, (st) => seen.push([st.done, st.total]))
    expect(r).toMatchObject({ state: 'done', done: 2, total: 2, masked: 1, failed: [] })
    expect(readFileSync(join(dir, 'p1.txt'), 'utf8')).toBe('key ‹가림:Anthropic 키›')
    expect(statSync(join(dir, 'p1.txt')).mode & 0o777).toBe(0o600)
    expect(readFileSync(join(dir, 'p2.txt'), 'utf8')).toBe('nothing here')
    expect(existsSync(marker)).toBe(true)
    expect(seen.at(-1)).toEqual([2, 2])
    // 표시 파일이 있으면 다시 하지 않는다
    writeFileSync(join(dir, 'p3.txt'), ANT)
    expect((await s.redactExisting(marker, () => {})).total).toBe(0)
    expect(readFileSync(join(dir, 'p3.txt'), 'utf8')).toBe(ANT)
  })
  it('못 읽은 파일은 failed 에 · 표시 파일은 만들지 않는다 · 다시 시도 · 지우기', async () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'p1.txt'), ANT)
    writeFileSync(join(dir, 'p2.txt'), ANT, { mode: 0o000 }) // 읽을 수 없는 파일
    const marker = join(root, 'scrollback-redacted-v1')
    const s = new ScrollbackStore(dir)
    const r = await s.redactExisting(marker, () => {})
    expect(r.failed).toEqual(['p2.txt'])
    expect(existsSync(marker)).toBe(false)
    expect(await s.fixRedact('delete', 'p2.txt', marker)).toMatchObject({ failed: [], state: 'done' })
    expect(existsSync(join(dir, 'p2.txt'))).toBe(false)
    expect(existsSync(marker)).toBe(true)
  })
  it('지우기는 pane 파일 이름 모양만 받는다', async () => {
    const s = new ScrollbackStore(dir)
    await expect(s.fixRedact('delete', '../state.json', join(root, 'm'))).rejects.toThrow()
  })
})
