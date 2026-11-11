import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import { taskActivity, type PaneActivity } from '../shared/activity'
import type { TaskEdit } from '../shared/model'
import type { AppState, Id, Task } from '../shared/types'
import { ActivityIcon, ACTIVITY_LABEL } from './activity-ui'
import { countBar, filterTasks, flowSections, lastActive, lastLine, shortPath, sidebarSections, timeAgo } from './sidebar-model'
import type { Branches } from '../shared/git'
import { TaskMenu } from './TaskMenu'
import { chipSummary, SIDEBAR_CHIPS, type PortChip } from '../shared/ports'
import { SidebarPorts } from './ports-ui'

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
  /** '다음에' 로 닫은 받아 둔 업데이트 버전 — 아래에 칩으로 (18단계) */
  updateChip?: string | null
  onUpdateChip?(): void
  /** 일감의 포트 칩 (20단계) — 보이기만, 2개 + 나머지 수 */
  portsOf?(task: Task): PortChip[]
  onSaveTemplate(task: Task): void
  /** 메뉴 · 이름 바꾸기를 끝냈다 — 터미널이 포커스를 다시 가져가게 */
  onMenuClosed(): void
  /** 일감 폴더 → git 브랜치 (저장소가 아니면 null · 아직 모르면 없음) — 둘째 줄 (15c) */
  branches: Branches
  // 21단계 흐름 보기
  /** 안 본 출력이 있는 일감 — 점 + 굵은 이름 */
  unread?: ReadonlySet<Id>
  /** ⌘P '사이드바에서 거르기' 를 고를 때마다 +1 → 거르기 칸으로 */
  filterSignal?: number
  onView?(view: 'flow' | 'group'): void
  onToggleSection?(key: string): void
  /** 몇 분 전 — 시험에서 시각을 고정할 수 있게 */
  now?: number
}

const DRAG_TYPE = 'application/x-taskminal-task'
const NO_UNREAD: ReadonlySet<Id> = new Set()

/** 왼쪽 일감 목록 — 묶음별 칸(접을 수 있음), 일감은 두 줄(이름 / 폴더 · 상태) 또는 한 줄(설정). */
export function Sidebar({ state, activity, loading, onSelect, onNew, onRemove, onEdit, onToggleGroup, onSettings, onSaveTemplate, onMenuClosed, branches, updateChip = null, onUpdateChip = () => {}, portsOf, unread = NO_UNREAD, filterSignal = 0, onView = () => {}, onToggleSection = () => {}, now = Date.now() }: Props) {
  const sections = sidebarSections(state)
  const flow = state.settings.sidebarView === 'flow'
  const [query, setQuery] = useState('')
  const filterRef = useRef<HTMLInputElement>(null)
  const [dropKey, setDropKey] = useState<string | null>(null)
  useEffect(() => {
    if (filterSignal > 0) filterRef.current?.focus()
  }, [filterSignal])
  const flowSecs = flow ? flowSections(state, activity, unread, query, branches) : []
  const bar = countBar(state, activity, unread)
  const groupName = (task: Task) => state.settings.groups.find((g) => g.id === task.groupId)?.name
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

  const agoOf = (task: Task) => {
    const at = lastActive(task, activity)
    return at ? timeAgo(at, now) : null
  }
  const lastOf = (task: Task) => lastLine(task, activity)

  const dropProps = (key: string) => ({
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (key === 'need' || !e.dataTransfer.types.includes(DRAG_TYPE)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setDropKey(key)
    },
    onDragLeave: () => setDropKey((k) => (k === key ? null : k)),
    onDrop: (e: DragEvent<HTMLElement>) => {
      setDropKey(null)
      const id = e.dataTransfer.getData(DRAG_TYPE)
      if (key === 'need' || !id) return
      e.preventDefault()
      // 끄는 사이 일감 · 상태가 지워졌을 수 있다 — editTask 가 없는 것은 그대로 둔다
      onEdit(id, { statusId: key })
    },
  })

  // 'need' = 흐름 보기의 확인 필요 칸 — 일감이 여기에만 나오므로 이름 바꾸기 · 지우기를 그대로 둔다
  const row = (task: Task, where: 'attention' | 'need' | 'list') => {
    const status = statusOf(task)
    const active = task.id === state.activeTaskId
    const act = activityOf(task)
    const editing = renaming === task.id && where !== 'attention'
    return (
      <li
        key={task.id}
        className={`task-row${active ? ' active' : ''}${act.attention ? ' attention' : ''}`}
        data-testid={where === 'list' ? 'task-row' : 'attention-row'}
        data-task-name={task.name}
        data-activity={act.state}
        data-unread={unread.has(task.id) || undefined}
        draggable={flow && !editing}
        onDragStart={(e: DragEvent<HTMLLIElement>) => {
          e.dataTransfer.setData(DRAG_TYPE, task.id)
          e.dataTransfer.effectAllowed = 'move'
        }}
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
              <span className="task-line1">
                <span className="task-name">{task.name}</span>
                {unread.has(task.id) && <span className="task-unread" aria-label="새 출력" data-testid="task-unread" />}
                {!compact && agoOf(task) && <span className="task-ago">{agoOf(task)}</span>}
              </span>
              {!compact && lastOf(task) && (
                <span className={`task-last ${lastOf(task)!.tone}`} data-testid="task-last">
                  {lastOf(task)!.text}
                </span>
              )}
              {!compact && (
                // 디자인 '사이드바 일감 줄': 브랜치(저장소가 아니면 폴더) 고정폭 · 6px 틈 · 상태 색
                <span className="task-sub" title={task.cwd}>
                  <span className="task-where">{branches[task.cwd] ?? shortPath(task.cwd)}</span>
                  {flow ? (
                    groupName(task) && <span className="task-group">{groupName(task)}</span>
                  ) : (
                    status && (
                      <span className="task-status" style={{ color: status.color }}>
                        {status.name}
                      </span>
                    )
                  )}
                  <span className="task-terms">터미널 {Object.keys(task.panes).length}</span>
                </span>
              )}
              {portsOf && <SidebarPorts {...chipSummary(portsOf(task), SIDEBAR_CHIPS)} />}
            </span>
            <span className="task-activity" title={act.state === 'idle' ? undefined : ACTIVITY_LABEL[act.state]}>
              <ActivityIcon state={act.state} />
            </span>
          </button>
        )}
        {where !== 'attention' ? (
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
    <nav
      className={`sidebar${compact ? ' compact' : ''}`}
      aria-label="일감"
      data-testid="sidebar"
      onKeyDown={(e) => {
        // 사이드바에 포커스가 있을 때 '/' 로 거르기 칸 (터미널 · 입력칸에서는 글자)
        if (e.key === '/' && !(e.target instanceof HTMLInputElement) && !e.metaKey && !e.ctrlKey) {
          e.preventDefault()
          filterRef.current?.focus()
          return
        }
        // 줄에서 ↑↓ 로 위아래 줄 (21b 키보드만으로) — 거르기 칸의 ↓ 도 첫 줄로 온다
        const el = e.target as HTMLElement
        if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.metaKey && !e.altKey && el.classList.contains('task-main')) {
          const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('.task-main')]
          const next = rows[rows.indexOf(el) + (e.key === 'ArrowDown' ? 1 : -1)]
          e.preventDefault()
          if (next) next.focus()
          else if (e.key === 'ArrowUp') filterRef.current?.focus()
        }
      }}
    >
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
      {state.tasks.length > 0 && (
        <div className="sidebar-tools">
          <div className="sidebar-views" role="radiogroup" aria-label="사이드바 보기">
            {(
              [
                ['flow', '흐름'],
                ['group', '묶음'],
              ] as const
            ).map(([v, label]) => (
              <button key={v} type="button" role="radio" aria-checked={state.settings.sidebarView === v} className={state.settings.sidebarView === v ? 'on' : ''} onClick={() => onView(v)}>
                {label}
              </button>
            ))}
          </div>
          <input
            ref={filterRef}
            className="sidebar-filter"
            data-testid="sidebar-filter"
            aria-label="일감 거르기"
            placeholder="거르기  /"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return
              if (e.key === 'Escape') {
                e.preventDefault()
                setQuery('')
                onMenuClosed()
              } else if (e.key === 'ArrowDown') {
                e.preventDefault()
                e.currentTarget.closest('nav')?.querySelector<HTMLElement>('.task-main')?.focus()
              } else if (e.key === 'Enter') {
                // 화면에 보이는 거르기와 같은 규칙(이름 · 폴더 · 브랜치 · 묶음)으로 첫 일감
                const first = (flow ? flowSecs.flatMap((s) => s.tasks) : sections.flatMap((s) => filterTasks(s.tasks, query, state.settings.groups, branches)))[0]
                if (first) {
                  onSelect(first.id)
                  onMenuClosed()
                }
              }
            }}
          />
        </div>
      )}
      {state.tasks.length > 0 && (bar.need || bar.run || bar.done || bar.idle) > 0 && (
        <div className="sidebar-bar" data-testid="sidebar-bar" aria-label="일감 활동 개수">
          {(
            [
              ['need', '확인', bar.need],
              ['run', '실행', bar.run],
              ['done', '끝남', bar.done],
              ['idle', '조용', bar.idle],
            ] as const
          )
            .filter(([, , n]) => n > 0)
            .map(([k, label, n]) => (
              <span key={k} className={`sidebar-bar-item ${k}`} style={{ flexGrow: n }} title={`${label} ${n}`}>
                {label} {n}
              </span>
            ))}
        </div>
      )}
      {!loading && sections.length === 0 && <p className="sidebar-empty">일감이 없습니다 — + 로 만듭니다</p>}
      {/* 불러오기 전에는 기본 설정(흐름)으로 빈 칸이 번쩍이지 않게, 일감이 없으면 빈 안내만 */}
      {flow &&
        !loading &&
        state.tasks.length > 0 &&
        flowSecs.map((sec) => {
          const closed = state.settings.sidebarClosed.includes(sec.key) && !query.trim()
          if (sec.key === 'need' && sec.tasks.length === 0) return null
          return (
            <section
              key={sec.key}
              className={`sidebar-section flow-section${sec.key === 'need' ? ' attention-section' : ''}${dropKey === sec.key ? ' drop' : ''}`}
              data-testid={sec.key === 'need' ? 'attention-section' : 'flow-section'}
              data-key={sec.key}
              {...dropProps(sec.key)}
            >
              <h2 className="sidebar-section-title">
                <button type="button" className="group-toggle" aria-expanded={!closed} onClick={() => onToggleSection(sec.key)}>
                  <span className="group-caret" aria-hidden>
                    {closed ? '▸' : '▾'}
                  </span>
                  <span className="flow-dot" style={{ background: sec.color }} aria-hidden />
                  {sec.title}
                  <span className="group-count">{sec.tasks.length}</span>
                  {sec.key === 'need' && <kbd>⇧⌘A</kbd>}
                </button>
              </h2>
              {!closed && (sec.tasks.length > 0 ? <ul>{sec.tasks.map((t) => row(t, sec.key === 'need' ? 'need' : 'list'))}</ul> : <p className="flow-empty">{query.trim() ? '맞는 일감 없음' : '여기로 끌어 놓기'}</p>)}
            </section>
          )
        })}
      {!flow && needs.length > 0 && (
        <section className="sidebar-section attention-section" data-testid="attention-section">
          <h2 className="sidebar-section-title">
            확인 필요 <kbd>⇧⌘A</kbd>
          </h2>
          <ul>{needs.map((t) => row(t, 'attention'))}</ul>
        </section>
      )}
      {!flow && sections.map((section) => {
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
            {!collapsed && <ul>{filterTasks(section.tasks, query, state.settings.groups, branches).map((t) => row(t, 'list'))}</ul>}
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
      {updateChip && (
        <footer className="sidebar-foot">
          <button type="button" className="sidebar-update" onClick={onUpdateChip} data-testid="update-chip">
            ● {updateChip} 설치 가능
          </button>
        </footer>
      )}
    </nav>
  )
}
