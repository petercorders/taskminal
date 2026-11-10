import { describe, expect, test } from 'vitest'
import { clampRatio, cyclePane, hasPane, layoutRects, paneIds, removePane, setRatioAt, splitPane } from '../../src/shared/layout'
import type { Layout } from '../../src/shared/types'

const pane = (paneId: string): Layout => ({ type: 'pane', paneId })
const split = (dir: 'right' | 'down', a: Layout, b: Layout, ratio = 0.5): Layout => ({ type: 'split', dir, ratio, a, b })

// [p1 | [p2 / p3]]
const three = split('right', pane('p1'), split('down', pane('p2'), pane('p3')), 0.6)

describe('paneIds', () => {
  test('화면 순서(왼→오, 위→아래)로 모은다', () => {
    expect(paneIds(three)).toEqual(['p1', 'p2', 'p3'])
    expect(hasPane(three, 'p3')).toBe(true)
    expect(hasPane(three, 'zz')).toBe(false)
  })
})

describe('splitPane', () => {
  test('원래 pane 은 a(왼쪽/위), 새 pane 은 b(오른쪽/아래), 비율 0.5', () => {
    expect(splitPane(pane('p1'), 'p1', 'down', 'n')).toEqual(split('down', pane('p1'), pane('n')))
  })

  test('트리 안쪽 pane 을 나누면 그 자리만 바뀐다', () => {
    const out = splitPane(three, 'p3', 'right', 'n')
    expect(out).toEqual(split('right', pane('p1'), split('down', pane('p2'), split('right', pane('p3'), pane('n'))), 0.6))
    expect(paneIds(out)).toEqual(['p1', 'p2', 'p3', 'n'])
  })

  test('없는 id 면 같은 객체를 돌려준다 (불필요한 다시 그리기 방지)', () => {
    expect(splitPane(three, 'zz', 'right', 'n')).toBe(three)
  })
})

describe('removePane', () => {
  test('마지막 pane 을 빼면 null', () => {
    expect(removePane(pane('p1'), 'p1')).toBeNull()
  })

  test('형제가 부모 자리를 차지한다', () => {
    expect(removePane(three, 'p2')).toEqual(split('right', pane('p1'), pane('p3'), 0.6))
    expect(removePane(three, 'p1')).toEqual(split('down', pane('p2'), pane('p3')))
  })

  test('없는 id 면 같은 객체', () => {
    expect(removePane(three, 'zz')).toBe(three)
  })
})

describe('setRatioAt · clampRatio', () => {
  test('경로가 가리키는 분할만 바꾼다', () => {
    const out = setRatioAt(three, ['b'], 0.3)
    expect(out).toEqual(split('right', pane('p1'), split('down', pane('p2'), pane('p3'), 0.3), 0.6))
    expect(setRatioAt(three, [], 0.7)).toMatchObject({ ratio: 0.7 })
  })

  test('0.1~0.9 로 막고 숫자가 아니면 0.5', () => {
    expect(clampRatio(0)).toBe(0.1)
    expect(clampRatio(2)).toBe(0.9)
    expect(clampRatio(Number.NaN)).toBe(0.5)
    expect(setRatioAt(three, [], 5)).toMatchObject({ ratio: 0.9 })
  })

  test('비율이 그대로면(막은 뒤 같은 값 포함) 같은 객체', () => {
    expect(setRatioAt(three, [], 0.6)).toBe(three)
    const edge = split('right', pane('a'), pane('b'), 0.9)
    expect(setRatioAt(edge, [], 5)).toBe(edge)
  })

  test('경로가 pane 을 가리키거나 틀리면 그대로', () => {
    expect(setRatioAt(three, ['a'], 0.3)).toBe(three)
    expect(setRatioAt(three, ['a', 'b'], 0.3)).toBe(three)
  })
})

describe('cyclePane', () => {
  test('다음 · 이전, 끝에서는 처음으로 돈다', () => {
    expect(cyclePane(three, 'p1', 1)).toBe('p2')
    expect(cyclePane(three, 'p3', 1)).toBe('p1')
    expect(cyclePane(three, 'p1', -1)).toBe('p3')
  })

  test('모르는 id 면 첫 pane', () => {
    expect(cyclePane(three, 'zz', 1)).toBe('p1')
  })
})

describe('layoutRects', () => {
  const r = (x: number, y: number, w: number, h: number) => ({ x, y, w, h })

  test('pane 하나는 전체, 분할선 없음', () => {
    expect(layoutRects(pane('p1'))).toEqual({ panes: [{ paneId: 'p1', ...r(0, 0, 1, 1) }], dividers: [] })
  })

  test('[p1 | [p2 / p3]] 0.6: 사각형은 비율대로, 분할선은 a 와 b 의 경계 · 경로 · 부모 사각형', () => {
    const out = layoutRects(three)
    const round = (o: object) =>
      Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v * 1000) / 1000 : v]))
    expect(out.panes.map(round)).toEqual([
      { paneId: 'p1', ...r(0, 0, 0.6, 1) },
      { paneId: 'p2', ...r(0.6, 0, 0.4, 0.5) },
      { paneId: 'p3', ...r(0.6, 0.5, 0.4, 0.5) },
    ])
    expect(out.dividers.map((d) => ({ ...d, parent: round(d.parent) }))).toEqual([
      { path: [], dir: 'right', at: 0.6, parent: r(0, 0, 1, 1) },
      { path: ['b'], dir: 'down', at: 0.5, parent: { x: 0.6, y: 0, w: 0.4, h: 1 } },
    ])
  })

  test('비율은 0.1~0.9 로 막아 그린다 (손상된 값이 pane 을 0 으로 만들지 않게)', () => {
    const out = layoutRects(split('down', pane('a'), pane('b'), 0.99))
    expect(out.panes[0]!.h).toBeCloseTo(0.9)
    expect(out.dividers[0]!.at).toBeCloseTo(0.9)
  })
})
