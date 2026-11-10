import { useEffect, useRef, type KeyboardEvent } from 'react'
import type { Id, Template } from '../shared/types'

interface Props {
  templates: Template[]
  /** 활성 탭이 있음 — 없으면 '이 탭을 템플릿으로' 를 막는다 */
  hasTab: boolean
  x: number
  y: number
  onPick(templateId: Id): void
  onSaveTab(): void
  onSaveTask(): void
  /** 고르지 않고 닫힘(Esc · 바깥 클릭 · Tab) */
  onClose(): void
}

/** 탭 줄 "▾": 템플릿의 탭을 이 일감에 붙이기 · 이 탭/일감을 템플릿으로 저장. 모양 · 키보드는 일감 우클릭 메뉴와 같다. */
export function TemplateMenu({ templates, hasTab, x, y, onPick, onSaveTab, onSaveTask, onClose }: Props) {
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
      return onClose()
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const items = [...ref.current!.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')]
    const i = items.indexOf(document.activeElement as HTMLElement)
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
  }

  const item = (key: string, label: string, onClick: () => void, disabled = false, testId?: string) => (
    <button key={key} type="button" role="menuitem" className="menu-item" onClick={onClick} disabled={disabled} tabIndex={-1} data-testid={testId}>
      <span className="menu-check" aria-hidden />
      {label}
    </button>
  )

  return (
    <div className="menu-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()} onContextMenu={(e) => e.preventDefault()}>
      <div ref={ref} className="menu" role="menu" aria-label="템플릿 탭" data-testid="template-menu" style={{ left: x, top: y }} onKeyDown={onKeyDown}>
        <div className="menu-heading" role="presentation">
          템플릿 탭 열기
        </div>
        {/* 같은 이름 템플릿이 둘일 수 있다 — 키는 id */}
        {templates.map((t) => item(t.id, t.name, () => onPick(t.id)))}
        {templates.length === 0 && (
          <div className="menu-heading" role="presentation">
            템플릿이 없습니다
          </div>
        )}
        <div className="menu-sep" role="separator" />
        {item('save-tab', '이 탭을 템플릿으로 저장…', onSaveTab, !hasTab)}
        {item('save-task', '이 일감을 템플릿으로 저장…', onSaveTask)}
      </div>
    </div>
  )
}
