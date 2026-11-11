import { useEffect, useRef } from 'react'
import { formatDuration } from '../shared/activity'
import type { PortChip } from '../shared/ports'
import { Modal } from './Modal'
import { isMenuKey } from './PopupMenu'

export const portUrl = (port: number) => `http://localhost:${port}`

const since = (c: PortChip, now: number) => `${formatDuration(now - c.since)}째`

/** 칩 한 줄 — 탭 이름 옆. 누르면 열기 · ⇧F10 · 우클릭 메뉴. 닫힌 칩은 회색 취소선(누를 수 없음) */
export function PortChips({ chips, onOpen, onMenu, failed = false }: { chips: readonly PortChip[]; onOpen(c: PortChip): void; onMenu(c: PortChip, x: number, y: number): void; failed?: boolean }) {
  if (chips.length === 0 && !failed) return null
  const now = Date.now()
  return (
    <span className="port-chips">
      {chips.map((c) =>
        c.closedAt !== undefined ? (
          <span key={c.port} className="port-chip closed" data-testid="port-chip" data-port={c.port} data-closed="true" title={`${c.proc} (${c.pid}) — 서버가 꺼졌어요`}>
            :{c.port} 닫힘
          </span>
        ) : (
          <button
            key={c.port}
            type="button"
            className="port-chip"
            data-testid="port-chip"
            data-port={c.port}
            aria-label={`포트 ${c.port} 열기`}
            title={`${c.proc} (${c.pid}) · ${since(c, now)}\n↩ 열기 · ⇧F10 메뉴`}
            onClick={() => onOpen(c)}
            onContextMenu={(e) => {
              e.preventDefault()
              onMenu(c, e.clientX, e.clientY)
            }}
            onKeyDown={(e) => {
              if (!isMenuKey(e)) return
              e.preventDefault()
              const r = e.currentTarget.getBoundingClientRect()
              onMenu(c, r.left, r.bottom + 2)
            }}
          >
            :{c.port}
          </button>
        ),
      )}
      {failed && (
        <span className="port-chip failed" data-testid="port-failed" title="다음 조사에서 다시 해 봐요">
          포트 확인 못 함
        </span>
      )}
    </span>
  )
}

/** 사이드바 일감 줄 — 보이기만 한다(누르기는 탭 칩 · ⌘P). 2개 + 나머지 수 */
export function SidebarPorts({ shown, rest }: { shown: readonly PortChip[]; rest: readonly PortChip[] }) {
  if (shown.length === 0) return null
  return (
    <span className="task-ports" data-testid="sidebar-ports">
      {shown.map((c) => (
        <span key={`${c.paneId}:${c.port}`} className={`port-chip small${c.closedAt !== undefined ? ' closed' : ''}`} data-port={c.port}>
          :{c.port}
        </span>
      ))}
      {rest.length > 0 && (
        <span className="port-chip small" title={rest.map((c) => `:${c.port}`).join(' · ')}>
          +{rest.length}
        </span>
      )}
    </span>
  )
}

/** 포트 끄기 확인 — 무엇이 꺼지는지 · 셸은 남는다 · 되돌릴 수 없다. 기본 포커스는 취소 */
export function PortKillConfirm({ chip, onKill, onCancel }: { chip: PortChip; onKill(): void; onCancel(): void }) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => cancelRef.current?.focus(), [])
  return (
    <Modal role="alertdialog" labelledBy="port-kill-title" className="narrow" onCancel={onCancel}>
      <div data-testid="port-kill-dialog">
        <h1 id="port-kill-title">
          {chip.port} 의 {chip.proc} 를 끌까요?
        </h1>
        <p className="dialog-message">
          {chip.proc} (pid {chip.pid}) 에 종료 신호를 보내요. 이 터미널의 셸은 남아요. 되돌릴 수 없어요.
        </p>
        <footer className="dialog-actions">
          <button ref={cancelRef} type="button" className="button" onClick={onCancel}>
            취소 <kbd>esc</kbd>
          </button>
          <button type="button" className="button danger" onClick={onKill} data-testid="port-kill">
            끄기
          </button>
        </footer>
      </div>
    </Modal>
  )
}

/** 포트 겹침 — 다른 일감이 쓰는 포트 때문에 밀려 떴다. 일감 화면 아래 한 줄 */
export function PortConflictBar({ port, wanted, ownerName, onOpen, onGoto, onKillOwner, onClose }: { port: number; wanted: number; ownerName: string; onOpen(): void; onGoto(): void; onKillOwner(): void; onClose(): void }) {
  return (
    <div className="port-conflict" role="alert" data-testid="port-conflict" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <span className="port-conflict-text">
        {wanted} 은 ‘{ownerName}’ 이 쓰고 있어서 이 서버는 {port} 로 떴어요
      </span>
      <button type="button" className="button warn small" onClick={onOpen}>
        {port} 열기
      </button>
      <button type="button" className="button small" onClick={onGoto}>
        {ownerName} 으로 가기
      </button>
      <button type="button" className="button small" onClick={onKillOwner}>
        그쪽 서버 끄기…
      </button>
      <button type="button" className="button ghost small" onClick={onClose} aria-label="겹침 알림 닫기">
        닫기 <kbd>esc</kbd>
      </button>
    </div>
  )
}
