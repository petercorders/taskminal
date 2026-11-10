import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { tabLabel } from '../shared/model'
import type { Id, Task } from '../shared/types'

interface Props {
  task: Task
  /** 이 일감이 보이는 중 — 다시 보일 때도 활성 탭을 보이는 곳으로 스크롤한다 */
  visible: boolean
  onSelect(tabId: Id): void
  onAdd(): void
  onClose(tabId: Id): void
  onRename(tabId: Id, title: string): void
  /** 이름 바꾸기를 끝내거나 취소했다 — 터미널이 포커스를 다시 가져가게 */
  onDone(): void
}

export const tabElementId = (tabId: Id) => `tab-${tabId}`
export const tabPanelId = (tabId: Id) => `tabpanel-${tabId}`

/** 일감의 탭 줄: 탭 고르기 · 닫기 · "+" 새 탭 · 더블클릭 또는 F2 로 이름 바꾸기.
 *  ← → 는 탭 사이 포커스만 옮기고 Enter · Space 로 고른다(수동 활성화) — 고르면 포커스가 터미널로 가기 때문. */
export function TabBar({ task, visible, onSelect, onAdd, onClose, onRename, onDone }: Props) {
  const [editing, setEditing] = useState<Id | null>(null)
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

  return (
    <div className="tab-bar" data-testid="tab-bar">
      <div ref={listRef} className="tab-list" role="tablist" aria-label={`${task.name} 탭`}>
        {task.tabs.map((tab, index) => {
          const label = tabLabel(task, tab)
          const active = tab.id === task.activeTabId
          return (
            <div key={tab.id} role="presentation" className={`tab${active ? ' active' : ''}`} data-testid="tab" data-tab-id={tab.id}>
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
