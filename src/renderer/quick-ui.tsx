import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { formatDuration } from '../shared/activity'
import { QUICK_WHERE, WHERE_LABEL, quickDefaults, quickError, type QuickButton, type QuickCommand, type QuickState, type QuickWhere } from '../shared/quick'
import { Modal } from './Modal'
import { isMenuKey } from './PopupMenu'

const SOURCE_MARK = { task: '', template: '▤', all: '◎' } as const

function stateText(s: QuickState, now: number): { text: string; kind: string } {
  switch (s.kind) {
    case 'running':
      return { text: `● ${formatDuration(now - s.since)}`, kind: 'running' }
    case 'done':
      return { text: `✓ ${ago(now - s.at)}`, kind: 'done' }
    case 'failed':
      return { text: `✗ ${s.code} · ${ago(now - s.at)}`, kind: 'failed' }
    case 'unknown':
      return { text: '상태 모름', kind: 'unknown' }
    case 'idle':
      return { text: '', kind: 'idle' }
  }
}
const ago = (ms: number) => (ms < 60_000 ? '방금' : `${Math.floor(ms / 60_000)}분 전`)

interface BarProps {
  taskName: string
  shown: QuickButton[]
  more: QuickButton[]
  statusOf(b: QuickButton): QuickState
  /** 실패 단추 말풍선의 마지막 오류 줄 (가린 글) */
  lastLineOf(b: QuickButton): string | null
  onRun(b: QuickButton): void
  onMenu(b: QuickButton, x: number, y: number): void
  onMore(x: number, y: number): void
  onAdd(): void
}

/** 빠른 명령 줄 — 일감 화면 맨 위(탭 줄 위). 9개까지 단추 · 나머지는 '더 ▾ n' · 끝에 '+ 명령'. 비었으면 안내 한 줄 */
export function QuickBar({ taskName, shown, more, statusOf, lastLineOf, onRun, onMenu, onMore, onAdd }: BarProps) {
  const states = shown.map(statusOf)
  // 실행 중 단추가 있으면 경과 시간을 1초마다
  const [now, setNow] = useState(() => Date.now())
  const ticking = states.some((s) => s.kind === 'running')
  useEffect(() => {
    setNow(Date.now())
    if (!ticking) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [ticking, states.length])

  if (shown.length === 0)
    return (
      <div className="quick-empty" data-testid="quick-empty">
        <span className="quick-bolt" aria-hidden>
          ⚡
        </span>
        <span className="quick-empty-text">
          자주 치는 명령을 단추로 만들어요. <b>+ 명령</b> 을 누르거나, 명령 기록(⌘Y)의 ⋯ 에서 <b>빠른 명령으로 저장</b> 을 고르세요.
        </span>
        <button type="button" className="button primary small" onClick={onAdd} data-testid="quick-add">
          + 명령
        </button>
      </div>
    )

  const menuAt = (b: QuickButton) => (e: { currentTarget: HTMLElement; preventDefault(): void }) => {
    e.preventDefault()
    const r = e.currentTarget.getBoundingClientRect()
    onMenu(b, r.left, r.bottom + 2)
  }
  return (
    <div className="quick-bar" role="toolbar" aria-label={`${taskName} 빠른 명령`} data-testid="quick-bar">
      {shown.map((b, i) => {
        const st = stateText(states[i]!, now)
        const s = states[i]!
        const last = s.kind === 'failed' ? lastLineOf(b) : null
        const title = [
          b.source === 'all' ? '모든 일감에 있는 명령이에요' : b.source === 'template' ? `템플릿 "${b.qc.fromTemplate}" 에서 온 명령이에요` : '',
          `${b.qc.command} — ${WHERE_LABEL[b.qc.where]}${b.qc.confirm ? ' · 실행 전 물어봐요' : ''}`,
          s.kind === 'failed' ? `✗ ${s.code} · ${ago(now - s.at)}${last ? `\n${last}` : ''}` : '',
          s.kind === 'unknown' ? '셸 통합이 없는 pane 이라 결과를 몰라요' : '',
          b.key ? `⌥${b.key} 실행 · ⇧F10 메뉴` : '⇧F10 메뉴',
        ]
          .filter(Boolean)
          .join('\n')
        return (
          <button
            key={b.runKey}
            type="button"
            className={`quick-button ${st.kind}`}
            data-testid="quick-button"
            data-label={b.qc.label}
            data-state={s.kind}
            title={title}
            onClick={() => onRun(b)}
            onContextMenu={menuAt(b)}
            onKeyDown={(e: KeyboardEvent<HTMLButtonElement>) => {
              if (isMenuKey(e)) menuAt(b)(e)
            }}
          >
            {SOURCE_MARK[b.source] && <span className="quick-src">{SOURCE_MARK[b.source]}</span>}
            <span className="quick-label">
              {b.qc.label}
              {b.qc.confirm ? '…' : ''}
            </span>
            {b.key && <span className="quick-key">⌥{b.key}</span>}
            {st.text && (
              <span className={`quick-state ${st.kind}`} data-testid="quick-state">
                {st.text}
              </span>
            )}
          </button>
        )
      })}
      {more.length > 0 && (
        <button
          type="button"
          className="quick-more"
          data-testid="quick-more"
          title="⌥0"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            onMore(r.left, r.bottom + 2)
          }}
        >
          더 ▾ {more.length}
        </button>
      )}
      <button type="button" className="quick-add" onClick={onAdd} data-testid="quick-add">
        + 명령
      </button>
    </div>
  )
}

export interface QuickDraft {
  label: string
  command: string
  where: QuickWhere
  cwd: string
  confirm: boolean
  scope: 'task' | 'all'
}

export function draftOf(qc: QuickCommand | null, scope: 'task' | 'all', command = ''): QuickDraft {
  if (qc) return { label: qc.label, command: qc.command, where: qc.where, cwd: qc.cwd ?? '', confirm: qc.confirm === true, scope }
  return { label: '', command, where: 'current', cwd: '', confirm: quickDefaults(command).confirm, scope }
}

interface EditorProps {
  initial: QuickDraft
  isNew: boolean
  /** 템플릿에서 온 단추 — 어디에 두나를 바꿀 수 없다 */
  fromTemplate?: string | undefined
  onSave(d: QuickDraft): void
  onCancel(): void
}

/** 빠른 명령 만들기 · 고치기 — 연 순간의 값을 떠 두고 고친다(그 사이 다른 곳에서 바뀌어도 고치던 글은 그대로) */
export function QuickEditor({ initial, isNew, fromTemplate, onSave, onCancel }: EditorProps) {
  const [d, setD] = useState(initial)
  // 위험 명령이면 만들 때 '실행 전 물어봐요' 를 켜 둔다 — 사용자가 직접 끈 뒤에는 다시 켜지 않는다
  const [touchedConfirm, setTouchedConfirm] = useState(!isNew)
  const [error, setError] = useState<string | null>(null)
  const labelRef = useRef<HTMLInputElement>(null)
  useEffect(() => labelRef.current?.focus(), [])
  const reason = quickDefaults(d.command).reason
  const set = (patch: Partial<QuickDraft>) =>
    setD((prev) => {
      const next = { ...prev, ...patch }
      if (patch.command !== undefined && !touchedConfirm) next.confirm = quickDefaults(next.command).confirm
      return next
    })
  const submit = () => {
    const err = quickError(d)
    if (err) return setError(err)
    onSave(d)
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && e.metaKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }
  const showCwd = d.where === 'newTab' || d.where === 'splitRight' || d.where === 'splitDown'
  return (
    <Modal role="dialog" labelledBy="quick-edit-title" onCancel={onCancel}>
      <form
        className="dialog-form"
        data-testid="quick-editor"
        onKeyDown={onKeyDown}
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <h1 id="quick-edit-title">{isNew ? '빠른 명령 만들기' : '빠른 명령 고치기'}</h1>
        <div className="dialog-body">
          <label className="field">
            <span>이름</span>
            <input ref={labelRef} value={d.label} onChange={(e) => set({ label: e.target.value })} placeholder="예: 시험" data-testid="quick-label" />
          </label>
          <label className="field">
            <span>명령</span>
            <input className="mono" value={d.command} spellCheck={false} onChange={(e) => set({ command: e.target.value })} placeholder="예: npm test" data-testid="quick-command" />
            <span className="field-hint">셸에 그대로 입력돼요 · 여러 줄은 && 로</span>
          </label>
          <label className="field">
            <span>어디서</span>
            <select value={d.where} onChange={(e) => set({ where: e.target.value as QuickWhere })} data-testid="quick-where">
              {QUICK_WHERE.map((w) => (
                <option key={w} value={w}>
                  {WHERE_LABEL[w]}
                  {w === 'insert' ? ' (↩ 은 직접)' : ''}
                </option>
              ))}
            </select>
          </label>
          {showCwd && (
            <label className="field">
              <span>폴더</span>
              <input className="mono" value={d.cwd} spellCheck={false} onChange={(e) => set({ cwd: e.target.value })} placeholder="일감 폴더 (기본) · 또는 상대 경로" data-testid="quick-cwd" />
            </label>
          )}
          <div className="field">
            <label className="check-row">
              <input
                type="checkbox"
                checked={d.confirm}
                onChange={(e) => {
                  setTouchedConfirm(true)
                  set({ confirm: e.target.checked })
                }}
                data-testid="quick-confirm"
              />
              실행 전 물어봐요
            </label>
            {reason && d.confirm && !touchedConfirm && (
              <span className="field-hint" data-testid="quick-confirm-reason">
                {reason}
              </span>
            )}
          </div>
          <label className="field">
            <span>어디에 두나</span>
            <select value={d.scope} disabled={fromTemplate !== undefined} onChange={(e) => set({ scope: e.target.value as 'task' | 'all' })} data-testid="quick-scope">
              <option value="task">{fromTemplate ? `이 일감 (템플릿 "${fromTemplate}" 에서 옴)` : '이 일감'}</option>
              <option value="all">모든 일감</option>
            </select>
          </label>
          {error && (
            <p className="field-error" role="alert" data-testid="quick-error">
              {error}
            </p>
          )}
        </div>
        <footer className="dialog-actions">
          <button type="button" className="button" onClick={onCancel}>
            취소 <kbd>esc</kbd>
          </button>
          <button type="submit" className="button primary" data-testid="quick-save">
            저장 <kbd>⌘↩</kbd>
          </button>
        </footer>
      </form>
    </Modal>
  )
}

interface ConfirmProps {
  qc: QuickCommand
  where: string
  onRun(dontAskAgain: boolean): void
  onCancel(): void
}

/** '…' 단추 — 실행 전에 명령을 보여 주고 묻는다. 기본 포커스는 실행(보드), Esc 취소 */
export function QuickConfirm({ qc, where, onRun, onCancel }: ConfirmProps) {
  const [dontAsk, setDontAsk] = useState(false)
  const runRef = useRef<HTMLButtonElement>(null)
  // 첫 ↩ 에 닫히므로 두 번 눌러도 한 번만 돈다
  const done = useRef(false)
  useEffect(() => runRef.current?.focus(), [])
  const run = () => {
    if (done.current) return
    done.current = true
    onRun(dontAsk)
  }
  return (
    <Modal role="alertdialog" labelledBy="quick-confirm-title" className="narrow" onCancel={onCancel}>
      {/* ↩ 는 어디서나 실행(체크 상자에 포커스가 있어도) — 보드 '실행 ↩' */}
      <div
        data-testid="quick-confirm-dialog"
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
          e.preventDefault()
          run()
        }}
      >
        <h1 id="quick-confirm-title">{qc.label} 를 실행할까요?</h1>
        <code className="dialog-code">{qc.command}</code>
        <p className="dialog-message">{where}</p>
        <label className="check-row">
          <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} data-testid="quick-dont-ask" />이 단추는 다시 묻지 않기
        </label>
        <footer className="dialog-actions">
          <button type="button" className="button" onClick={onCancel}>
            취소 <kbd>esc</kbd>
          </button>
          <button
            ref={runRef}
            type="button"
            className="button warn"
            data-testid="quick-confirm-run"
            onClick={run}
          >
            실행 <kbd>↩</kbd>
          </button>
        </footer>
      </div>
    </Modal>
  )
}
