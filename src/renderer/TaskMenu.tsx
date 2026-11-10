import { useEffect, useRef, type KeyboardEvent } from 'react'
import type { TaskEdit } from '../shared/model'
import type { Settings, Task } from '../shared/types'
import { TASK_COLORS } from './NewTaskDialog'

interface Props {
  task: Task
  settings: Settings
  /** 화면 좌표 (우클릭 자리 · 행 아래) */
  x: number
  y: number
  onEdit(patch: TaskEdit): void
  /** 이름 바꾸기 · 지우기는 메뉴를 닫는 것까지 부르는 쪽이 한다 — 다음 포커스(입력칸 · 확인 대화상자)를 터미널에 뺏기지 않게 */
  onRename(): void
  onRemove(): void
  /** 템플릿으로 저장 — 이름 대화상자가 포커스를 가져가게 메뉴를 닫는 것까지 부르는 쪽이 한다 */
  onSaveTemplate(): void
  /** 그 밖의 항목 · Esc · 바깥 클릭 */
  onClose(): void
}

/**
 * 일감 우클릭 메뉴 — 이름 바꾸기 · 상태 · 묶음 · 색 · 지우기. 네이티브 팝업 대신 HTML(Playwright 가 누를 수 있게).
 * ↑↓ 로 항목 이동 · ↩/Space 실행 · Esc · 바깥 클릭으로 닫힘.
 */
export function TaskMenu({ task, settings, x, y, onEdit, onRename, onRemove, onSaveTemplate, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const box = ref.current!
    // 창 밖으로 나가지 않게
    const r = box.getBoundingClientRect()
    box.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`
    box.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`
    box.querySelector<HTMLElement>('[role^="menuitem"]')?.focus()
  }, [x, y])

  const run = (fn: () => void) => () => {
    fn()
    onClose()
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault()
      return onClose()
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const items = [...ref.current!.querySelectorAll<HTMLElement>('[role^="menuitem"]')]
    const i = items.indexOf(document.activeElement as HTMLElement)
    const next = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]
    next?.focus()
  }

  const radio = (label: string, checked: boolean, onPick: () => void, swatch?: string | null) => (
    <button key={label} type="button" role="menuitemradio" aria-checked={checked} className="menu-item" onClick={run(onPick)} tabIndex={-1}>
      <span className="menu-check" aria-hidden>
        {checked ? '✓' : ''}
      </span>
      {swatch !== undefined && <span className={`menu-swatch${swatch ? '' : ' none'}`} style={swatch ? { background: swatch } : undefined} aria-hidden />}
      {label}
    </button>
  )

  return (
    <div className="menu-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()} onContextMenu={(e) => e.preventDefault()}>
      <div ref={ref} className="menu" role="menu" aria-label={`${task.name} 메뉴`} data-testid="task-menu" style={{ left: x, top: y }} onKeyDown={onKeyDown}>
        <button type="button" role="menuitem" className="menu-item" onClick={onRename} tabIndex={-1}>
          <span className="menu-check" aria-hidden />
          이름 바꾸기
        </button>
        <div className="menu-sep" role="separator" />
        <div className="menu-heading" role="presentation">
          상태
        </div>
        <div role="group" aria-label="상태">
          {settings.statuses.map((s) => radio(s.name, task.statusId === s.id, () => onEdit({ statusId: s.id })))}
        </div>
        <div className="menu-heading" role="presentation">
          묶음
        </div>
        <div role="group" aria-label="묶음">
          {radio('묶음 없음', task.groupId === null, () => onEdit({ groupId: null }))}
          {settings.groups.map((g) => radio(g.name, task.groupId === g.id, () => onEdit({ groupId: g.id })))}
        </div>
        <div className="menu-heading" role="presentation">
          색
        </div>
        <div role="group" aria-label="색">
          {TASK_COLORS.map((c, i) => radio(`색 ${i + 1}`, task.color === c, () => onEdit({ color: c }), c))}
          {radio('색 없음', task.color === null, () => onEdit({ color: null }), null)}
        </div>
        <div className="menu-sep" role="separator" />
        <button type="button" role="menuitem" className="menu-item" onClick={onSaveTemplate} tabIndex={-1}>
          <span className="menu-check" aria-hidden />
          템플릿으로 저장…
        </button>
        <button type="button" role="menuitem" className="menu-item danger" onClick={onRemove} tabIndex={-1}>
          <span className="menu-check" aria-hidden />
          지우기…
        </button>
      </div>
    </div>
  )
}
