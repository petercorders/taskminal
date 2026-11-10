import { describe, expect, it } from 'vitest'
import { matchScore, nextScope, paletteItems, type PaletteInput } from '../../src/shared/palette'

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
    expect(items.map((i) => `${i.kind}:${i.id}`)).toEqual(['task:t1', 'task:t2', 'command:next-task'])
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
    expect(items.at(-1)!.kind).toBe('output')
    expect(out[0]).toMatchObject({ paneId: 'p', line: 0, detail: 'A 일감' })
    expect(out[0]!.marks).toEqual([0, 1])
  })

  it('아무것도 안 맞으면 ‘그 이름으로 새 일감’ 하나 (명령 · 템플릿 · 출력 범위에서는 없음)', () => {
    expect(paletteItems(input({ query: '  새 서버 ' }))).toEqual([expect.objectContaining({ kind: 'create', label: '새 서버' })])
    expect(paletteItems(input({ query: 'zzz', scope: 'task' }))).toEqual([expect.objectContaining({ kind: 'create' })])
    expect(paletteItems(input({ query: 'zzz', scope: 'command' }))).toEqual([])
    expect(paletteItems(input({ query: '   ' })).some((i) => i.kind === 'create')).toBe(false)
    expect(paletteItems(input({ tasks: [], query: '  ', scope: 'task' }))).toEqual([]) // 공백뿐이면 빈 이름의 새 일감을 내지 않는다
  })
})

describe('nextScope', () => {
  it('전체 → 일감 → 명령 → 템플릿 → 출력 → 전체, 거꾸로도', () => {
    expect(nextScope('all', 1)).toBe('task')
    expect(nextScope('output', 1)).toBe('all')
    expect(nextScope('all', -1)).toBe('output')
  })
})
