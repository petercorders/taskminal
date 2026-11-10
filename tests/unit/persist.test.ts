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

  it('version 이 1 이거나 없으면 ok', () => {
    for (const text of ['{"version":1}', '{}']) expect(readStateText(text, newId).kind).toBe('ok')
  })

  it('version 이 1 이 아닌 다른 값(문자열 · 객체)이면 모르는 형식 — newer 로 보고 덮어쓰지 않는다', () => {
    expect(readStateText('{"version":"2"}', newId)).toEqual({ kind: 'newer', version: '2' })
    expect(readStateText('{"version":{"major":2}}', newId).kind).toBe('newer')
  })

  it('저장한 그대로의 파일은 lossy 가 아니다 (키 순서 · 들여쓰기는 상관없음)', () => {
    const s = emptyState()
    const pretty = JSON.stringify(s, null, 2)
    expect(readStateText(pretty, newId)).toEqual({ kind: 'ok', state: s, lossy: false })
    const reordered = JSON.stringify({ settings: s.settings, activeTaskId: null, tasks: [], version: 1 })
    expect(readStateText(reordered, newId)).toMatchObject({ lossy: false })
  })

  it('정규화가 무언가를 버렸으면 lossy — 첫 저장 전에 원본을 백업해야 한다', () => {
    const unknownField = { ...emptyState(), unknownField: 1 }
    expect(readStateText(JSON.stringify(unknownField), newId)).toEqual({ kind: 'ok', state: emptyState(), lossy: true })
    const tasksNotArray = { ...emptyState(), tasks: { a: { id: 'a' } } }
    expect(readStateText(JSON.stringify(tasksNotArray), newId)).toMatchObject({ kind: 'ok', lossy: true })
  })

  it('정규화가 기본값을 더하기만 했으면 lossy 가 아니다 — 옛 앱의 파일(새 설정 칸 없음)에 백업 · 경고를 내지 않는다', () => {
    const { theme: _t, notify: _n, keys: _k, confirmQuit: _c, ...oldSettings } = emptyState().settings
    const old = { ...emptyState(), settings: oldSettings }
    const r = readStateText(JSON.stringify(old), newId)
    expect(r).toMatchObject({ kind: 'ok', lossy: false })
    expect(r.kind === 'ok' && r.state.settings.theme).toBe('dark')
  })

  it('있던 값이 바뀌었으면 lossy (틀린 값 → 기본값, 배열 항목이 빠짐)', () => {
    const bad = { ...emptyState(), settings: { ...emptyState().settings, theme: 'blue' } }
    expect(readStateText(JSON.stringify(bad), newId)).toMatchObject({ lossy: true })
    const s = emptyState()
    const dupStatus = { ...s, settings: { ...s.settings, statuses: [...s.settings.statuses, s.settings.statuses[0]] } }
    expect(readStateText(JSON.stringify(dupStatus), newId)).toMatchObject({ lossy: true })
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
