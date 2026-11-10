import { taskActivity, type PaneActivity } from '../shared/activity'
import type { AppState, Id, Task } from '../shared/types'
import { ActivityIcon, ACTIVITY_LABEL } from './activity-ui'
import { shortPath, sidebarSections } from './sidebar-model'

interface Props {
  state: AppState
  /** paneId → 활동 */
  activity: Readonly<Record<Id, PaneActivity>>
  /** 저장 파일을 읽는 중 — '일감이 없습니다'를 잠깐 보이지 않게, 그 사이 만든 일감이 읽은 값에 덮이지 않게 */
  loading: boolean
  onSelect(id: Id): void
  onNew(): void
  onRemove(task: Task): void
}

/** 왼쪽 일감 목록 — 묶음별 칸, 일감은 두 줄(이름 / 폴더 · 상태). */
export function Sidebar({ state, activity, loading, onSelect, onNew, onRemove }: Props) {
  const sections = sidebarSections(state)
  const statusOf = (task: Task) => state.settings.statuses.find((s) => s.id === task.statusId)
  const activityOf = (task: Task) => taskActivity(Object.keys(task.panes).map((id) => activity[id]))
  // 맨 위 '확인 필요': 입력을 기다리거나 보지 않는 사이 실패한 일감만 (⇧⌘A 로 차례로 간다)
  const needs = sections.flatMap((s) => s.tasks).filter((t) => activityOf(t).attention)

  const row = (task: Task, where: 'attention' | 'list') => {
    const status = statusOf(task)
    const active = task.id === state.activeTaskId
    const act = activityOf(task)
    return (
      <li
        key={task.id}
        className={`task-row${active ? ' active' : ''}${act.attention ? ' attention' : ''}`}
        data-testid={where === 'attention' ? 'attention-row' : 'task-row'}
        data-task-name={task.name}
        data-activity={act.state}
      >
        <button type="button" className="task-main" onClick={() => onSelect(task.id)} aria-current={active ? 'true' : undefined}>
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
          <span className="task-activity" title={act.state === 'idle' ? undefined : ACTIVITY_LABEL[act.state]}>
            <ActivityIcon state={act.state} />
          </span>
        </button>
        {where === 'list' ? (
          <button type="button" className="task-remove" onClick={() => onRemove(task)} aria-label={`${task.name} 지우기`} title="지우기">
            ×
          </button>
        ) : (
          <span className="task-remove-space" aria-hidden /> // 아이콘 자리를 아래 목록과 맞춘다
        )}
      </li>
    )
  }

  return (
    <nav className="sidebar" aria-label="일감" data-testid="sidebar">
      <header className="sidebar-head">
        <span>일감</span>
        <button type="button" className="icon-button" onClick={onNew} aria-label="새 일감" title="새 일감" disabled={loading}>
          +
        </button>
      </header>
      {!loading && sections.length === 0 && <p className="sidebar-empty">일감이 없습니다 — + 로 만듭니다</p>}
      {needs.length > 0 && (
        <section className="sidebar-section attention-section" data-testid="attention-section">
          <h2 className="sidebar-section-title">확인 필요 <kbd>⇧⌘A</kbd></h2>
          <ul>{needs.map((t) => row(t, 'attention'))}</ul>
        </section>
      )}
      {sections.map((section) => (
        <section key={section.group?.id ?? '__loose'} className="sidebar-section">
          {section.title && <h2 className="sidebar-section-title">{section.title}</h2>}
          <ul>{section.tasks.map((t) => row(t, 'list'))}</ul>
        </section>
      ))}
    </nav>
  )
}
