import { describe, expect, it } from 'vitest'
import { findLine, OscScanner, PaneWatch, START_GRACE_MS, type Clock, type WaitResult } from '../../src/shared/pane-watch'

/** 손으로 돌리는 시계 */
function fakeClock(): Clock & { tick(ms: number): void } {
  let now = 1000
  let timers: Array<{ at: number; fn: () => void; id: number }> = []
  let seq = 0
  return {
    now: () => now,
    later(fn, ms) {
      const id = ++seq
      timers.push({ at: now + ms, fn, id })
      return () => void (timers = timers.filter((t) => t.id !== id))
    },
    tick(ms) {
      const end = now + ms
      for (;;) {
        const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        timers = timers.filter((t) => t !== due)
        now = due.at
        due.fn()
      }
      now = end
    },
  }
}

const settled = async (p: Promise<WaitResult>): Promise<WaitResult | 'pending'> => Promise.race([p, new Promise<'pending'>((r) => setTimeout(() => r('pending'), 0))])

const C = '\x1b]133;C\x07'
const D = (code: number) => `\x1b]133;D;${code}\x07`
const A = '\x1b]133;A\x07'

describe('OscScanner', () => {
  it('조각난 OSC · ESC \\ 끝 · CSI 를 뺀 글', () => {
    const s = new OscScanner()
    expect(s.push('hi\x1b]133;')).toEqual({ marks: [], text: 'hi' })
    expect(s.push('D;2\x07\x1b[31mred\x1b[0m\n')).toEqual({ marks: [{ kind: 'end', code: 2 }], text: 'red\n' })
    expect(s.push('\x1b]133;C\x1b\\x')).toEqual({ marks: [{ kind: 'start' }], text: 'x' })
    expect(s.push('\x1b')).toEqual({ marks: [], text: '' })
    expect(s.push('[2Kok\x1b]0;title\x07\r')).toEqual({ marks: [], text: 'ok' })
    expect(s.push(A).marks).toEqual([{ kind: 'prompt' }])
  })
})

describe('PaneWatch', () => {
  const opts = { timeoutMs: 60_000, quietMs: 3000 }

  it('exit: 도는 명령의 끝 코드 · 걸린 시간', async () => {
    const clock = fakeClock()
    const w = new PaneWatch(clock)
    w.feed('p', C)
    const { result } = w.wait('p', { kind: 'exit' }, opts)
    clock.tick(2000)
    expect(await settled(result)).toBe('pending')
    w.feed('p', 'done\n' + D(3) + A)
    expect(await result).toEqual({ kind: 'exit', code: 3, ms: 2000 })
  })

  it('exit: 도는 것이 없으면 바로 마지막 결과', async () => {
    const w = new PaneWatch(fakeClock())
    w.feed('p', C + D(0) + A)
    expect(await w.wait('p', { kind: 'exit' }, opts).result).toEqual({ kind: 'exit', code: 0, already: true })
  })

  it('exit: 아직 보내지 않은 시작 명령(pending)은 그 명령이 시작해 끝날 때까지 — 첫 프롬프트에서 끝나지 않는다', async () => {
    const w = new PaneWatch(fakeClock())
    const { result } = w.wait('p', { kind: 'exit' }, { ...opts, pending: true })
    w.feed('p', A)
    expect(await settled(result)).toBe('pending')
    // 그 명령이 시작하기 전에 온 끝(D — 앞 명령의 것)으로도 끝나지 않는다
    w.feed('p', D(7) + A)
    expect(await settled(result)).toBe('pending')
    w.feed('p', C + 'DONE\n')
    w.feed('p', D(0) + A)
    expect(await result).toMatchObject({ kind: 'exit', code: 0 })
  })

  it('exit: 막 ↩ 를 보냈으면 시작을 잠깐 기다리고, 시작하지 않으면 마지막 결과', async () => {
    const clock = fakeClock()
    const w = new PaneWatch(clock)
    w.feed('p', C + D(1) + A)
    clock.tick(10) // 보낸 것은 그 명령 뒤
    w.sent('p', true)
    const a = w.wait('p', { kind: 'exit' }, opts)
    expect(await settled(a.result)).toBe('pending')
    w.feed('p', C)
    clock.tick(START_GRACE_MS + 10)
    expect(await settled(a.result)).toBe('pending') // 시작했다 — 끝까지
    w.feed('p', D(0))
    expect(await a.result).toMatchObject({ kind: 'exit', code: 0 })

    w.sent('p', true)
    const b = w.wait('p', { kind: 'exit' }, opts)
    clock.tick(START_GRACE_MS + 10)
    expect(await b.result).toEqual({ kind: 'exit', code: 0, already: true })
  })

  it('prompt: 도는 중이면 다음 프롬프트, 아니면 바로', async () => {
    const w = new PaneWatch(fakeClock())
    w.feed('p', C)
    const { result } = w.wait('p', { kind: 'prompt' }, opts)
    expect(await settled(result)).toBe('pending')
    w.feed('p', D(0))
    expect(await settled(result)).toBe('pending')
    w.feed('p', A)
    expect(await result).toEqual({ kind: 'prompt' })
    expect(await w.wait('p', { kind: 'prompt' }, opts).result).toEqual({ kind: 'prompt' })
  })

  it('idle: 출력이 quiet 동안 없으면 — 출력이 오면 다시 센다', async () => {
    const clock = fakeClock()
    const w = new PaneWatch(clock)
    w.feed('p', 'x')
    const { result } = w.wait('p', { kind: 'idle' }, opts)
    clock.tick(2000)
    w.feed('p', 'more')
    clock.tick(2000)
    expect(await settled(result)).toBe('pending')
    clock.tick(1001)
    expect(await result).toEqual({ kind: 'idle', quietMs: 3000 })
  })

  it('idle: 보낸 입력도 출력처럼 센다 (보낸 직후 바로 조용하다고 하지 않게)', async () => {
    const clock = fakeClock()
    const w = new PaneWatch(clock)
    w.seed('p', { running: false, lastOutputAt: 0 })
    w.sent('p', true)
    const { result } = w.wait('p', { kind: 'idle' }, opts)
    expect(await settled(result)).toBe('pending')
    clock.tick(3000)
    expect(await result).toMatchObject({ kind: 'idle' })
  })

  it('text: 지금 화면에 있으면 바로, 아니면 뒤 출력에서 (조각을 넘어서도)', async () => {
    const w = new PaneWatch(fakeClock())
    expect(await w.wait('p', { kind: 'text', text: 'PASS' }, { ...opts, screen: 'a\n  12 PASS ok\nb' }).result).toEqual({ kind: 'text', line: '12 PASS ok' })
    const { result } = w.wait('p', { kind: 'text', text: 'BUILD OK' }, { ...opts, screen: 'nothing' })
    w.feed('p', 'BUILD \x1b[32m')
    expect(await settled(result)).toBe('pending')
    w.feed('p', 'OK\x1b[0m in 3s\r\n')
    expect(await result).toEqual({ kind: 'text', line: 'BUILD OK in 3s' })
  })

  it('셸이 끝나면 어느 조건이든 shell-exit · 끝난 셸은 바로', async () => {
    const w = new PaneWatch(fakeClock())
    const a = w.wait('p', { kind: 'text', text: 'never' }, opts)
    w.exit('p', 0)
    expect(await a.result).toEqual({ kind: 'shell-exit', code: 0 })
    expect(await w.wait('p', { kind: 'idle' }, opts).result).toEqual({ kind: 'shell-exit', code: 0 })
  })

  it('시간 초과 · 취소는 타이머를 남기지 않는다', async () => {
    const clock = fakeClock()
    const w = new PaneWatch(clock)
    w.feed('p', C)
    const a = w.wait('p', { kind: 'exit' }, { ...opts, timeoutMs: 5000 })
    clock.tick(5000)
    expect(await a.result).toEqual({ kind: 'timeout' })
    const b = w.wait('p', { kind: 'exit' }, opts)
    b.cancel()
    expect(await b.result).toEqual({ kind: 'cancelled' })
    expect(w.snapshot('p').waiters).toBe(0)
  })

  it('seed: 지킴이가 도는 중이라고 하면 끝을 기다린다 (이미 본 pane 은 덮지 않는다)', async () => {
    const w = new PaneWatch(fakeClock())
    w.seed('p', { running: true, lastOutputAt: 0 })
    const { result } = w.wait('p', { kind: 'exit' }, opts)
    expect(await settled(result)).toBe('pending')
    w.feed('p', D(0))
    expect(await result).toMatchObject({ kind: 'exit', code: 0 })
    w.seed('p', { running: true, lastOutputAt: 0 })
    expect(w.snapshot('p').running).toBe(false)
  })
})

describe('findLine', () => {
  it('그 글이 든 줄', () => {
    expect(findLine('a\nfoo bar\nc', 'bar')).toBe('foo bar')
    expect(findLine('abc', 'x')).toBeNull()
  })
})
