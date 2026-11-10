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

/** path 가 가리키는 분할 노드의 비율을 바꾼다. 경로가 틀리면 그대로 둔다. */
export function setRatioAt(layout: Layout, path: SplitPath, ratio: number): Layout {
  if (layout.type !== 'split') return layout
  if (path.length === 0) return { ...layout, ratio: clampRatio(ratio) }
  const [head, ...rest] = path
  const child = setRatioAt(layout[head], rest, ratio)
  return child === layout[head] ? layout : { ...layout, [head]: child }
}

/** 화면 순서(왼→오, 위→아래)대로 다음/이전 pane. 끝에서는 처음으로 돈다. */
export function cyclePane(layout: Layout, current: Id, step: 1 | -1): Id {
  const ids = paneIds(layout)
  const i = ids.indexOf(current)
  if (i < 0) return ids[0]
  return ids[(i + step + ids.length) % ids.length]
}
