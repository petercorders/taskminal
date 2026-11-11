import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { diffStates, groupBackups, mergeState, paneCount, REASON_LABEL, restoreAll, restoreTask, type BackupInfo, type Restored, type StateDiff } from '../../shared/backup'
import type { BackupMark } from '../../shared/ipc'
import type { AppState } from '../../shared/types'

type RowComp = (p: { title: string; desc?: ReactNode; keywords?: string; control?: ReactNode; children?: ReactNode }) => ReactNode

interface Props {
  state: AppState
  Row: RowComp
  newId(): string
  /** 지금 모습을 백업한 뒤(mark) 상태를 바꾼다 — 실패 글 · 성공이면 null */
  onRestore(make: (cur: AppState) => Restored | null, mark: BackupMark): Promise<string | null>
}

const two = (n: number) => String(n).padStart(2, '0')
export const clock = (at: number) => {
  const d = new Date(at)
  return `${two(d.getHours())}:${two(d.getMinutes())}`
}
export const dateClock = (at: number) => {
  const d = new Date(at)
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${clock(at)}`
}

/** 전체 되돌리기 · 바꾸기 확인 — ↩ 는 위험하지 않은 쪽(취소), 되돌리기는 ⌘⌫ */
function ConfirmAll({ title, message, label, onConfirm, onCancel }: { title: string; message: string; label: string; onConfirm(): void; onCancel(): void }) {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation() // 설정 창을 닫지 않고 확인만
      onCancel()
    } else if (e.metaKey && e.key === 'Backspace') {
      e.preventDefault()
      onConfirm()
    }
  }
  return (
    <div className="dialog-backdrop" onKeyDown={onKey}>
      <div className="dialog" role="alertdialog" aria-modal="true" aria-label={title} data-testid="restore-confirm">
        <h2>{title}</h2>
        <p>{message}</p>
        <div className="dialog-actions">
          <button type="button" className="button" autoFocus onClick={onCancel}>
            취소 <kbd>esc</kbd>
          </button>
          <button type="button" className="button danger" data-testid="restore-confirm-ok" onClick={onConfirm}>
            {label} <kbd>⌘⌫</kbd>
          </button>
        </div>
      </div>
    </div>
  )
}

/** 지금과 비교한 미리 보기 — 일감 줄마다 '이 일감만 되살리기' */
function DiffView({ diff, busy, onTask, firstRef }: { diff: StateDiff; busy: boolean; onTask?(id: string): void; firstRef?: RefObject<HTMLButtonElement | null> }) {
  if (diff.same) return <p className="backup-same">지금과 같아요</p>
  let first = true
  const taskButton = (id: string) => {
    if (!onTask) return null
    const ref = first ? firstRef : undefined
    first = false
    return (
      <button type="button" className="button primary small" ref={ref} disabled={busy} data-testid="restore-task" onClick={() => onTask(id)}>
        이 일감만 되살리기
      </button>
    )
  }
  return (
    <div className="backup-diff" data-testid="backup-diff">
      {diff.back.length > 0 && (
        <section>
          <h3>다시 생길 일감 {diff.back.length}</h3>
          <ul>
            {diff.back.map((t) => (
              <li key={t.id} data-task-name={t.name}>
                <span className="diff-add">+ {t.name}</span> <span className="muted">탭 {t.tabs}</span>
                {taskButton(t.id)}
              </li>
            ))}
          </ul>
        </section>
      )}
      {diff.changed.length > 0 && (
        <section>
          <h3>바뀐 일감 {diff.changed.length}</h3>
          <ul>
            {diff.changed.map((t) => (
              <li key={t.id} data-task-name={t.name}>
                <span>~ {t.name}</span>{' '}
                <span className="muted">
                  {t.nameNow !== t.name ? `지금 이름 ‘${t.nameNow}’ · ` : ''}탭 {t.tabsNow} → {t.tabs}
                </span>
                {taskButton(t.id)}
              </li>
            ))}
          </ul>
        </section>
      )}
      {diff.gone.length > 0 && (
        <section>
          <h3>전체 되돌리면 사라질 일감 {diff.gone.length}</h3>
          <ul>
            {diff.gone.map((t) => (
              <li key={t.id}>
                <span className="diff-del">− {t.name}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {diff.settings.length > 0 && (
        <p className="muted">
          바뀐 설정: {diff.settings.join(' · ')}
          {diff.templates.back.length > 0 && ` · 다시 생길 템플릿 ${diff.templates.back.join(', ')}`}
          {diff.templates.gone.length > 0 && ` · 사라질 템플릿 ${diff.templates.gone.join(', ')}`}
        </p>
      )}
    </div>
  )
}

/** 설정 › 백업 · 되돌리기 (17단계 Backup) */
export function BackupSection({ state, Row, newId, onRestore }: Props) {
  const [list, setList] = useState<BackupInfo[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [selected, setSelected] = useState(0)
  const [showOlder, setShowOlder] = useState(false)
  const [snap, setSnap] = useState<{ name: string; state: AppState } | { name: string; error: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [confirm, setConfirm] = useState<{ title: string; message: string; label: string; run(): void } | null>(null)
  const [importing, setImporting] = useState<{ name: string; state: AppState } | null>(null)
  const readNo = useRef(0)
  const listRef = useRef<HTMLDivElement | null>(null)
  const firstTaskRef = useRef<HTMLButtonElement | null>(null)

  const refresh = () =>
    window.taskminal.backup.list().then(
      (l) => {
        setList(l)
        setListError(null)
      },
      (e: unknown) => setListError(String(e)),
    )
  useEffect(() => {
    void refresh()
  }, [])

  const groups = useMemo(() => groupBackups(list ?? [], Date.now(), new Date().getTimezoneOffset()), [list])
  const visible = groups.flatMap((g) => (g.id === 'older' && !showOlder ? [] : g.items))
  const current = visible[Math.min(selected, visible.length - 1)] ?? null

  // 고른 백업을 읽는다 — 읽는 동안 다른 것을 고르면 옛 응답은 버린다(읽기 번호)
  useEffect(() => {
    if (!current) return setSnap(null)
    const no = ++readNo.current
    window.taskminal.backup.read(current.name).then(
      (s) => no === readNo.current && setSnap({ name: current.name, state: s }),
      (e: unknown) => no === readNo.current && setSnap({ name: current.name, error: e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e) }),
    )
  }, [current?.name])

  const run = async (make: (cur: AppState) => Restored | null, mark: BackupMark, done: string) => {
    if (busy) return // 두 번 눌러도 한 번만
    setBusy(true)
    setConfirm(null)
    try {
      const error = await onRestore(make, mark)
      setMessage(error ? { ok: false, text: error } : { ok: true, text: done })
      await refresh()
    } finally {
      setBusy(false)
      // 누른 단추가 막히며 포커스를 잃었다 — 목록으로 돌려 ↑↓ · Esc 가 이어지게
      requestAnimationFrame(() => listRef.current?.focus())
    }
  }

  const snapState = snap && 'state' in snap ? snap.state : null
  const diff = snapState ? diffStates(state, snapState) : null

  const restoreOne = (taskId: string) => {
    if (!snapState) return
    const name = snapState.tasks.find((t) => t.id === taskId)?.name ?? ''
    void run((cur) => restoreTask(cur, snapState, taskId, newId), 'restore', `‘${name}’ 일감을 되살렸어요 · 지금 모습은 '되돌리기 전' 백업으로 남겼어요`)
  }
  const restoreEverything = () => {
    if (!snapState || !current) return
    const kill = restoreAll(state, snapState).kill.length
    setConfirm({
      title: '이 시점으로 모두 되돌릴까요?',
      message: `${dateClock(current.at)} 모습으로 일감 · 설정을 모두 바꿔요. 지금 모습은 '되돌리기 전' 백업으로 남아요.${kill > 0 ? ` 터미널 ${kill}개가 끝나요.` : ''}`,
      label: '모두 되돌리기',
      run: () => void run((cur) => restoreAll(cur, snapState), 'restore', `${dateClock(current.at)} 모습으로 되돌렸어요 · 지금 모습은 '되돌리기 전' 백업으로 남겼어요`),
    })
  }

  const onListKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((i) => Math.max(0, Math.min(visible.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1))))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      firstTaskRef.current?.focus()
    }
  }

  const doExport = async () => {
    try {
      const path = await window.taskminal.state.exportTo()
      if (path) setMessage({ ok: true, text: `내보냈어요 — 출력과 비밀값은 빼고 썼어요: ${path}` })
    } catch (e) {
      setMessage({ ok: false, text: `내보내지 못했어요: ${String(e)}` })
    }
  }
  const doImport = async () => {
    try {
      const r = await window.taskminal.state.importFrom()
      if (r) setImporting(r)
    } catch (e) {
      setMessage({ ok: false, text: `가져오지 못했어요: ${e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)}` })
    }
  }

  return (
    <>
      {message && (
        <p className={`backup-message ${message.ok ? 'ok' : 'err'}`} role="status" data-testid="backup-message">
          {message.text}
        </p>
      )}
      <Row title="백업에서 되돌리기" desc="상태(일감 · 탭 · 설정)를 자동으로 백업해요 — 시작할 때 · 지울 때 · 설정을 바꿀 때 · 한 시간마다. 출력은 백업하지 않아요." keywords="백업 되돌리기 복원 restore backup 지운 일감">
        {listError && <p className="err">백업 목록을 읽지 못했어요: {listError}</p>}
        {list && list.length === 0 && <p className="muted">아직 백업이 없어요. 상태가 저장되면 만들어져요.</p>}
        {list && list.length > 0 && (
          <div className="backup-pane">
            <div ref={listRef} className="backup-list" role="listbox" tabIndex={0} aria-label="백업 목록" aria-activedescendant={current ? `backup-${current.name}` : undefined} data-testid="backup-list" onKeyDown={onListKey}>
              {groups.map((g) => (
                <div key={g.id} className="backup-group">
                  <div className="backup-group-title">
                    {g.title}
                    {g.id === 'older' && (
                      <button type="button" className="link" onClick={() => setShowOlder((v) => !v)}>
                        {showOlder ? '접기' : `${g.items.length}개 보기`}
                      </button>
                    )}
                  </div>
                  {(g.id !== 'older' || showOlder) &&
                    g.items.map((b) => {
                      const i = visible.indexOf(b)
                      return (
                        <div
                          key={b.name}
                          id={`backup-${b.name}`}
                          role="option"
                          aria-selected={b === current}
                          className={`backup-row${b === current ? ' selected' : ''}`}
                          data-testid="backup-row"
                          data-reason={b.reason}
                          onClick={() => setSelected(i)}
                        >
                          <span className="backup-time">{g.id === 'today' || g.id === 'yesterday' ? clock(b.at) : dateClock(b.at)}</span>
                          <span className={`reason-chip reason-${b.reason}`}>{REASON_LABEL[b.reason]}</span>
                          <span className="muted">{b.tasks === null ? '읽을 수 없음' : `일감 ${b.tasks}`}</span>
                        </div>
                      )
                    })}
                </div>
              ))}
            </div>
            <div className="backup-preview" data-testid="backup-preview">
              {!snap && <p className="muted">읽는 중…</p>}
              {snap && 'error' in snap && <p className="err">이 백업은 읽을 수 없어요: {snap.error}</p>}
              {diff && (
                <>
                  <DiffView diff={diff} busy={busy} onTask={restoreOne} firstRef={firstTaskRef} />
                  {!diff.same && (
                    <button type="button" className="button danger-outline" disabled={busy} data-testid="restore-all" onClick={restoreEverything}>
                      전체 되돌리기…
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </Row>
      <Row title="내보내기 · 가져오기" desc="다른 Mac 으로 옮기거나 따로 보관할 때. 출력과 비밀값은 빼고 써요." keywords="내보내기 가져오기 export import json">
        <div className="row-buttons">
          <button type="button" className="button" disabled={busy} onClick={() => void doExport()}>
            내보내기…
          </button>
          <button type="button" className="button" disabled={busy} onClick={() => void doImport()}>
            가져오기…
          </button>
        </div>
      </Row>
      {importing && (
        <div className="dialog-backdrop" onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setImporting(null))}>
          <div className="dialog wide" role="dialog" aria-modal="true" aria-label="가져오기" data-testid="import-dialog">
            <h2>‘{importing.name}’ 가져오기</h2>
            <DiffView diff={diffStates(state, importing.state)} busy={busy} />
            <div className="dialog-actions">
              <button type="button" className="button" onClick={() => setImporting(null)}>
                취소 <kbd>esc</kbd>
              </button>
              <button
                type="button"
                className="button danger-outline"
                disabled={busy}
                onClick={() => {
                  const incoming = importing.state
                  setImporting(null)
                  setConfirm({
                    title: '가져온 것으로 모두 바꿀까요?',
                    message: `지금 일감 · 설정을 모두 바꿔요. 지금 모습은 '가져오기 전' 백업으로 남아요.${paneCount(state.tasks) > 0 ? ' 없어지는 일감의 터미널은 끝나요.' : ''}`,
                    label: '모두 바꾸기',
                    run: () => void run((cur) => restoreAll(cur, incoming), 'import', "가져온 것으로 바꿨어요 · 지금 모습은 '가져오기 전' 백업으로 남겼어요"),
                  })
                }}
              >
                바꾸기…
              </button>
              <button
                type="button"
                className="button primary"
                autoFocus
                disabled={busy}
                data-testid="import-merge"
                onClick={() => {
                  const incoming = importing.state
                  setImporting(null)
                  let added = 0
                  void run(
                    (cur) => {
                      const m = mergeState(cur, incoming, newId)
                      added = m.added
                      return { state: m.state, kill: [] }
                    },
                    'import',
                    '합쳤어요',
                  ).then(() => setMessage((m) => (m?.ok ? { ok: true, text: `일감 ${added}개를 더했어요 · 지금 모습은 '가져오기 전' 백업으로 남겼어요` } : m)))
                }}
              >
                합치기 (추천) <kbd>↩</kbd>
              </button>
            </div>
          </div>
        </div>
      )}
      {confirm && <ConfirmAll title={confirm.title} message={confirm.message} label={confirm.label} onConfirm={confirm.run} onCancel={() => setConfirm(null)} />}
    </>
  )
}
