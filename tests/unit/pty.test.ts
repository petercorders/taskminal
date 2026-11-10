import { describe, expect, it } from 'vitest'
import { cleanExit, isPaneId, MAX_WRITE, OutputBatcher, shellEnv, splitForWrite, validSize, validWrite } from '../../src/shared/pty'

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

describe('splitForWrite', () => {
  it('상한 이하면 그대로 한 조각', () => {
    expect(splitForWrite('abc', 4)).toEqual(['abc'])
    expect(splitForWrite('', 4)).toEqual([])
  })
  it('상한보다 길면 나눠서 이어 붙이면 원문과 같다', () => {
    const parts = splitForWrite('abcdefghij', 4)
    expect(parts).toEqual(['abcd', 'efgh', 'ij'])
  })
  it('서로게이트 쌍(이모지)을 가르지 않는다', () => {
    const text = 'abc😀def' // '😀' 는 두 코드 단위, 3·4 번째 자리
    const parts = splitForWrite(text, 4)
    expect(parts.join('')).toBe(text)
    for (const p of parts) expect(p).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/)
  })
})

describe('shellEnv', () => {
  it('터미널 변수를 넣고 앱 · Electron 내부 변수는 빼고, 사용자 변수는 둔다', () => {
    const env = shellEnv({
      PATH: '/usr/bin',
      HOME: '/Users/x',
      LANG: 'ko_KR.UTF-8',
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_RENDERER_URL: 'http://localhost:5173',
      NODE_OPTIONS: '--inspect',
      TASKMINAL_USER_DATA: '/tmp/x',
      UNDEF: undefined,
    })
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/Users/x',
      LANG: 'ko_KR.UTF-8',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'Taskminal',
    })
  })
  it('LANG 이 없으면 UTF-8 을 넣는다 (Finder 실행)', () => {
    expect(shellEnv({}).LANG).toBe('en_US.UTF-8')
  })
  it('UTF-8 이 아닌 LC_ALL · LC_CTYPE · LANG 은 UTF-8 로 바로잡는다', () => {
    const env = shellEnv({ LANG: 'C', LC_ALL: 'C', LC_CTYPE: 'POSIX', LC_TIME: 'C' })
    expect(env.LANG).toBe('en_US.UTF-8')
    expect(env.LC_ALL).toBeUndefined()
    expect(env.LC_CTYPE).toBeUndefined()
    expect(env.LC_TIME).toBe('C') // 글자 인코딩과 상관없는 것은 그대로
  })
  it('UTF-8 인 LC_ALL 은 그대로 둔다', () => {
    const env = shellEnv({ LANG: 'C', LC_ALL: 'ko_KR.UTF-8' })
    expect(env.LC_ALL).toBe('ko_KR.UTF-8')
  })
})

describe('cleanExit', () => {
  it('exit 0 이고 신호가 없을 때만 깨끗한 끝 — 그때만 pane 을 바로 닫는다', () => {
    expect(cleanExit({ exitCode: 0, signal: null })).toBe(true)
    expect(cleanExit({ exitCode: 1, signal: null })).toBe(false)
    expect(cleanExit({ exitCode: 0, signal: 9 })).toBe(false)
  })
})
