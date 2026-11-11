import { useEffect, useRef, useState } from 'react'
import type { Id, Note, Task } from '../shared/types'

interface Props {
  task: Task
  /** 열 때마다 바뀜 — 입력칸으로 포커스 */
  signal: number
  onAdd(text: string): void
  onToggle(noteId: Id): void
  onRemove(noteId: Id): void
  onClose(): void
}

/** 일감 메모 · 할 일 칸 (24단계) — 탭 줄 오른쪽 '✎ 메모' 로 여닫는다. 줄은 id 로 체크 · 지움 */
export function NotesPanel({ task, signal, onAdd, onToggle, onRemove, onClose }: Props) {
  const [draft, setDraft] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.focus(), [signal])
  const notes: readonly Note[] = task.notes ?? []
  return (
    <aside className="notes-panel" aria-label={`${task.name} 메모`} data-testid="notes-panel">
      <div className="notes-head">
        <strong>메모 · 할 일</strong>
        <button type="button" className="icon-button" aria-label="메모 닫기" onClick={onClose}>
          ✕
        </button>
      </div>
      {notes.length === 0 && <p className="notes-empty">아직 없어요. 아래에 적고 ↩ — 에이전트는 `taskminal task note "…"` 로 남겨요.</p>}
      <ul className="notes-list">
        {notes.map((n) => (
          <li key={n.id} className={`note${n.done ? ' done' : ''}${n.by === 'agent' ? ' agent' : ''}`} data-testid="note">
            <label>
              <input type="checkbox" checked={n.done === true} onChange={() => onToggle(n.id)} />
              <span className="note-text">{n.text}</span>
            </label>
            {n.by === 'agent' && <span className="note-by">에이전트가 남김</span>}
            <button type="button" className="icon-button" aria-label={`'${n.text}' 지우기`} onClick={() => onRemove(n.id)}>
              ✕
            </button>
          </li>
        ))}
      </ul>
      <input
        ref={input}
        className="notes-input"
        placeholder="할 일 · 메모 적고 ↩"
        value={draft}
        data-testid="notes-input"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            return onClose()
          }
          if (e.key !== 'Enter' || e.nativeEvent.isComposing || !draft.trim()) return
          e.preventDefault()
          onAdd(draft)
          setDraft('')
        }}
      />
    </aside>
  )
}
