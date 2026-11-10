import { useState, type KeyboardEvent } from 'react'
import { taskActivity, type PaneActivity } from '../shared/activity'
import type { TaskEdit } from '../shared/model'
import type { AppState, Id, Task } from '../shared/types'
import { ActivityIcon, ACTIVITY_LABEL } from './activity-ui'
import { shortPath, sidebarSections } from './sidebar-model'
import { TaskMenu } from './TaskMenu'

interface Props {
  state: AppState
  /** paneId → 활동 */
  activity: Readonly<Record<Id, PaneActivity>>
  /** 저장 파일을 읽는 중 — '일감이 없습니다'를 잠깐 보이지 않게, 그 사이 만든 일감이 읽은 값에 덮이지 않게 */
  loading: boolean
  onSelect(id: Id): void
  onNew(): void
  onRemove(task: Task): void
  /** 우클릭 메뉴 · 이름 바꾸기 */
  onEdit(id: Id, patch: TaskEdit): void
  onToggleGroup(id: Id): void
  onSettings(): void
  onSaveTemplate(task: Task): void
  /** 메뉴 · 이름 바꾸기를 끝냈다 — 터미널이 포커스를 다시 가져가게 */
  onMenuClosed(): void
}

/** 왼쪽 일감 목록 — 묶음별 칸(접을 수 있음), 일감은 두 줄(이름 / 폴더 · 상태) 또는 한 줄(설정). */
export function Sidebar({ state, activity, loading, onSelect, onNew, onRemove, onEdit, onToggleGroup, onSettings, onSaveTemplate, onMenuClosed }: Props) {
  const sections = sidebarSections(state)
  const [menu, setMenu] = useState<{ taskId: Id; x: number; y: number } | null>(null)
  // 이름 바꾸기 중인 일감. ↩ · Esc 로 끝내면 입력칸이 사라지는데, Chromium 은 사라지는 입력칸에 blur 를 보내지 않는다
  // (2026-11-10 변이로 확인: Esc 뒤 blur 가 왔다면 취소한 이름이 저장됐을 것) → blur 는 다른 곳을 눌렀을 때만 온다
  const [renaming, setRenaming] = useState<Id | null>(null)
  const statusOf = (task: Task) => state.settings.statuses.find((s) => s.id === task.statusId)
  const activityOf = (task: Task) => taskActivity(Object.keys(task.panes).map((id) => activity[id]))
  // 맨 위 '확인 필요': 입력을 기다리거나 보지 않는 사이 실패한 일감만 (⇧⌘A 로 차례로 간다). 접힌 묶음의 일감도 올라온다
  const needs = sections.flatMap((s) => s.tasks).filter((t) => activityOf(t).attention)
  const compact = state.settings.sidebarDensity === 'one'

  const openMenuAt = (task: Task, x: number, y: number) => setMenu({ taskId: task.id, x, y })
  // 키보드: 메뉴 키 · ⇧F10 이면 행 아래에 메뉴
  const onRowKey = (task: Task) => (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault()
      const r = e.currentTarget.getBoundingClientRect()
      openMenuAt(task, r.left + 12, r.bottom)
    }
  }

  const startRename = (task: Task) => {
    // 접힌 묶음의 일감(확인 필요 칸에서 고름)은 목록 행이 없어 입력칸이 안 보인다 → 묶음을 편다
    const group = state.settings.groups.find((g) => g.id === task.groupId)
    if (group?.collapsed) onToggleGroup(group.id)
    setRenaming(task.id)
  }
  const finishRename = (task: Task, value: string | null) => {
    setRenaming(null)
    if (value !== null) onEdit(task.id, { name: value })
    onMenuClosed()
  }

  const row = (task: Task, where: 'attention' | 'list') => {
    const status = statusOf(task)
    const active = task.id === state.activeTaskId
    const act = activityOf(task)
    const editing = renaming === task.id && where === 'list'
    return (
      <li
        key={task.id}
        className={`task-row${active ? ' active' : ''}${act.attention ? ' attention' : ''}`}
        data-testid={where === 'attention' ? 'attention-row' : 'task-row'}
        data-task-name={task.name}
        data-activity={act.state}
        onContextMenu={(e) => {
          e.preventDefault()
          openMenuAt(task, e.clientX, e.clientY)
        }}
      >
        {editing ? (
          <input
            className="task-rename"
            aria-label="일감 이름"
            defaultValue={task.name}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return // 한글 조합 중의 ↩ 는 글자 확정
              if (e.key === 'Enter') finishRename(task, e.currentTarget.value)
              else if (e.key === 'Escape') finishRename(task, null)
            }}
            onBlur={(e) => finishRename(task, e.currentTarget.value)}
          />
        ) : (
          <button
            type="button"
            className="task-main"
            onClick={() => onSelect(task.id)}
            onKeyDown={onRowKey(task)}
            aria-current={active ? 'true' : undefined}
          >
            <span className="task-dot" style={{ background: task.color ?? 'transparent' }} aria-hidden />
            <span className="task-text">
              <span className="task-name">{task.name}</span>
              {!compact && (
                <span className="task-sub">
                  {shortPath(task.cwd)}
                  {status && (
                    <>
                      {' · '}
                      <span style={{ color: status.color }}>{status.name}</span>
                    </>
                  )}
                </span>
              )}
            </span>
            <span className="task-activity" title={act.state === 'idle' ? undefined : ACTIVITY_LABEL[act.state]}>
              <ActivityIcon state={act.state} />
            </span>
          </button>
        )}
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

  const menuTask = menu && state.tasks.find((t) => t.id === menu.taskId)

  return (
    <nav className={`sidebar${compact ? ' compact' : ''}`} aria-label="일감" data-testid="sidebar">
      <header className="sidebar-head">
        <span>일감</span>
        <span className="sidebar-head-actions">
          <button type="button" className="icon-button" onClick={onSettings} aria-label="설정" title="설정 (⌘,)" disabled={loading}>
            ⚙
          </button>
          <button type="button" className="icon-button" onClick={onNew} aria-label="새 일감" title="새 일감" disabled={loading}>
            +
          </button>
        </span>
      </header>
      {!loading && sections.length === 0 && <p className="sidebar-empty">일감이 없습니다 — + 로 만듭니다</p>}
      {needs.length > 0 && (
        <section className="sidebar-section attention-section" data-testid="attention-section">
          <h2 className="sidebar-section-title">
            확인 필요 <kbd>⇧⌘A</kbd>
          </h2>
          <ul>{needs.map((t) => row(t, 'attention'))}</ul>
        </section>
      )}
      {sections.map((section) => {
        const group = section.group
        const collapsed = Boolean(group?.collapsed)
        return (
          <section key={group?.id ?? '__loose'} className="sidebar-section" data-testid="sidebar-section">
            {section.title &&
              (group ? (
                <h2 className="sidebar-section-title">
                  <button type="button" className="group-toggle" aria-expanded={!collapsed} onClick={() => onToggleGroup(group.id)}>
                    <span className="group-caret" aria-hidden>
                      {collapsed ? '▸' : '▾'}
                    </span>
                    {section.title}
                    {collapsed && <span className="group-count">{section.tasks.length}</span>}
                  </button>
                </h2>
              ) : (
                <h2 className="sidebar-section-title">{section.title}</h2>
              ))}
            {!collapsed && <ul>{section.tasks.map((t) => row(t, 'list'))}</ul>}
          </section>
        )
      })}
      {menu && menuTask && (
        <TaskMenu
          task={menuTask}
          settings={state.settings}
          x={menu.x}
          y={menu.y}
          onEdit={(patch) => onEdit(menuTask.id, patch)}
          onRename={() => {
            setMenu(null)
            startRename(menuTask)
          }}
          onRemove={() => {
            setMenu(null)
            onRemove(menuTask)
          }}
          onSaveTemplate={() => {
            setMenu(null)
            onSaveTemplate(menuTask)
          }}
          onClose={() => {
            setMenu(null)
            onMenuClosed()
          }}
        />
      )}
    </nav>
  )
}
