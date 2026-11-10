import { useEffect, useRef, type KeyboardEvent } from 'react'

interface Props {
  title: string
  message: string
  confirmLabel: string
  onConfirm(): void
  onCancel(): void
}

/** 되돌릴 수 없는 일 확인. 기본 포커스는 취소 — Enter 를 무심코 눌러도 지워지지 않게. */
export function ConfirmDialog({ title, message, confirmLabel, onConfirm, onCancel }: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => cancelRef.current?.focus(), [])

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="dialog narrow" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" onKeyDown={onKeyDown}>
        <h1 id="confirm-title">{title}</h1>
        <p className="dialog-message">{message}</p>
        <footer className="dialog-actions">
          <button ref={cancelRef} type="button" className="button" onClick={onCancel}>
            취소
          </button>
          <button type="button" className="button danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  )
}
