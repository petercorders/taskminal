import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ChatEvent } from '../shared/chat'
import { claudeHandoff, HANDOFF_MAX_CHARS } from '../shared/chat-handoff'
import { Modal } from './Modal'

interface Props {
  cwd: string
  events: readonly ChatEvent[]
  onCancel(): void
  onHandoff(cwd: string, text: string): boolean
}

export function ClaudeHandoffDialog({ cwd, events, onCancel, onHandoff }: Props) {
  const title = useId()
  const input = useRef<HTMLTextAreaElement>(null)
  const confirm = useRef(false)
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let open = true
    void window.taskminal.review.load(cwd, null).then(
      (result) => {
        if (open) setText(claudeHandoff(events, result.state === 'ok' ? [...result.staged, ...result.files.map((file) => file.path)] : null))
      },
      () => {
        if (open) setText(claudeHandoff(events, null))
      },
    )
    return () => { open = false }
  }, [cwd, events])

  useEffect(() => {
    if (text !== null) input.current?.focus()
  }, [text !== null])

  const transfer = () => {
    if (!text?.trim() || confirm.current) return
    confirm.current = true
    if (!onHandoff(cwd, text)) {
      confirm.current = false
      setError(true)
    }
  }

  return createPortal(
    <div onKeyDown={(event) => event.stopPropagation()}>
      <Modal role="dialog" labelledBy={title} className="claude-handoff-dialog" onCancel={onCancel}>
        <h1 id={title}>Codex로 인계</h1>
        <p className="dim">초안을 편집한 뒤 새 Codex 대화의 입력칸에 넣으세요.</p>
        {text === null ? <p role="status">변경 파일을 확인하는 중…</p> :
          <label className="claude-handoff-field">
            인계 초안
            <textarea ref={input} rows={12} maxLength={HANDOFF_MAX_CHARS} value={text} onChange={(event) => setText(event.target.value)} />
          </label>}
        {error && <p role="alert">원래 일감이나 대화가 바뀌어서 새 대화를 열지 못했어요.</p>}
        <footer className="dialog-actions">
          <button type="button" className="button" autoFocus onClick={onCancel}>취소</button>
          <button type="button" className="button primary" disabled={!text?.trim()} onClick={transfer}>Codex 입력칸에 넣기</button>
        </footer>
      </Modal>
    </div>,
    document.body,
  )
}
