import { useEffect, useRef, useState } from 'react'
import { isAbsolutePath } from '../shared/platform'
import type {
  CreateWorktree, ManagedWorktree, WorktreeApi, WorktreeSnapshot, WorktreeView,
} from '../shared/worktree-management'
import { ConfirmDialog } from './ConfirmDialog'
import './worktree-panel.css'

interface Props {
  root: string
  /** Recheck the source task before creating/selecting it; respect signal after any await. */
  onOpen(path: string, taskId?: string, signal?: AbortSignal, expectedCwd?: string): void | Promise<void>
  api?: WorktreeApi
}

interface Draft { branch: string; base: string; path: string }
interface PendingCreate { input: CreateWorktree; state: 'pending' | 'unknown' }
interface Removal { root: string; target: WorktreeSnapshot; label: string }
const pendingCreates = new Map<string, PendingCreate>()
const emptyDraft = (): Draft => ({ branch: '', base: '', path: '' })
const message = (error: unknown) => error instanceof Error ? error.message : '요청 결과를 확인하지 못했어요. 목록을 다시 읽어 주세요.'
const snapshot = (entry: ManagedWorktree): WorktreeSnapshot => ({ path: entry.path, commonDir: entry.commonDir, head: entry.head, branch: entry.branch })
const sameTarget = (entry: WorktreeSnapshot, other: WorktreeSnapshot) => entry.path === other.path && entry.commonDir === other.commonDir && entry.head === other.head && entry.branch === other.branch
const sameInput = (a: Draft, b: Draft) => a.branch === b.branch && a.base === b.base && a.path === b.path
const label = (entry: ManagedWorktree) => entry.bare ? 'bare 저장소' : entry.path === entry.commonDir ? '기본 Git 정보' : entry.branch?.replace(/^refs\/heads\//, '') ?? '분리된 HEAD'

/** Filesystem mutations remain in main; opening a task happens only after a current validated reply. */
export function WorktreePanel({ root, onOpen, api = window.taskminal.worktrees }: Props) {
  const [view, setView] = useState<WorktreeView | null>(null)
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const [pending, setPending] = useState<PendingCreate | null>(() => pendingCreates.get(root) ?? null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<'create' | 'open' | 'remove' | null>(null)
  const [readError, setReadError] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [deleting, setDeleting] = useState<Removal | null>(null)
  const panel = useRef<HTMLElement>(null)
  const deleteTrigger = useRef<HTMLButtonElement | null>(null)
  const mounted = useRef(false)
  const lifecycle = useRef(0)
  const currentRoot = useRef(root)
  currentRoot.current = root
  const version = useRef(0)
  const lock = useRef(false)
  const reading = useRef<Promise<void> | null>(null)
  const readAgain = useRef(false)
  const refresh = useRef<() => Promise<void>>(async () => {})
  const opening = useRef<AbortController | null>(null)

  useEffect(() => {
    mounted.current = true
    const current = ++lifecycle.current
    setView(null); setDraft(emptyDraft()); setDeleting(null)
    setPending(pendingCreates.get(root) ?? null)
    setLoading(true); setReadError(''); setError(''); setNotice('')
    const read = (): Promise<void> => {
      if (lock.current) { readAgain.current = true; return Promise.resolve() }
      if (reading.current) { readAgain.current = true; return reading.current }
      readAgain.current = false
      const started = version.current
      const job = api.list(root)
        .then((value) => {
          if (mounted.current && lifecycle.current === current && currentRoot.current === root && started === version.current && !lock.current) {
            setView(value); setReadError(''); setPending(pendingCreates.get(root) ?? null)
          }
        })
        .catch((reason: unknown) => {
          if (mounted.current && lifecycle.current === current && started === version.current) setReadError(message(reason))
        })
        .finally(() => {
          if (reading.current === job) reading.current = null
          if (mounted.current && lifecycle.current === current && started === version.current) setLoading(false)
          if (readAgain.current && mounted.current) { readAgain.current = false; void refresh.current() }
        })
      reading.current = job
      return job
    }
    refresh.current = read
    void read()
    return () => { mounted.current = false; lifecycle.current++; opening.current?.abort() }
  }, [root, api])

  const write = async <T,>(kind: 'create' | 'open' | 'remove', operation: () => Promise<T>, after?: (value: T) => void | Promise<void>) => {
    if (lock.current) return
    lock.current = true; version.current++; setBusy(kind); setError(''); setNotice('')
    const current = lifecycle.current, source = root
    try {
      const value = await operation()
      if (mounted.current && lifecycle.current === current && currentRoot.current === source) await after?.(value)
    } catch (reason) {
      if (mounted.current && lifecycle.current === current && currentRoot.current === source) setError(message(reason))
    } finally {
      version.current++; lock.current = false
      if (mounted.current) { setBusy(null); void refresh.current() }
    }
  }

  const submit = () => {
    if (lock.current) return
    const input: Draft = { branch: draft.branch.trim(), base: draft.base.trim(), path: draft.path }
    if (!input.branch || !input.base || !isAbsolutePath(input.path) || input.path.includes('\0')) {
      setError('브랜치·기준 커밋과 새 폴더의 절대 경로를 입력하세요.')
      return
    }
    const old = pendingCreates.get(root)
    if (!old && pendingCreates.size >= 1000) { setError('확인하지 못한 요청이 많아요. 이전 생성 결과를 먼저 확인해 주세요.'); return }
    const request: PendingCreate = old && sameInput(old.input, input)
      ? { input: { ...old.input }, state: 'pending' }
      : { input: { ...input, requestId: crypto.randomUUID() }, state: 'pending' }
    pendingCreates.set(root, request); setPending(request)
    void write('create', async () => {
      try {
        const result = await api.create(root, { ...request.input })
        if (pendingCreates.get(root)?.input.requestId === request.input.requestId) {
          if (result.state === 'unknown') pendingCreates.set(root, { ...request, state: 'unknown' })
          else pendingCreates.delete(root)
        }
        return result
      } catch (reason) {
        if (pendingCreates.get(root)?.input.requestId === request.input.requestId) pendingCreates.set(root, { ...request, state: 'unknown' })
        throw reason
      }
    }, (result) => {
      setPending(pendingCreates.get(root) ?? null)
      if (result.state === 'created') {
        setDraft(emptyDraft())
        setNotice(`${result.message} 목록에서 일감으로 열 수 있어요.`)
      }
      else setError(`${result.message} 경로: ${result.path}`)
    })
  }

  const open = (entry: ManagedWorktree) => {
    if (lock.current) return
    const target = snapshot(entry), controller = new AbortController()
    opening.current?.abort(); opening.current = controller
    void write('open', () => api.open(root, target), async (result) => {
      if (!controller.signal.aborted) await onOpen(result.path, result.taskId, controller.signal, result.cwd)
    })
  }

  const dismissRemoval = () => {
    setDeleting(null)
    queueMicrotask(() => {
      if (!mounted.current) return
      const trigger = deleteTrigger.current
      if (trigger?.isConnected && !trigger.disabled) trigger.focus()
      else panel.current?.focus({ preventScroll: true })
    })
  }
  const remove = () => {
    if (lock.current) return
    const confirmed = deleting
    setDeleting(null)
    panel.current?.focus({ preventScroll: true })
    if (!confirmed || confirmed.root !== root || !view?.entries.some((entry) => sameTarget(entry, confirmed.target) && entry.removable)) {
      setError('확인한 대상이 바뀌었어요. 목록을 다시 읽고 선택하세요.')
      return
    }
    void write('remove', () => api.remove(confirmed.root, { ...confirmed.target }), (result) => {
      if (result.state === 'removed') setNotice(result.message)
      else setError(result.message)
    })
  }

  const disabled = !!busy || loading || !!readError
  const changedPending = pending && !sameInput(pending.input, { branch: draft.branch.trim(), base: draft.base.trim(), path: draft.path })
  return <section ref={panel} tabIndex={-1} className="worktree-panel" aria-label="워크트리 관리">
    <div className="worktree-intro">연결된 checkout을 확인하고 일감으로 열 수 있어요. 정리하면 checkout 폴더와 등록이 제거되며 브랜치는 보존됩니다.</div>
    <div className="worktree-actions"><button type="button" className="button" disabled={!!busy || loading} onClick={() => { setLoading(true); void refresh.current() }}>목록 새로 읽기</button></div>
    {readError && <div role="alert" className="worktree-error">{readError} <button type="button" className="button" disabled={!!busy} onClick={() => { setLoading(true); void refresh.current() }}>다시 읽기</button></div>}
    {error && <div role="alert" className="worktree-error">{error}</div>}
    <div role="status" className="worktree-meta">{busy === 'create' ? 'checkout 만드는 중… 패널을 닫아도 생성은 끝날 수 있어요.' : busy === 'remove' ? '정리 결과를 확인하는 중…' : busy === 'open' ? 'checkout을 확인하는 중…' : loading ? '목록을 읽는 중…' : notice}</div>
    {pending && busy !== 'create' && <aside className="worktree-pending" role="status">
      <strong>앞 생성 요청의 결과를 확인해야 해요.</strong>
      <div className="worktree-path">{pending.input.path}</div>
      <div className="worktree-meta">{pending.input.branch} · 기준 {pending.input.base}</div>
      <p>먼저 목록과 폴더를 확인하세요. 같은 내용으로 다시 시도하면 이전 요청으로 확인합니다.</p>
      {changedPending && <p className="worktree-error">입력이 바뀌어 다음 시도는 새 요청이 됩니다. 앞 요청에서 이미 만들어진 checkout이 있는지 확인하세요.</p>}
      <button type="button" className="button" disabled={!!busy} onClick={() => setDraft({ branch: pending.input.branch, base: pending.input.base, path: pending.input.path })}>앞 요청의 입력으로 돌아가기</button>
    </aside>}
    <form className="worktree-editor" onSubmit={(event) => { event.preventDefault(); submit() }}>
      <fieldset disabled={!!busy || loading || !view || !!readError}>
        <legend>새 checkout</legend>
        <label className="field"><span>브랜치 이름</span><input required maxLength={100} autoCapitalize="none" spellCheck={false} value={draft.branch} placeholder="feature/example" onChange={(event) => setDraft({ ...draft, branch: event.target.value })} /></label>
        <label className="field"><span>기준 커밋 또는 ref</span><input required maxLength={256} autoCapitalize="none" spellCheck={false} value={draft.base} placeholder="main 또는 커밋 SHA" onChange={(event) => setDraft({ ...draft, base: event.target.value })} /></label>
        <label className="field"><span>새 checkout의 절대 경로</span><input required maxLength={4096} autoCapitalize="none" spellCheck={false} value={draft.path} placeholder="/Users/me/projects/new-checkout" onChange={(event) => setDraft({ ...draft, path: event.target.value })} /></label>
        <div className="worktree-meta">입력한 기준 커밋에서 새 브랜치와 폴더를 만들어요.</div>
        <div className="worktree-actions"><button type="submit" className="button primary">{pending && !changedPending ? '같은 생성 요청 다시 시도' : 'checkout 만들기'}</button></div>
      </fieldset>
    </form>
    {view && <>
      <div className="worktree-meta worktree-path">저장소: {view.root} · checkout {view.entries.length}개</div>
      <div className="worktree-list">{view.entries.map((entry, index) => <article className="worktree-card" key={`${entry.path}:${index}`} aria-label={`${label(entry)} · ${entry.path}`}>
        <h3>{label(entry)}</h3><div className="worktree-path">{entry.path}</div>
        {!!entry.tasks?.length && <div className="worktree-meta">연결된 일감: {entry.tasks.map((task) => task.name).join(', ')}</div>}
        {entry.head && <div className="worktree-meta">HEAD <code title={entry.head}>{entry.head.slice(0, 12)}</code></div>}
        <div className="worktree-flags">
          {entry.primary && <span>기본</span>}{entry.bare && <span>bare</span>}{entry.locked && <span>잠김</span>}{entry.prunable && <span>등록 복구 필요</span>}
          {entry.used && <span>앱에서 사용 중</span>}{entry.nested && <span>하위 checkout·Git 정보</span>}{entry.dirty && <span>추적 파일 변경</span>}
          {entry.untracked && <span>미추적 파일</span>}{entry.ignored && <span>무시된 파일</span>}{entry.unsafeIndex && <span>index 설정 확인</span>}
          {!entry.statusKnown && <span>상태 미확인</span>}{entry.removable && <span>정리 가능</span>}
        </div>
        {(entry.lockedReason || entry.prunableReason) && <div className="worktree-meta">{entry.lockedReason || entry.prunableReason}</div>}
        {!!entry.reasons.length && <ul className="worktree-reasons">{entry.reasons.map((reason, i) => <li key={i}>{reason}</li>)}</ul>}
        <div className="worktree-actions">
          <button type="button" className="button" disabled={disabled || !entry.canOpen} onClick={() => open(entry)}>일감으로 열기</button>
          <button type="button" className="button danger" disabled={disabled || !entry.removable} onClick={(event) => { deleteTrigger.current = event.currentTarget; setDeleting({ root, target: snapshot(entry), label: label(entry) }) }}>정리…</button>
        </div>
      </article>)}</div>
    </>}
    {deleting && <ConfirmDialog title="checkout을 정리할까요?" message={`경로: ${deleting.target.path}\n브랜치: ${deleting.label}\nHEAD: ${deleting.target.head ?? '없음'}\n\n폴더와 worktree 등록을 제거합니다. 실행 전에 사용 여부와 변경 내용을 다시 확인합니다. 브랜치는 보존됩니다.`} confirmLabel="이 checkout 정리" onConfirm={remove} onCancel={dismissRemoval} />}
  </section>
}
