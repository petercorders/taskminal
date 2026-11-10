import { describe, expect, it } from 'vitest'
import { isPaneId, MAX_WRITE, OutputBatcher, validSize, validWrite } from '../../src/shared/pty'

describe('isPaneId', () => {
  it('영숫자 · _ · - 1~64자만 받는다', () => {
    expect(isPaneId('pane-1')).toBe(true)
    expect(isPaneId('a_B-9')).toBe(true)
    expect(isPaneId('x'.repeat(64))).toBe(true)
  })
  it('빈 값 · 경로 문자 · 65자 · 문자열 아님은 거절', () => {
    expect(isPaneId('')).toBe(false)
    expect(isPaneId('../x')).toBe(false)
    expect(isPaneId('a b')).toBe(false)
    expect(isPaneId('x'.repeat(65))).toBe(false)
    expect(isPaneId(1)).toBe(false)
    expect(isPaneId(undefined)).toBe(false)
  })
})

describe('validSize', () => {
  it('1~1000 정수만', () => {
    expect(validSize(80, 24)).toBe(true)
    expect(validSize(1, 1000)).toBe(true)
    expect(validSize(0, 24)).toBe(false)
    expect(validSize(80, 1001)).toBe(false)
    expect(validSize(80.5, 24)).toBe(false)
    expect(validSize(Number.NaN, 24)).toBe(false)
    expect(validSize('80', 24)).toBe(false)
  })
})

describe('validWrite', () => {
  it('문자열이고 상한 이하만', () => {
    expect(validWrite('ls\r')).toBe(true)
    expect(validWrite('x'.repeat(MAX_WRITE))).toBe(true)
    expect(validWrite('x'.repeat(MAX_WRITE + 1))).toBe(false)
    expect(validWrite(42)).toBe(false)
  })
})

// 시계를 손으로 돌리는 가짜 scheduler
function fakeClock() {
  const pending: Array<{ fn: () => void; ms: number; cancelled: boolean }> = []
  return {
    schedule: (fn: () => void, ms: number) => {
      const t = { fn, ms, cancelled: false }
      pending.push(t)
      return () => {
        t.cancelled = true
      }
    },
    runAll: () => {
      for (const t of pending.splice(0)) if (!t.cancelled) t.fn()
    },
    pendingCount: () => pending.filter((t) => !t.cancelled).length,
    lastDelay: () => pending.at(-1)?.ms,
  }
}

describe('OutputBatcher', () => {
  const setup = () => {
    const clock = fakeClock()
    const sent: Array<[string, string]> = []
    const b = new OutputBatcher((id, data) => sent.push([id, data]), clock.schedule)
    return { clock, sent, b }
  }

  it('타이머 안에 들어온 조각을 한 번에 보낸다', () => {
    const { clock, sent, b } = setup()
    b.push('p', 'a')
    b.push('p', 'b')
    b.push('p', 'c')
    expect(sent).toEqual([])
    expect(clock.pendingCount()).toBe(1)
    expect(clock.lastDelay()).toBe(8)
    clock.runAll()
    expect(sent).toEqual([['p', 'abc']])
  })

  it('모인 양이 64KB 를 넘으면 타이머를 기다리지 않고 바로 보낸다', () => {
    const { clock, sent, b } = setup()
    b.push('p', 'x'.repeat(40_000))
    expect(sent).toEqual([])
    b.push('p', 'y'.repeat(30_000))
    expect(sent).toHaveLength(1)
    expect(sent[0]![1]).toHaveLength(70_000)
    expect(clock.pendingCount()).toBe(0)
    clock.runAll()
    expect(sent).toHaveLength(1)
  })

  it('pane 마다 따로 모은다', () => {
    const { clock, sent, b } = setup()
    b.push('a', '1')
    b.push('b', '2')
    b.push('a', '3')
    clock.runAll()
    expect(sent).toEqual([
      ['a', '13'],
      ['b', '2'],
    ])
  })

  it('drop 한 pane 의 남은 출력은 보내지 않는다', () => {
    const { clock, sent, b } = setup()
    b.push('p', 'late')
    b.drop('p')
    clock.runAll()
    expect(sent).toEqual([])
  })

  it('flush 는 남은 것을 바로 보낸다 (셸이 끝나기 전 마지막 출력)', () => {
    const { clock, sent, b } = setup()
    b.push('p', 'bye')
    b.flush('p')
    expect(sent).toEqual([['p', 'bye']])
    clock.runAll()
    expect(sent).toHaveLength(1)
  })
})
