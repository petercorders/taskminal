import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { clampRatio, layoutRects, setRatioAt, type Divider, type SplitPath } from '../shared/layout'
import type { Id, Pane, Tab } from '../shared/types'
import { TerminalPane } from './TerminalPane'

interface Props {
  tab: Tab
  panes: Record<Id, Pane>
  /** 일감 · 탭이 모두 보이는 중 — 그때만 활성 pane 이 포커스를 가져간다 */
  visible: boolean
  focusSignal: number
  onFocusPane(paneId: Id): void
  onRatio(path: SplitPath, ratio: number): void
}

const pct = (n: number) => `${n * 100}%`
const KEY_STEP = 0.05

/**
 * 탭 하나의 분할 화면. pane 은 paneId key 의 평평한 목록으로 절대 위치에 그린다(layoutRects 주석 참고).
 * 분할선을 끄는 동안의 비율은 이 화면 안에만 두고, 놓을 때 한 번 onRatio — 끄는 동안 저장을 프레임마다 보내지 않게.
 */
export function SplitView({ tab, panes, visible, focusSignal, onFocusPane, onRatio }: Props) {
  const boxRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{ path: SplitPath; ratio: number } | null>(null)
  const dragging = useRef<{ divider: Divider; pointerId: number } | null>(null)

  const layout = drag ? setRatioAt(tab.layout, drag.path, drag.ratio) : tab.layout
  const { panes: rects, dividers } = layoutRects(layout)
  const split = rects.length > 1

  const ratioAt = (d: Divider, e: PointerEvent) => {
    const box = boxRef.current!.getBoundingClientRect()
    return d.dir === 'right'
      ? ((e.clientX - box.left) / box.width - d.parent.x) / d.parent.w
      : ((e.clientY - box.top) / box.height - d.parent.y) / d.parent.h
  }

  const onPointerDown = (d: Divider) => (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    e.currentTarget.focus() // 끄는 중 Esc 로 취소할 수 있게
    dragging.current = { divider: d, pointerId: e.pointerId }
    setDrag({ path: d.path, ratio: d.at })
  }
  const onPointerMove = (e: PointerEvent) => {
    const cur = dragging.current
    if (!cur || cur.pointerId !== e.pointerId) return
    setDrag({ path: cur.divider.path, ratio: clampRatio(ratioAt(cur.divider, e)) })
  }
  const onPointerUp = (e: PointerEvent) => {
    const cur = dragging.current
    if (!cur || cur.pointerId !== e.pointerId) return
    dragging.current = null
    setDrag(null)
    onRatio(cur.divider.path, clampRatio(ratioAt(cur.divider, e)))
  }

  const onDividerKey = (d: Divider) => (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && dragging.current) {
      e.preventDefault()
      e.currentTarget.releasePointerCapture(dragging.current.pointerId)
      dragging.current = null
      setDrag(null) // 원래 비율로
      return
    }
    const keys = d.dir === 'right' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown']
    const step = e.key === keys[0] ? -KEY_STEP : e.key === keys[1] ? KEY_STEP : 0
    if (!step) return
    e.preventDefault()
    onRatio(d.path, clampRatio(d.at + step))
  }

  return (
    <div className="split-view" ref={boxRef}>
      {rects.map((r) => {
        const pane = panes[r.paneId]
        const focused = r.paneId === tab.activePaneId
        return (
          <div
            key={r.paneId}
            className={`pane-slot${split && focused ? ' focused' : ''}`}
            style={{ left: pct(r.x), top: pct(r.y), width: pct(r.w), height: pct(r.h) }}
            data-testid="pane-slot"
            data-pane-id={r.paneId}
            data-focused={focused}
            onFocus={() => onFocusPane(r.paneId)}
          >
            {pane && <TerminalPane paneId={pane.id} cwd={pane.cwd} active={visible && focused} focusSignal={focusSignal} />}
          </div>
        )
      })}
      {dividers.map((d) => {
        const vertical = d.dir === 'right'
        const pos = vertical
          ? { left: `calc(${pct(d.parent.x + d.parent.w * d.at)} - 3px)`, top: pct(d.parent.y), height: pct(d.parent.h) }
          : { top: `calc(${pct(d.parent.y + d.parent.h * d.at)} - 3px)`, left: pct(d.parent.x), width: pct(d.parent.w) }
        return (
          <div
            key={d.path.join('') || 'root'}
            role="separator"
            tabIndex={0}
            aria-orientation={vertical ? 'vertical' : 'horizontal'}
            aria-label={vertical ? '좌우 나눈 선' : '위아래 나눈 선'}
            aria-valuenow={Math.round(d.at * 100)}
            aria-valuemin={10}
            aria-valuemax={90}
            className={`divider ${vertical ? 'vertical' : 'horizontal'}`}
            style={pos}
            data-testid="divider"
            onPointerDown={onPointerDown(d)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onKeyDown={onDividerKey(d)}
          />
        )
      })}
    </div>
  )
}
