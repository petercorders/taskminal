import { useEffect } from 'react'

/** 아래 알림 한 줄 — 되돌리기 같은 동작 하나와 그 키(⌘Z 는 App 이 받는다). 시간이 지나면 사라진다 */
export interface ToastSpec {
  id: number
  text: string
  sub?: string
  action?: { label: string; run(): void }
  /** 보이는 시간 (기본 8초) */
  ms?: number
}

export const TOAST_MS = 8000

export function Toast({ toast, onDone }: { toast: ToastSpec; onDone(): void }) {
  useEffect(() => {
    const t = setTimeout(onDone, toast.ms ?? TOAST_MS)
    return () => clearTimeout(t)
    // 같은 알림이면 시간을 다시 재지 않는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast.id])
  return (
    <div className="toast" role="status" data-testid="toast">
      <span className="toast-text">
        {toast.text}
        {toast.sub && <span className="toast-sub"> {toast.sub}</span>}
      </span>
      {toast.action && (
        <button
          type="button"
          className="button"
          data-testid="toast-action"
          onClick={() => {
            toast.action!.run()
            onDone()
          }}
        >
          {toast.action.label} <kbd>⌘Z</kbd>
        </button>
      )}
      <button type="button" className="toast-close" aria-label="알림 닫기" onClick={onDone}>
        ×
      </button>
    </div>
  )
}
