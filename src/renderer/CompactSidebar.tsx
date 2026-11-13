import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { trapModalTab } from './Modal'

interface Props { open: boolean; onClose(): void; children: ReactNode }

/** One sidebar instance: normal navigation on desktop, modal drawer on narrow screens. */
export function CompactSidebar({ open, onClose, children }: Props) {
  const [compact, setCompact] = useState(() => matchMedia('(max-width: 520px)').matches)
  const shell = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  const modal = compact && open

  useEffect(() => {
    const query = matchMedia('(max-width: 520px)')
    const change = () => { setCompact(query.matches); if (!query.matches) close.current() }
    query.addEventListener('change', change)
    return () => query.removeEventListener('change', change)
  }, [])

  useLayoutEffect(() => {
    if (!modal || !shell.current || !panel.current) return
    const root = shell.current, content = panel.current, previous = document.activeElement
    const inert = new Map<HTMLElement, boolean>()
    const focusInside = () => {
      const filter = content.querySelector<HTMLInputElement>('[data-testid="sidebar-filter"]')
      const target = filter && !filter.disabled && filter.getClientRects().length ? filter : content.querySelector<HTMLButtonElement>('button:not(:disabled)')
      if (target) target.focus()
      else content.focus()
    }
    const isolate = () => {
      let branch: HTMLElement = root
      while (branch.parentElement && branch !== document.body) {
        for (const sibling of branch.parentElement.children) if (sibling instanceof HTMLElement && sibling !== branch) {
          if (!inert.has(sibling)) inert.set(sibling, sibling.inert)
          sibling.inert = true
        }
        branch = branch.parentElement
      }
    }
    const keepFocus = (event: FocusEvent) => {
      if (!(event.target instanceof Node) || !content.contains(event.target)) focusInside()
    }
    isolate(); focusInside()
    document.addEventListener('focusin', keepFocus, true)
    const observer = new MutationObserver(() => {
      isolate()
      if (!content.contains(document.activeElement)) focusInside()
    })
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      observer.disconnect(); document.removeEventListener('focusin', keepFocus, true)
      for (const [element, value] of inert) if (element.isConnected) element.inert = value
      if (previous instanceof HTMLElement && previous.isConnected && !previous.closest('[inert]')) previous.focus()
    }
  }, [modal])

  return <div ref={shell} className={`compact-sidebar-shell${modal ? ' is-modal' : ''}`} hidden={compact && !open} onMouseDown={event => { if (modal && event.target === event.currentTarget) close.current() }}>
    <div ref={panel} id="compact-sidebar-panel" className="compact-sidebar-panel" role={modal ? 'dialog' : undefined} aria-modal={modal ? true : undefined} aria-label={modal ? '일감 목록' : undefined} tabIndex={modal ? -1 : undefined} onKeyDown={event => {
      if (!modal || event.defaultPrevented || event.nativeEvent.isComposing) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current(); return }
      if (panel.current) trapModalTab(event, panel.current)
    }}>
      <header className="compact-sidebar-header"><strong>일감 목록</strong><button type="button" className="button" aria-label="일감 목록 닫기" onClick={() => close.current()}>닫기</button></header>
      {children}
    </div>
  </div>
}
