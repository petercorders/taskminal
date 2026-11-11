import { describe, expect, it } from 'vitest'
import { markSegments, matchScore, nextScope, paletteItems, type PaletteInput } from '../../src/shared/palette'

describe('matchScore', () => {
  it('앞부분 일치 > 낱말 시작 > 중간 일치 > 글자 순서만 맞음, 안 맞으면 null', () => {
    const prefix = matchScore('build server', 'bui')!.score
    const word = matchScore('run build', 'bui')!.score
    const middle = matchScore('rebuild', 'bui')!.score
    const fuzzy = matchScore('b-u-i', 'bui')!.score
    expect(prefix).toBeGreaterThan(word)
    expect(word).toBeGreaterThan(middle)
    expect(middle).toBeGreaterThan(fuzzy)
    expect(matchScore('build', 'xyz')).toBeNull()
    expect(matchScore('ab', 'abc')).toBeNull()
  })

  it('대소문자 무시 · 한글 · 맞은 글자 위치(강조용)', () => {
    expect(matchScore('Taskminal', 'task')!.marks).toEqual([0, 1, 2, 3])
    expect(matchScore('B 일감', '일감')!.marks).toEqual([2, 3])
    expect(matchScore('찍계부 앱', '찍앱')!.marks).toEqual([0, 4])
  })

  it('빈 찾기는 모두 맞음(점수 0, 강조 없음)', () => {
    expect(matchScore('무엇이든', '')).toEqual({ score: 0, marks: [] })
  })
})

const input = (over: Partial<PaletteInput> = {}): PaletteInput => ({
  tasks: [
    { id: 't1', name: 'A 일감', detail: '/tmp' },
    { id: 't2', name: 'B 일감', detail: '/tmp' },
  ],
  commands: [
    { id: 'split-down', label: '아래로 나누기', hint: '⇧⌘D' },
    { id: 'next-task', label: '다음 일감', hint: '⌥⌘↓' },
  ],
  templates: [{ id: 'tpl', name: '기본' }],
  outputs: [],
  query: '',
  scope: 'all',
  ...over,
})

describe('paletteItems', () => {
  it('빈 찾기: 일감(주어진 순서) → 명령 → 템플릿', () => {
    expect(paletteItems(input()).map((i) => i.id)).toEqual(['t1', 't2', 'split-down', 'next-task', 'tpl'])
  })

  it('점수순, 같으면 종류 순서(일감 > 명령 > 템플릿 > 출력)', () => {
    const items = paletteItems(input({ query: '일감' }))
    expect(items.map((i) => `${i.kind}:${i.id}`)).toEqual(['task:t1', 'task:t2', 'command:next-task', 'create:일감'])
  })

  it('범위를 고르면 그 종류만', () => {
    expect(paletteItems(input({ query: '일감', scope: 'command' })).map((i) => i.id)).toEqual(['next-task'])
    expect(paletteItems(input({ query: '', scope: 'template' })).map((i) => i.id)).toEqual(['tpl'])
  })

  it('출력은 두 글자부터 · 최대 20줄 · 다른 것보다 뒤', () => {
    const outputs = Array.from({ length: 30 }, (_, i) => ({ paneId: 'p', taskName: 'A 일감', line: i, text: `일감 로그 ${i}` }))
    expect(paletteItems(input({ query: '일', outputs })).filter((i) => i.kind === 'output')).toHaveLength(0)
    const items = paletteItems(input({ query: '일감', outputs }))
    const out = items.filter((i) => i.kind === 'output')
    expect(out).toHaveLength(20)
    expect(items.filter((i) => i.kind !== 'create' && i.kind !== 'find-all').at(-1)!.kind).toBe('output') // '모두 보기' · 새 일감 줄만 그 뒤
    expect(out[0]).toMatchObject({ paneId: 'p', line: 0, detail: 'A 일감' })
    expect(out[0]!.marks).toEqual([0, 1])
  })

  it('출력 범위에서 두 글자부터 "모두 보기 ⇧⌘F" — 출력 뒤 · 새 일감 앞 (19단계)', () => {
    const outputs = [{ paneId: 'p', taskName: 'A 일감', line: 0, text: 'npm 로그' }]
    const kinds = paletteItems(input({ query: 'npm', outputs })).map((i) => i.kind)
    expect(kinds.slice(-3)).toEqual(['output', 'find-all', 'create'])
    expect(paletteItems(input({ query: 'n', outputs })).some((i) => i.kind === 'find-all')).toBe(false)
    expect(paletteItems(input({ query: 'npm', scope: 'command' })).some((i) => i.kind === 'find-all')).toBe(false)
  })

  it('기록: 명령 글자에 맞는 최근 것부터 · 같은 명령은 한 번 · 8개까지 · 빈 찾기에는 없음 (19단계)', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `h${i}`, cmd: `npm run t${i}`, taskName: 'A 일감' }))
    const history = [many[0]!, { id: 'dup', cmd: 'npm run t0', taskName: 'B 일감' }, ...many.slice(1)]
    const items = paletteItems(input({ query: 'npm run', history })).filter((i) => i.kind === 'history')
    expect(items).toHaveLength(8)
    expect(items[0]).toMatchObject({ id: 'h0', label: 'npm run t0', detail: 'A 일감', marks: [0, 1, 2, 3, 4, 5, 6] })
    expect(new Set(items.map((i) => i.label)).size).toBe(8)
    expect(items.some((i) => i.id === 'dup')).toBe(false)
    expect(paletteItems(input({ query: '', history })).some((i) => i.kind === 'history')).toBe(false)
    expect(paletteItems(input({ query: 'npm', history, scope: 'task' })).some((i) => i.kind === 'history')).toBe(false)
  })

  it('아무것도 안 맞으면 ‘그 이름으로 새 일감’ 하나 (명령 · 템플릿 · 출력 범위에서는 없음)', () => {
    expect(paletteItems(input({ query: '  새 서버 ' }))).toEqual([expect.objectContaining({ kind: 'create', label: '새 서버' })])
  })

  it('글자 순서만 맞는 것들이 있어도, 이름이 꼭 같은 일감이 없으면 맨 끝에 ‘새 일감’', () => {
    const items = paletteItems(input({ query: '다일' })) // '다음 일감' 이 글자 순서로 맞는다
    expect(items.map((i) => i.kind)).toEqual(['command', 'create'])
    expect(paletteItems(input({ query: 'a 일감' })).some((i) => i.kind === 'create')).toBe(false) // 이름이 같은 일감(대소문자 무시)이 있으면 없음
  })

  it('새 일감은 전체 · 일감 범위에서만, 공백뿐이면 없음', () => {
    expect(paletteItems(input({ query: 'zzz', scope: 'task' }))).toEqual([expect.objectContaining({ kind: 'create' })])
    expect(paletteItems(input({ query: 'zzz', scope: 'command' }))).toEqual([])
    expect(paletteItems(input({ query: '   ' })).some((i) => i.kind === 'create')).toBe(false)
    expect(paletteItems(input({ tasks: [], query: '  ', scope: 'task' }))).toEqual([]) // 공백뿐이면 빈 이름의 새 일감을 내지 않는다
  })
})

describe('markSegments', () => {
  it('맞은 자리를 강조 조각으로 — 위치는 UTF-16 기준이라 이모지 뒤도 맞는다', () => {
    const text = '🚀 deploy'
    const m = matchScore(text, 'dep')!
    expect(markSegments(text, m.marks)).toEqual([
      { text: '🚀 ', mark: false },
      { text: 'dep', mark: true },
      { text: 'loy', mark: false },
    ])
    expect(markSegments('abc', [])).toEqual([{ text: 'abc', mark: false }])
  })
})

describe('nextScope', () => {
  it('전체 → 일감 → 명령 → 템플릿 → 출력 → 전체, 거꾸로도', () => {
    expect(nextScope('all', 1)).toBe('task')
    expect(nextScope('output', 1)).toBe('all')
    expect(nextScope('all', -1)).toBe('output')
  })
})
