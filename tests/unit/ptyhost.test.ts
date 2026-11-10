import { describe, expect, it } from 'vitest'
import {
  encodeFrame,
  HEADLESS_SCROLLBACK,
  LineDecoder,
  memoryWarning,
  orphanSessions,
  parseRequest,
  reconnectDelay,
  replayOsc,
  socketPath,
  socketVersion,
  summarizeResume,
  type SessionInfo,
} from '../../src/shared/ptyhost'

const bytes = (s: string) => new TextEncoder().encode(s)

describe('LineDecoder', () => {
  const collect = (max?: number) => {
    const out: unknown[] = []
    return { out, dec: new LineDecoder((v) => out.push(v), max) }
  }

  it('한 조각에 여러 줄 · 줄 가운데서 끊긴 조각을 이어 붙인다', () => {
    const { out, dec } = collect()
    const s = encodeFrame({ a: 1 }) + encodeFrame({ b: 2 }) + encodeFrame({ c: 3 })
    dec.push(bytes(s.slice(0, 5)))
    dec.push(bytes(s.slice(5, 17)))
    dec.push(bytes(s.slice(17)))
    expect(out).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }])
  })

  it('한글 바이트 가운데서 끊겨도 글자가 깨지지 않는다', () => {
    const { out, dec } = collect()
    const b = bytes(encodeFrame({ data: '한글 출력' }))
    for (let i = 0; i < b.length; i++) dec.push(b.subarray(i, i + 1)) // 한 바이트씩
    expect(out).toEqual([{ data: '한글 출력' }])
  })

  it('JSON 이 아닌 줄 · 빈 줄은 버리고 다음 줄은 받는다', () => {
    const { out, dec } = collect()
    dec.push(bytes('not json\n\n' + encodeFrame({ ok: true })))
    expect(out).toEqual([{ ok: true }])
  })

  it('한 조각에 온 상한 넘는 줄도 버린다', () => {
    const { out, dec } = collect(20)
    dec.push(bytes('{"x":"' + 'a'.repeat(30) + '"}\n' + encodeFrame({ y: 2 })))
    expect(out).toEqual([{ y: 2 }])
  })

  it('줄바꿈 없이 상한을 넘으면 쥐고 있던 글을 놓는다 (끝없는 줄이 메모리를 채우지 않게)', () => {
    const { dec } = collect(20)
    dec.push(bytes('x'.repeat(15)))
    dec.push(bytes('x'.repeat(15)))
    expect(dec.buffered).toBe(0)
    dec.push(bytes('x'.repeat(100)))
    expect(dec.buffered).toBe(0)
  })

  it('상한을 넘는 줄은 줄 끝까지 버린다 (조각으로 와도)', () => {
    const { out, dec } = collect(20)
    dec.push(bytes('{"x":"' + 'a'.repeat(30)))
    dec.push(bytes('bbb"}\n' + encodeFrame({ y: 1 })))
    expect(out).toEqual([{ y: 1 }])
  })
})

describe('parseRequest', () => {
  const spawn = { op: 'spawn', id: 1, paneId: 'p1', file: '/bin/zsh', args: ['-l'], cwd: '/Users/me', env: { TERM: 'xterm-256color' }, cols: 80, rows: 24 }

  it('맞는 요청은 그대로 (id 포함)', () => {
    expect(parseRequest(spawn)).toEqual(spawn)
    expect(parseRequest({ op: 'write', paneId: 'p1', data: 'ls\r' })).toEqual({ op: 'write', paneId: 'p1', data: 'ls\r' })
    expect(parseRequest({ op: 'list', id: 3 })).toEqual({ op: 'list', id: 3, clearUnseen: false })
    expect(parseRequest({ op: 'list', clearUnseen: true })).toEqual({ op: 'list', clearUnseen: true })
    expect(parseRequest({ op: 'tail', id: 2, paneId: 'p1', lines: 20 })).toEqual({ op: 'tail', id: 2, paneId: 'p1', lines: 20 })
  })

  it('나쁜 paneId · 크기 · 상대 경로 · 큰 입력 · 모르는 op 는 거절', () => {
    expect(parseRequest({ ...spawn, paneId: '../x' })).toBeNull()
    expect(parseRequest({ ...spawn, cols: 0 })).toBeNull()
    expect(parseRequest({ ...spawn, file: 'zsh' })).toBeNull()
    expect(parseRequest({ ...spawn, cwd: 'relative' })).toBeNull()
    expect(parseRequest({ ...spawn, env: { 'A=B': 'x' } })).toBeNull()
    expect(parseRequest({ ...spawn, args: ['ok', 1] })).toBeNull()
    expect(parseRequest({ op: 'write', paneId: 'p1', data: 'x'.repeat(1024 * 1024 + 1) })).toBeNull()
    expect(parseRequest({ op: 'resize', paneId: 'p1', cols: 80, rows: 2000 })).toBeNull()
    expect(parseRequest({ op: 'tail', paneId: 'p1', lines: 0 })).toBeNull()
    expect(parseRequest({ op: 'exec', paneId: 'p1' })).toBeNull()
    expect(parseRequest({ op: 'list', id: -1 })).toBeNull()
    expect(parseRequest(null)).toBeNull()
  })
})

describe('socketPath', () => {
  const hash = () => 'abcdef0123456789'
  it('짧으면 userData 안 · 버전이 이름에', () => {
    expect(socketPath('/Users/me/Library/Application Support/Taskminal', 1, '/tmp', hash)).toBe('/Users/me/Library/Application Support/Taskminal/ptyhost-v1.sock')
  })
  it('100바이트를 넘으면 tmp 의 해시 이름', () => {
    const long = '/private/var/folders/ly/' + 'x'.repeat(80)
    expect(socketPath(long, 1, '/var/tmp/', hash)).toBe('/var/tmp/taskminal-abcdef012345-v1.sock')
  })
  it('한글 경로는 바이트로 잰다', () => {
    const p = '/Users/' + '가'.repeat(26) // 7 + 78 바이트 + '/ptyhost-v1.sock' 16 = 101 > 100 (글자 수로는 49)
    expect(socketPath(p, 1, '/tmp', hash)).toBe('/tmp/taskminal-abcdef012345-v1.sock')
  })
  it('파일 이름에서 버전', () => {
    expect(socketVersion('ptyhost-v1.sock')).toBe(1)
    expect(socketVersion('ptyhost-v12.sock')).toBe(12)
    expect(socketVersion('ptyhost.sock')).toBeNull()
    expect(socketVersion('ptyhost-v1.sock.bak')).toBeNull()
    expect(socketVersion('taskminal-abcdef012345-v3.sock', 'taskminal-abcdef012345')).toBe(3)
    expect(socketVersion('taskminal-other-v3.sock', 'taskminal-abcdef012345')).toBeNull()
  })
})

describe('orphanSessions · memoryWarning · reconnectDelay · replayOsc', () => {
  it('상태에 없는 paneId 만 주인 없음', () => {
    const s = [{ paneId: 'a' }, { paneId: 'b' }, { paneId: 'c' }]
    expect(orphanSessions(s, new Set(['a', 'c']))).toEqual([{ paneId: 'b' }])
    expect(orphanSessions(s, [])).toEqual(s)
  })
  it('1GB 이상 또는 셸 100개 이상이면 경고', () => {
    expect(memoryWarning({ rss: 1024 * 1024 * 1024, sessions: 1 })).toBe(true)
    expect(memoryWarning({ rss: 1024 * 1024 * 1024 - 1, sessions: 99 })).toBe(false)
    expect(memoryWarning({ rss: 0, sessions: 100 })).toBe(true)
    expect(memoryWarning({ rss: 2 * 1024 * 1024, sessions: 1 }, 1)).toBe(true)
  })
  it('다시 연결은 1·2·4·8·16초 다섯 번, 시험은 비율로 줄인다', () => {
    expect([0, 1, 2, 3, 4].map((n) => reconnectDelay(n))).toEqual([1000, 2000, 4000, 8000, 16000])
    expect(reconnectDelay(5)).toBeNull()
    expect(reconnectDelay(2, 50)).toBe(200)
  })
  it('다시 붙을 때 명령 글자 · 실행 중 표시만 되돌린다', () => {
    expect(replayOsc({ commandOsc: 'cmd;sleep 600', running: true })).toBe('\x1b]6973;cmd;sleep 600\x07\x1b]133;C\x07')
    expect(replayOsc({ running: false })).toBe('')
  })
  it('headless 줄 상한은 2000 (측정: 100 pane ≈ 450MB)', () => {
    expect(HEADLESS_SCROLLBACK).toBe(2000)
  })
})

describe('summarizeResume', () => {
  const info = (paneId: string, p: Partial<SessionInfo> = {}): SessionInfo => ({
    paneId, pid: 1, startedAt: 0, lastOutputAt: 0, attached: false, running: false, unseen: { waiting: false }, detachedMs: 0, ...p,
  })
  it('상태에 있는 살아 있는 셸만 이어짐으로 세고, 가장 긴 떨어진 시간', () => {
    const r = summarizeResume([info('a', { detachedMs: 41_000 }), info('b', { detachedMs: 5_000 }), info('orphan', { detachedMs: 99_000 }), info('c', { exited: { exitCode: 0, signal: null } })], ['a', 'b', 'c'])
    expect(r).toEqual({ resumed: 2, awayMs: 41_000, waiting: [], failed: [] })
  })
  it('꺼져 있던 동안의 입력 기다림 · 실패 (주인 없는 셸은 빼고)', () => {
    const r = summarizeResume(
      [info('a', { unseen: { waiting: true, message: '고칠까요? (y/n)' } }), info('b', { unseen: { waiting: true } }), info('c', { unseen: { waiting: false, failed: 2 } }), info('x', { unseen: { waiting: true } })],
      ['a', 'b', 'c'],
    )
    expect(r.waiting).toEqual([{ paneId: 'a', message: '고칠까요? (y/n)' }, { paneId: 'b' }])
    expect(r.failed).toEqual([{ paneId: 'c', code: 2 }])
  })
})
