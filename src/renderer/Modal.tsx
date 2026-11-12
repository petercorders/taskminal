import { useRef, type KeyboardEvent, type ReactNode } from 'react'

interface Props {
  role: 'dialog' | 'alertdialog'
  labelledBy: string
  className?: string
  onCancel(): void
  children: ReactNode
}

/** 모달 안의 보이는 컨트롤만 순회한다. 닫힌 묶음·disabled 입력으로 포커스가 새지 않게. */
export function trapModalTab(e: KeyboardEvent, root: Element) {
  if (e.key !== 'Tab' || e.ctrlKey || e.metaKey || e.altKey) return
  const items = [...root.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]')]
    .filter((item) => item.tabIndex >= 0 && !item.matches(':disabled') && item.getClientRects().length > 0 && getComputedStyle(item).visibility === 'visible')
  if (items.length === 0) return
  const first = items[0]!
  const last = items[items.length - 1]!
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault()
    first.focus()
  }
}

/** 대화상자 공용 껍데기: 배경 클릭 · Esc 로 취소, Tab · Shift+Tab 은 대화상자 안에서만 돈다(뒤의 터미널로 새지 않게). */
export function Modal({ role, labelledBy, className, onCancel, children }: Props) {
  const boxRef = useRef<HTMLDivElement>(null)

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
      return
    }
    if (boxRef.current) trapModalTab(e, boxRef.current)
  }

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div
        ref={boxRef}
        className={`dialog${className ? ` ${className}` : ''}`}
        role={role}
        aria-modal="true"
        aria-labelledby={labelledBy}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </div>
  )
}
