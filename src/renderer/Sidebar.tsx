import type { AppState, Id, Task } from '../shared/types'
import { shortPath, sidebarSections } from './sidebar-model'

interface Props {
  state: AppState
  onSelect(id: Id): void
  onNew(): void
  onRemove(task: Task): void
}

/** 왼쪽 일감 목록 — 묶음별 칸, 일감은 두 줄(이름 / 폴더 · 상태). */
export function Sidebar({ state, onSelect, onNew, onRemove }: Props) {
  const sections = sidebarSections(state)
  const statusOf = (task: Task) => state.settings.statuses.find((s) => s.id === task.statusId)

  return (
    <nav className="sidebar" aria-label="일감" data-testid="sidebar">
      <header className="sidebar-head">
        <span>일감</span>
        <button type="button" className="icon-button" onClick={onNew} aria-label="새 일감" title="새 일감">
          +
        </button>
      </header>
      {sections.length === 0 && <p className="sidebar-empty">일감이 없습니다 — + 로 만듭니다</p>}
      {sections.map((section) => (
        <section key={section.group?.id ?? '__loose'} className="sidebar-section">
          {section.title && <h2 className="sidebar-section-title">{section.title}</h2>}
          <ul>
            {section.tasks.map((task) => {
              const status = statusOf(task)
              const active = task.id === state.activeTaskId
              return (
                <li key={task.id} className={`task-row${active ? ' active' : ''}`} data-testid="task-row" data-task-name={task.name}>
                  <button
                    type="button"
                    className="task-main"
                    onClick={() => onSelect(task.id)}
                    aria-current={active ? 'true' : undefined}
                  >
                    <span className="task-dot" style={{ background: task.color ?? 'transparent' }} aria-hidden />
                    <span className="task-text">
                      <span className="task-name">{task.name}</span>
                      <span className="task-sub">
                        {shortPath(task.cwd)}
                        {status && (
                          <>
                            {' · '}
                            <span style={{ color: status.color }}>{status.name}</span>
                          </>
                        )}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="task-remove"
                    onClick={() => onRemove(task)}
                    aria-label={`${task.name} 지우기`}
                    title="지우기"
                  >
                    ×
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </nav>
  )
}
