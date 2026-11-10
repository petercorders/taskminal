import type { Id, Layout, SplitDir } from './types'

export function paneIds(layout: Layout): Id[] {
  return layout.type === 'pane' ? [layout.paneId] : [...paneIds(layout.a), ...paneIds(layout.b)]
}

export function hasPane(layout: Layout, paneId: Id): boolean {
  return paneIds(layout).includes(paneId)
}

/** paneId 자리를 [원래 pane | 새 pane] 분할로 바꾼다. 새 pane 은 오른쪽(또는 아래)에 붙는다. */
export function splitPane(layout: Layout, paneId: Id, dir: SplitDir, newPaneId: Id): Layout {
  if (layout.type === 'pane') {
    if (layout.paneId !== paneId) return layout
    return { type: 'split', dir, ratio: 0.5, a: layout, b: { type: 'pane', paneId: newPaneId } }
  }
  const a = splitPane(layout.a, paneId, dir, newPaneId)
  const b = a === layout.a ? splitPane(layout.b, paneId, dir, newPaneId) : layout.b
  return a === layout.a && b === layout.b ? layout : { ...layout, a, b }
}

/** pane 을 빼고 형제가 부모 자리를 차지한다. 마지막 pane 이면 null. */
export function removePane(layout: Layout, paneId: Id): Layout | null {
  if (layout.type === 'pane') return layout.paneId === paneId ? null : layout
  const a = removePane(layout.a, paneId)
  const b = removePane(layout.b, paneId)
  if (a === null) return b
  if (b === null) return a
  return a === layout.a && b === layout.b ? layout : { ...layout, a, b }
}

export type SplitPath = ('a' | 'b')[]

export function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5
  return Math.min(0.9, Math.max(0.1, ratio))
}

/** path 가 가리키는 분할 노드의 비율을 바꾼다. 경로가 틀리거나 비율이 그대로면 같은 객체. */
export function setRatioAt(layout: Layout, path: SplitPath, ratio: number): Layout {
  if (layout.type !== 'split') return layout
  if (path.length === 0) {
    const next = clampRatio(ratio)
    return next === layout.ratio ? layout : { ...layout, ratio: next }
  }
  const [head, ...rest] = path
  const child = setRatioAt(layout[head], rest, ratio)
  return child === layout[head] ? layout : { ...layout, [head]: child }
}

/** 창 안의 비율 사각형 (0~1) */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface PaneRect extends Rect {
  paneId: Id
}

/** 분할선: path 의 분할 노드에서 a 와 b 의 경계. at = 그 노드(parent) 안의 비율. */
export interface Divider {
  path: SplitPath
  dir: SplitDir
  at: number
  parent: Rect
}

/**
 * 트리를 pane 마다 사각형으로 편다. 화면은 이 목록을 paneId 로 평평하게 그린다 —
 * 트리를 재귀로 그리면 분할할 때 pane 이 다른 부모 밑으로 옮겨져 다시 마운트되고 터미널 화면이 사라진다.
 */
export function layoutRects(layout: Layout): { panes: PaneRect[]; dividers: Divider[] } {
  const panes: PaneRect[] = []
  const dividers: Divider[] = []
  const walk = (node: Layout, rect: Rect, path: SplitPath) => {
    if (node.type === 'pane') {
      panes.push({ paneId: node.paneId, ...rect })
      return
    }
    const at = clampRatio(node.ratio)
    dividers.push({ path, dir: node.dir, at, parent: rect })
    if (node.dir === 'right') {
      walk(node.a, { ...rect, w: rect.w * at }, [...path, 'a'])
      walk(node.b, { ...rect, x: rect.x + rect.w * at, w: rect.w * (1 - at) }, [...path, 'b'])
    } else {
      walk(node.a, { ...rect, h: rect.h * at }, [...path, 'a'])
      walk(node.b, { ...rect, y: rect.y + rect.h * at, h: rect.h * (1 - at) }, [...path, 'b'])
    }
  }
  walk(layout, { x: 0, y: 0, w: 1, h: 1 }, [])
  return { panes, dividers }
}

/** 화면 순서(왼→오, 위→아래)대로 다음/이전 pane. 끝에서는 처음으로 돈다. */
export function cyclePane(layout: Layout, current: Id, step: 1 | -1): Id {
  const ids = paneIds(layout)
  const i = ids.indexOf(current)
  if (i < 0) return ids[0]
  return ids[(i + step + ids.length) % ids.length]
}
