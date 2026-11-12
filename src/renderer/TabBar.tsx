import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { taskActivity, type PaneActivity } from '../shared/activity'
import { paneIds } from '../shared/layout'
import { tabLabels } from '../shared/model'
import type { Id, SplitDir, Task, Template } from '../shared/types'
import { TemplateMenu } from './TemplateMenu'
import type { PortChip } from '../shared/ports'
import { PortChips } from './ports-ui'
import { Icon } from './icons'

interface Props {
  task: Task
  /** paneId → 활동 (탭에 실행 중 · 확인 필요 표시) */
  activity: Readonly<Record<Id, PaneActivity>>
  /** 이 일감이 보이는 중 — 다시 보일 때도 활성 탭을 보이는 곳으로 스크롤한다 */
  visible: boolean
  onSelect(tabId: Id): void
  onAdd(): void
  onClose(tabId: Id): void
  onRename(tabId: Id, title: string): void
  /** 이름 바꾸기를 끝내거나 취소했다 — 터미널이 포커스를 다시 가져가게 */
  onDone(): void
  /** 활성 pane 을 나눈다 (단축키 ⌘D · ⇧⌘D 는 8단계) */
  onSplit(dir: SplitDir): void
  /** "▾" 메뉴: 템플릿 목록 · 그 템플릿의 탭 열기 · 이 탭/일감을 템플릿으로 저장 */
  templates: Template[]
  onAddTemplate(templateId: Id): void
  onSaveTemplate(tabId: Id | null): void
  /** 26단계: "▾" 메뉴의 새 대화 탭 */
  onChat(agent: 'claude' | 'codex'): void
  /** 명령 기록 칸 (19단계 ⌘Y) — 열려 있으면 눌린 모양 */
  historyOpen: boolean
  onHistory(): void
  /** 메모 · 할 일 칸 (24단계 ⌥⌘M) — 남은 할 일 수 · 열려 있으면 눌린 모양. 요약 카드를 다시 볼 수 있으면 '↺ 요약' */
  notes?: { open: boolean; todo: number; onToggle(): void; onResume: (() => void) | null }
  /** 포트 칩 (20단계) — 탭의 pane 들이 듣는 포트 · 조사 실패면 보이는 탭에 한 번 */
  ports?: { of(tabId: Id): PortChip[]; failed: boolean; onOpen(c: PortChip): void; onMenu(c: PortChip, x: number, y: number): void }
}

export const tabElementId = (tabId: Id) => `tab-${tabId}`
export const tabPanelId = (tabId: Id) => `tabpanel-${tabId}`

/** 일감의 탭 줄: 탭 고르기 · 닫기 · "+" 새 탭 · 더블클릭 또는 F2 로 이름 바꾸기.
 *  ← → 는 탭 사이 포커스만 옮기고 Enter · Space 로 고른다(수동 활성화) — 고르면 포커스가 터미널로 가기 때문. */
export function TabBar({ task, activity, visible, onSelect, onAdd, onClose, onRename, onDone, onSplit, templates, onAddTemplate, onSaveTemplate, onChat, historyOpen, onHistory, ports, notes }: Props) {
  const [editing, setEditing] = useState<Id | null>(null)
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // 탭이 넘쳐도 활성 탭(방금 만든 탭 포함)이 보이게 — 스크롤 막대를 숨겨 두었으므로 직접 데려온다
  useEffect(() => {
    if (!visible || !task.activeTabId) return
    listRef.current
      ?.querySelector(`[data-tab-id="${CSS.escape(task.activeTabId)}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [visible, task.activeTabId, task.tabs.length])

  const moveFocus = (e: KeyboardEvent, index: number) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    e.preventDefault()
    const buttons = listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')
    if (!buttons?.length) return
    buttons[(index + step + buttons.length) % buttons.length]?.focus()
  }

  const labels = tabLabels(task)
  return (
    <div className="tab-bar" data-testid="tab-bar">
      <div ref={listRef} className="tab-list" role="tablist" aria-label={`${task.name} 탭`}>
        {task.tabs.map((tab, index) => {
          const label = labels[index]!
          const active = tab.id === task.activeTabId
          const act = taskActivity(paneIds(tab.layout).map((id) => activity[id]))
          return (
            <div
              key={tab.id}
              role="presentation"
              className={`tab${active ? ' active' : ''}`}
              data-testid="tab"
              data-tab-id={tab.id}
              data-running={act.running}
              data-attention={act.attention}
            >
              {act.attention ? (
                <span className="tab-mark attention" aria-label="확인 필요" role="img" />
              ) : act.running > 0 ? (
                <span className="tab-mark running" aria-label={`실행 중 ${act.running}개`} role="img" />
              ) : null}
              {editing === tab.id ? (
                <RenameInput
                  initial={tab.title ?? ''}
                  placeholder={label}
                  onCommit={(title) => {
                    setEditing(null)
                    onRename(tab.id, title)
                    onDone()
                  }}
                  onCancel={() => {
                    setEditing(null)
                    onDone()
                  }}
                />
              ) : (
                <button
                  type="button"
                  role="tab"
                  id={tabElementId(tab.id)}
                  className="tab-main"
                  aria-selected={active}
                  aria-controls={tabPanelId(tab.id)}
                  title="더블클릭 또는 F2 로 이름 바꾸기"
                  onClick={() => onSelect(tab.id)}
                  onDoubleClick={() => setEditing(tab.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'F2') {
                      e.preventDefault()
                      setEditing(tab.id)
                    } else moveFocus(e, index)
                  }}
                >
                  {label}
                </button>
              )}
              {ports && <PortChips chips={ports.of(tab.id)} failed={ports.failed && active && visible} onOpen={ports.onOpen} onMenu={ports.onMenu} />}
              <button type="button" className="tab-close" aria-label={`${label} 탭 닫기`} onClick={() => onClose(tab.id)}>
                ×
              </button>
            </div>
          )
        })}
      </div>
      <button type="button" className="tab-add" aria-label="새 탭" title="새 탭" onClick={onAdd}>
        +
      </button>
      <button
        type="button"
        className="tab-add more"
        aria-label="새 대화 · 템플릿 탭"
        aria-haspopup="menu"
        aria-expanded={menuAt !== null}
        title="새 대화 · 템플릿으로 탭 열기 · 템플릿으로 저장"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          setMenuAt({ x: r.left, y: r.bottom + 2 })
        }}
      >
        ▾
      </button>
      {menuAt && (
        <TemplateMenu
          templates={templates}
          hasTab={task.activeTabId !== null}
          x={menuAt.x}
          y={menuAt.y}
          onPick={(id) => {
            setMenuAt(null)
            onAddTemplate(id)
          }}
          onSaveTab={() => {
            setMenuAt(null)
            onSaveTemplate(task.activeTabId)
          }}
          onSaveTask={() => {
            setMenuAt(null)
            onSaveTemplate(null)
          }}
          onChat={(agent) => {
            setMenuAt(null)
            onChat(agent)
          }}
          onClose={() => {
            setMenuAt(null)
            onDone()
          }}
        />
      )}
      <div className="tab-actions">
        {(['right', 'down'] as const).map((dir) => (
          <button
            key={dir}
            type="button"
            className="tab-action"
            aria-label={dir === 'right' ? '오른쪽으로 나누기' : '아래로 나누기'}
            title={dir === 'right' ? '오른쪽으로 나누기' : '아래로 나누기'}
            disabled={task.tabs.length === 0}
            onClick={() => onSplit(dir)}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <rect x="1.5" y="1.5" width="11" height="11" rx="1.5" fill="none" stroke="currentColor" />
              {dir === 'right' ? <line x1="7" y1="2" x2="7" y2="12" stroke="currentColor" /> : <line x1="2" y1="7" x2="12" y2="7" stroke="currentColor" />}
            </svg>
          </button>
        ))}
        <button type="button" className={`tab-action history${historyOpen ? ' on' : ''}`} aria-label="명령 기록" aria-pressed={historyOpen} title="명령 기록 (⌘Y)" data-testid="history-button" onClick={onHistory}>
          <Icon name="history" size={14} />
          <span className="tab-action-label">기록</span>
        </button>
        {notes?.onResume && (
          <button type="button" className="tab-action resume" aria-label="이어받기 요약 다시 보기" title="이어받기 요약 다시 보기 (⌥⌘R)" data-testid="resume-button" onClick={notes.onResume}>
            <span aria-hidden>↺</span><span className="tab-action-label">요약</span>
          </button>
        )}
        {notes && (
          <button type="button" className={`tab-action notes${notes.todo > 0 ? ' has-todo' : ''}${notes.open ? ' on' : ''}`} aria-label={`메모${notes.todo > 0 ? ` · 할 일 ${notes.todo}` : ''}`} aria-pressed={notes.open} title="메모 · 할 일 (⌥⌘M)" data-testid="notes-button" onClick={notes.onToggle}>
            <Icon name="note" size={14} />
            <span className="tab-action-label">메모{notes.todo > 0 ? ` · 할 일 ${notes.todo}` : ''}</span>
          </button>
        )}
      </div>
    </div>
  )
}

interface RenameProps {
  initial: string
  placeholder: string
  onCommit(title: string): void
  onCancel(): void
}

/** 그 자리 입력칸. Enter · 포커스를 잃으면 확정, Esc 는 취소. 한글 조합 중의 Enter 는 글자 확정이라 넘긴다. */
function RenameInput({ initial, placeholder, onCommit, onCancel }: RenameProps) {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  // Enter 로 확정한 뒤 입력칸이 사라지며 생기는 blur 가 한 번 더 확정하지 않게
  const done = useRef(false)

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  const finish = (commit: boolean) => {
    if (done.current) return
    done.current = true
    if (commit) onCommit(value)
    else onCancel()
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      finish(true)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      finish(false)
    }
  }

  return (
    <input
      ref={ref}
      className="tab-rename"
      aria-label="탭 이름"
      value={value}
      placeholder={placeholder}
      maxLength={60}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={onKeyDown}
      // 창 자체가 포커스를 잃은 것(⌘Tab 으로 다른 앱)은 확정이 아니다 — 돌아오면 이어서 고친다
      onBlur={() => {
        if (document.hasFocus()) finish(true)
      }}
    />
  )
}
