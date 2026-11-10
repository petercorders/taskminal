import { describe, expect, it } from 'vitest'
import { emptyState } from '../../src/shared/model'
import { Debouncer, readStateText } from '../../src/shared/persist'

let n = 0
const newId = () => `id${++n}`

describe('readStateText', () => {
  it('파일이 없으면 missing', () => {
    expect(readStateText(null, newId)).toEqual({ kind: 'missing' })
  })

  it('JSON 이 아니거나 객체가 아니면 corrupt', () => {
    expect(readStateText('', newId).kind).toBe('corrupt')
    expect(readStateText('{nope', newId).kind).toBe('corrupt')
    expect(readStateText('[]', newId).kind).toBe('corrupt')
    expect(readStateText('null', newId).kind).toBe('corrupt')
    expect(readStateText('"x"', newId).kind).toBe('corrupt')
  })

  it('version 이 1 보다 큰 수면 newer — 옛 앱이 모르는 칸을 버리고 덮어쓰지 않게', () => {
    expect(readStateText('{"version":2,"tasks":[]}', newId)).toEqual({ kind: 'newer', version: 2 })
    expect(readStateText('{"version":1.5}', newId)).toEqual({ kind: 'newer', version: 1.5 })
  })

  it('version 이 1 이거나 없거나 수가 아니면 정규화해서 ok', () => {
    for (const text of ['{"version":1}', '{}', '{"version":"2"}']) {
      const r = readStateText(text, newId)
      expect(r.kind).toBe('ok')
    }
  })

  it('정상 파일은 normalizeState 를 거친 상태', () => {
    const saved = { ...emptyState(), unknownField: 1 }
    const r = readStateText(JSON.stringify(saved), newId)
    expect(r).toEqual({ kind: 'ok', state: emptyState() })
  })
})

function fakeClock() {
  const pending: Array<{ fn: () => void; cancelled: boolean; ms: number }> = []
  return {
    schedule: (fn: () => void, ms: number) => {
      const t = { fn, cancelled: false, ms }
      pending.push(t)
      return () => {
        t.cancelled = true
      }
    },
    runAll: () => {
      for (const t of pending.splice(0)) if (!t.cancelled) t.fn()
    },
    live: () => pending.filter((t) => !t.cancelled),
  }
}

describe('Debouncer', () => {
  const setup = () => {
    const clock = fakeClock()
    const written: number[] = []
    const d = new Debouncer<number>((v) => written.push(v), clock.schedule, 300)
    return { clock, written, d }
  }

  it('여러 번 push 하면 마지막 값만 한 번 쓴다', () => {
    const { clock, written, d } = setup()
    d.push(1)
    d.push(2)
    d.push(3)
    expect(written).toEqual([])
    expect(clock.live()).toHaveLength(1)
    expect(clock.live()[0]!.ms).toBe(300)
    clock.runAll()
    expect(written).toEqual([3])
  })

  it('flush 는 남은 값을 바로 쓰고, 그 뒤 타이머는 쓰지 않는다', () => {
    const { clock, written, d } = setup()
    d.push(7)
    d.flush()
    expect(written).toEqual([7])
    clock.runAll()
    expect(written).toEqual([7])
  })

  it('남은 값이 없으면 flush 는 아무것도 안 쓴다', () => {
    const { written, d } = setup()
    d.flush()
    expect(written).toEqual([])
  })
})
