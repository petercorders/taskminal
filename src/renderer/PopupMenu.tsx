import { useEffect, useRef, type KeyboardEvent } from 'react'

export interface PopupItem {
  label: string
  /** 오른쪽 키 표시 */
  key?: string
  danger?: boolean
  disabled?: boolean
  run(): void
}

interface Props {
  label: string
  /** 메뉴 맨 위 설명 한 줄 (포트 메뉴의 ':5173 · node 48211') */
  heading?: string
  items: Array<PopupItem | 'sep'>
  x: number
  y: number
  testId?: string
  /** picked: 항목을 골라 닫힘(그 항목이 포커스를 정한다) · 아니면 Esc · 바깥 클릭 */
  onClose(picked: boolean): void
}

/**
 * 단추 · 칩의 우클릭(⇧F10) 메뉴 — TaskMenu 와 같은 모양(HTML, Playwright 가 누를 수 있게). ↑↓ · ↩ · Esc · 바깥 클릭.
 * 항목을 고르면 메뉴를 먼저 닫고 실행한다 — 실행이 여는 대화상자가 포커스를 갖게.
 */
export function PopupMenu({ label, heading, items, x, y, testId, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const box = ref.current!
    const r = box.getBoundingClientRect()
    box.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`
    box.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`
    box.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus()
  }, [x, y])

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault()
      return onClose(false)
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const list = [...ref.current!.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')]
    const i = list.indexOf(document.activeElement as HTMLElement)
    list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus()
  }

  return (
    <div className="menu-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose(false)} onContextMenu={(e) => e.preventDefault()}>
      <div ref={ref} className="menu" role="menu" aria-label={label} data-testid={testId} style={{ left: x, top: y }} onKeyDown={onKeyDown}>
        {heading && (
          <div className="menu-heading" role="presentation">
            {heading}
          </div>
        )}
        {items.map((item, i) =>
          item === 'sep' ? (
            <div key={`sep${i}`} className="menu-sep" role="separator" />
          ) : (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={`menu-item${item.danger ? ' danger' : ''}`}
              disabled={item.disabled}
              tabIndex={-1}
              onClick={() => {
                onClose(true)
                item.run()
              }}
            >
              <span className="menu-check" aria-hidden />
              <span className="menu-label">{item.label}</span>
              {item.key && <kbd className="menu-key">{item.key}</kbd>}
            </button>
          ),
        )}
      </div>
    </div>
  )
}

/** ⇧F10 · 메뉴 키 · 우클릭으로 메뉴를 여는 단추의 키 처리 */
export function isMenuKey(e: { key: string; shiftKey: boolean }): boolean {
  return e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)
}
