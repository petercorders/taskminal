import { useEffect, useRef, useState } from 'react'
import { isAbsolutePath } from '../shared/platform'
import {
  prepareAfterCreate, prepareTarget, sameTarget,
  type CreateWorktree, type ManagedWorktree, type WorktreeApi, type WorktreeSnapshot, type WorktreeView,
} from '../shared/worktree-management'
import {
  cleanupPreview, cleanupStep, MERGE_LABEL, runCleanup,
  type CleanupAction, type CleanupCandidate, type CleanupFlow, type CleanupReportRow,
} from '../shared/worktree-cleanup'
import { ConfirmDialog } from './ConfirmDialog'
import { ipcMessage } from './ipc-message'
import './worktree-panel.css'

interface Props {
  root: string
  /** Recheck the source task before creating/selecting it; respect signal after any await. */
  onOpen(path: string, taskId?: string, signal?: AbortSignal, expectedCwd?: string): void | Promise<void>
  api?: WorktreeApi
  /** 56단계: 이 워크트리에 환경 준비 — 환경 패널을 그 경로를 고른 채로 연다.
   *  preview(62단계): 방금 만든 워크트리 — 미리보기까지 읽어 보인다(실행은 미리보기에서 확인한 뒤에만) */
  onPrepare?(path: string, preview?: boolean): void
  /** 67단계: 정리와 함께 연결 일감 보관 — 셸을 끄고 상태를 main 에 먼저 보낸 뒤, 지금 보관 상태인 id 를 돌려준다 */
  onArchive?(taskIds: string[]): string[]
  /** 67단계: 이 일감에서 명령이 돌고 있나 — 돌면 정리 후보에서 뺀다 */
  busy?(taskId: string): boolean
  /** 67단계: 목록을 읽을 때마다 — 연결 일감 카드의 병합 칩 */
  onMerge?(view: WorktreeView): void
  /** 70단계: 이 저장소째 가져오기 — 가져오기 대화상자를 이 패널의 폴더로 연다 */
  onImportRepo?(): void
}

interface Draft { branch: string; base: string; path: string }
interface PendingCreate { input: CreateWorktree; state: 'pending' | 'unknown' }
interface Removal { root: string; target: WorktreeSnapshot; label: string }
const pendingCreates = new Map<string, PendingCreate>()
const emptyDraft = (): Draft => ({ branch: '', base: '', path: '' })
// main 이 던진 오류 — Electron 이 붙이는 머리는 걷어 낸다(ipcMessage)
const message = (error: unknown) => ipcMessage(error, '요청 결과를 확인하지 못했어요. 목록을 다시 읽어 주세요.', { keepEmpty: true })
const snapshot = (entry: ManagedWorktree): WorktreeSnapshot => ({ path: entry.path, commonDir: entry.commonDir, head: entry.head, branch: entry.branch })
const sameInput = (a: Draft, b: Draft) => a.branch === b.branch && a.base === b.base && a.path === b.path
const day = (at: number) => new Date(at).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' })
const CLEAN_STATE: Record<CleanupReportRow['state'], string> = { removed: '정리함', unchanged: '남음', unknown: '확인 못 함', skipped: '안 함' }
const label = (entry: ManagedWorktree) => entry.bare ? 'bare 저장소' : entry.path === entry.commonDir ? '기본 Git 정보' : entry.branch?.replace(/^refs\/heads\//, '') ?? '분리된 HEAD'

/** Filesystem mutations remain in main; opening a task happens only after a current validated reply. */
export function WorktreePanel({ root, onOpen, onPrepare, onArchive = () => [], busy: taskBusy = () => false, onMerge, onImportRepo, api = window.taskminal.worktrees }: Props) {
  const [view, setView] = useState<WorktreeView | null>(null)
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const [pending, setPending] = useState<PendingCreate | null>(() => pendingCreates.get(root) ?? null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<'create' | 'open' | 'remove' | 'clean' | null>(null)
  const [readError, setReadError] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [deleting, setDeleting] = useState<Removal | null>(null)
  // 67단계: 병합된 것 정리 — 고르기 → 확인(연 순간의 사본) → confirm 일 때만 실행
  const [flow, setFlow] = useState<CleanupFlow>({ kind: 'idle' })
  const flowRef = useRef<CleanupFlow>({ kind: 'idle' })
  const [report, setReport] = useState<CleanupReportRow[] | null>(null)
  const cleanTrigger = useRef<HTMLButtonElement>(null)
  const askTrigger = useRef<HTMLButtonElement>(null)
  const mergeRef = useRef(onMerge)
  mergeRef.current = onMerge
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
    flowRef.current = { kind: 'idle' }; setFlow(flowRef.current); setReport(null)
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
            mergeRef.current?.(value)
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

  const write = async <T,>(kind: 'create' | 'open' | 'remove' | 'clean', operation: () => Promise<T>, after?: (value: T) => void | Promise<void>) => {
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
        // 62단계: 저장소에 환경 설정이 있으면 만든 워크트리의 환경 준비 미리보기로 잇는다 — 카드의 '환경 준비…' 와 같은 길
        const target = prepareAfterCreate(result)
        if (target) onPrepare?.(target, true)
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

  const step = (action: CleanupAction): CleanupCandidate[] | undefined => {
    const next = cleanupStep(flowRef.current, action)
    flowRef.current = next.flow
    setFlow(next.flow)
    return next.run
  }
  /** 다시 그린 뒤 켜진 단추로 — 꺼졌거나 사라졌으면 패널로(39 dismissRemoval 과 같은 꼴) */
  const focusAfter = (target: { current: HTMLButtonElement | null }) => queueMicrotask(() => {
    if (!mounted.current) return
    const button = target.current
    if (button?.isConnected && !button.disabled) button.focus()
    else panel.current?.focus({ preventScroll: true })
  })
  const cancelCleanup = () => { step({ type: 'cancel' }); focusAfter(askTrigger) }
  const confirmCleanup = () => {
    if (lock.current) return
    const items = step({ type: 'confirm' })
    if (!items) return
    panel.current?.focus({ preventScroll: true })
    setReport(null)
    const current = lifecycle.current
    void write('clean', () => runCleanup(root, items, { list: api.list, busy: taskBusy, archive: onArchive, clean: api.clean }), (rows) => {
      setReport(rows)
      const count = (state: CleanupReportRow['state']) => rows.filter((row) => row.state === state).length
      const removed = count('removed'), left = rows.length - removed
      setNotice(left ? `${removed}개 정리 · ${left}개는 정리하지 않았어요 — 아래 결과를 확인하세요.` : `${removed}개 정리했어요. 브랜치는 남았어요.`)
    }).finally(() => { if (mounted.current && lifecycle.current === current) step({ type: 'done' }) })
  }

  const disabled = !!busy || loading || !!readError
  const preview = view ? cleanupPreview(view, taskBusy) : null
  const picked = flow.kind === 'preview' ? flow.picked.filter((path) => preview?.candidates.some((c) => c.path === path)) : []
  const changedPending = pending && !sameInput(pending.input, { branch: draft.branch.trim(), base: draft.base.trim(), path: draft.path })
  return <section ref={panel} tabIndex={-1} className="worktree-panel" aria-label="워크트리 관리">
    <div className="worktree-intro">이 저장소의 워크트리를 확인하고 일감으로 열거나 환경을 준비해요. 정리하면 워크트리 폴더와 등록이 지워지고 브랜치는 남아요.</div>
    <div className="worktree-actions">
      <button type="button" className="button" disabled={!!busy || loading} onClick={() => { setLoading(true); void refresh.current() }}>목록 새로 읽기</button>
      <button ref={cleanTrigger} type="button" className="button" disabled={disabled || !view || flow.kind !== 'idle'} aria-expanded={flow.kind !== 'idle'} onClick={() => { setReport(null); step({ type: 'open' }) }}>병합된 것 정리…{preview?.candidates.length ? ` (${preview.candidates.length})` : ''}</button>
      {onImportRepo && <button type="button" className="button" disabled={!!busy} onClick={onImportRepo}>이 저장소째 가져오기…</button>}
    </div>
    {readError && <div role="alert" className="worktree-error">{readError} <button type="button" className="button" disabled={!!busy} onClick={() => { setLoading(true); void refresh.current() }}>다시 읽기</button></div>}
    {error && <div role="alert" className="worktree-error">{error}</div>}
    <div role="status" className="worktree-meta">{busy === 'create' ? '워크트리 만드는 중… 패널을 닫아도 생성은 끝날 수 있어요.' : busy === 'clean' ? '고른 워크트리를 하나씩 다시 확인하고 정리하는 중… 패널을 닫아도 정리는 끝까지 진행돼요.' : busy === 'remove' ? '정리 결과를 확인하는 중…' : busy === 'open' ? '워크트리를 확인하는 중…' : loading ? '목록을 읽는 중…' : notice}</div>
    {report && <section className="worktree-cleanup" aria-label="정리 결과">
      <h3>정리 결과</h3>
      <ul className="worktree-cleanup-list">{report.map((row) => <li key={row.path} className={`worktree-cleanup-row ${row.state}`}>
        <strong>{CLEAN_STATE[row.state]}</strong> · {row.label}<div className="worktree-path">{row.path}</div>
        <div className={row.state === 'removed' ? 'worktree-meta' : 'worktree-error'}>{row.message}</div>
        {!!row.archived.length && <div className="worktree-meta">보관한 일감: {row.archived.join(', ')}{row.state === 'removed' ? '' : row.state === 'unknown' ? ' — 워크트리가 남았는지 목록에서 확인한 뒤 보관함에서 되살리세요' : ' — 워크트리가 남아 있어 보관함에서 되살리면 그대로 써요'}</div>}
      </li>)}</ul>
      <div className="worktree-actions"><button type="button" className="button" onClick={() => { setReport(null); focusAfter(cleanTrigger) }}>결과 닫기</button></div>
    </section>}
    {flow.kind !== 'idle' && preview && <section className="worktree-cleanup" aria-label="병합된 워크트리 정리">
      <h3>병합된 것 정리</h3>
      <p className="worktree-meta">기준 브랜치에 병합된 워크트리예요. 고른 것만 지우기 직전에 경로·HEAD·변경을 다시 확인해 정리하고, 연결 일감은 보관해요(보관함에서 되살릴 수 있어요). 브랜치는 남아요.</p>
      {preview.candidates.length === 0 ? <p className="worktree-meta">정리할 후보가 없어요.</p> : <fieldset className="worktree-cleanup-list" disabled={flow.kind !== 'preview' || !!busy}>
        <legend>정리할 워크트리 고르기</legend>
        {preview.candidates.map((c) => <label key={c.path} className="worktree-cleanup-item">
          <input type="checkbox" checked={picked.includes(c.path)} onChange={() => step({ type: 'toggle', path: c.path })} />
          <span className="worktree-cleanup-text">
            <strong>{c.label}</strong>
            <span className="worktree-path">{c.path}</span>
            <span className="worktree-meta">마지막 커밋 {c.last ? `${day(c.last.at)} · ${c.last.subject}` : '확인 못 함'} · HEAD <code>{c.head?.slice(0, 12)}</code> · 변경 없음</span>
            {!!c.tasks.length && <span className="worktree-meta">함께 보관할 일감: {c.tasks.map((t) => t.archived ? `${t.name}(이미 보관됨)` : t.name).join(', ')}</span>}
          </span>
        </label>)}
      </fieldset>}
      {!!preview.excluded.length && <details className="worktree-cleanup-excluded">
        <summary>병합됐지만 정리하지 않는 것 {preview.excluded.length}개</summary>
        <ul className="worktree-reasons">{preview.excluded.map((e) => <li key={e.path}>{e.label} · <span className="worktree-path">{e.path}</span> — {e.reason}</li>)}</ul>
      </details>}
      {(preview.unknown > 0 || preview.fresh > 0) && <p className="worktree-meta">병합 모름 {preview.unknown}개 · 커밋 없는 새 브랜치 {preview.fresh}개는 후보가 아니에요. squash·rebase로 병합한 것은 병합 모름으로 보여요.</p>}
      <div className="worktree-actions">
        <button ref={askTrigger} type="button" className="button danger" disabled={!!busy || flow.kind !== 'preview' || picked.length === 0} onClick={() => step({ type: 'ask', candidates: preview.candidates })}>고른 {picked.length}개 정리…</button>
        <button type="button" className="button" disabled={flow.kind === 'running'} onClick={() => { step({ type: 'close' }); focusAfter(cleanTrigger) }}>닫기</button>
      </div>
    </section>}
    {pending && busy !== 'create' && <aside className="worktree-pending" role="status">
      <strong>앞 생성 요청의 결과를 확인해야 해요.</strong>
      <div className="worktree-path">{pending.input.path}</div>
      <div className="worktree-meta">{pending.input.branch} · 기준 {pending.input.base}</div>
      <p>먼저 목록과 폴더를 확인하세요. 같은 내용으로 다시 시도하면 이전 요청으로 확인합니다.</p>
      {changedPending && <p className="worktree-error">입력이 바뀌어 다음 시도는 새 요청이 됩니다. 앞 요청에서 이미 만들어진 워크트리가 있는지 확인하세요.</p>}
      <button type="button" className="button" disabled={!!busy} onClick={() => setDraft({ branch: pending.input.branch, base: pending.input.base, path: pending.input.path })}>앞 요청의 입력으로 돌아가기</button>
    </aside>}
    <form className="worktree-editor" onSubmit={(event) => { event.preventDefault(); submit() }}>
      <fieldset disabled={!!busy || loading || !view || !!readError}>
        <legend>새 워크트리</legend>
        <label className="field"><span>브랜치 이름</span><input required maxLength={100} autoCapitalize="none" spellCheck={false} value={draft.branch} placeholder="feature/example" onChange={(event) => setDraft({ ...draft, branch: event.target.value })} /></label>
        <label className="field"><span>기준 커밋 또는 ref</span><input required maxLength={256} autoCapitalize="none" spellCheck={false} value={draft.base} placeholder="main 또는 커밋 SHA" onChange={(event) => setDraft({ ...draft, base: event.target.value })} /></label>
        <label className="field"><span>새 워크트리 폴더의 절대 경로</span><input required maxLength={4096} autoCapitalize="none" spellCheck={false} value={draft.path} placeholder="/Users/me/projects/new-checkout" onChange={(event) => setDraft({ ...draft, path: event.target.value })} /></label>
        <div className="worktree-meta">입력한 기준 커밋에서 새 브랜치와 폴더를 만들어요.</div>
        <div className="worktree-actions"><button type="submit" className="button primary">{pending && !changedPending ? '같은 생성 요청 다시 시도' : '워크트리 만들기'}</button></div>
      </fieldset>
    </form>
    {view && <>
      <div className="worktree-meta worktree-path">저장소: {view.root} · 워크트리 {view.entries.length}개</div>
      <div className="worktree-list">{view.entries.map((entry, index) => <article className="worktree-card" key={`${entry.path}:${index}`} aria-label={`${label(entry)} · ${entry.path}`}>
        <h3>{label(entry)}</h3><div className="worktree-path">{entry.path}</div>
        {!!entry.tasks?.length && <div className="worktree-meta">연결된 일감: {entry.tasks.map((task) => task.name).join(', ')}</div>}
        {entry.head && <div className="worktree-meta">HEAD <code title={entry.head}>{entry.head.slice(0, 12)}</code></div>}
        <div className="worktree-flags">
          {entry.primary && <span>기본</span>}{entry.bare && <span>bare</span>}{entry.locked && <span>잠김</span>}{entry.prunable && <span>등록 복구 필요</span>}
          {entry.used && <span>앱에서 사용 중</span>}{entry.nested && <span>하위 워크트리·Git 정보</span>}{entry.dirty && <span>추적 파일 변경</span>}
          {entry.untracked && <span>미추적 파일</span>}{entry.ignored && <span>무시된 파일</span>}{entry.unsafeIndex && <span>index 설정 확인</span>}
          {!entry.statusKnown && <span>상태 미확인</span>}{entry.removable && <span>정리 가능</span>}
          {entry.merge && MERGE_LABEL[entry.merge.state] && <span className={`worktree-merge ${entry.merge.state}`} title={entry.merge.reason}>{MERGE_LABEL[entry.merge.state]}</span>}
        </div>
        {(entry.lockedReason || entry.prunableReason) && <div className="worktree-meta">{entry.lockedReason || entry.prunableReason}</div>}
        {entry.merge && entry.merge.state !== 'merged' && <div className="worktree-meta">{MERGE_LABEL[entry.merge.state] ?? '새 브랜치'} — {entry.merge.reason}</div>}
        {!!entry.reasons.length && <ul className="worktree-reasons">{entry.reasons.map((reason, i) => <li key={i}>{reason}</li>)}</ul>}
        <div className="worktree-actions">
          <button type="button" className="button" disabled={disabled || !entry.canOpen} onClick={() => open(entry)}>일감으로 열기</button>
          {onPrepare && prepareTarget(entry, view.root) && <button type="button" className="button" disabled={disabled} onClick={() => onPrepare(entry.path)}>환경 준비…</button>}
          <button type="button" className="button danger" disabled={disabled || !entry.removable} onClick={(event) => { deleteTrigger.current = event.currentTarget; setDeleting({ root, target: snapshot(entry), label: label(entry) }) }}>정리…</button>
        </div>
      </article>)}</div>
    </>}
    {flow.kind === 'asking' && <ConfirmDialog title={`워크트리 ${flow.items.length}개를 정리할까요?`} message={`${flow.items.map((c) => `· ${c.label}\n  ${c.path}\n  HEAD ${c.head?.slice(0, 12) ?? '없음'}${c.tasks.length ? `\n  보관할 일감: ${c.tasks.map((t) => t.name).join(', ')}` : ''}`).join('\n')}\n\n폴더와 worktree 등록을 하나씩 지워요. 지우기 직전에 경로·HEAD·변경·사용 여부를 다시 확인해 바뀐 것은 건너뛰어요. 브랜치는 남아요.${flow.items.some((c) => c.tasks.length) ? '\n연결 일감은 셸을 끄고 보관해요 — 되살리면 폴더가 없어 셸은 홈에서 열려요.' : ''}`} confirmLabel="고른 워크트리 정리" onConfirm={confirmCleanup} onCancel={cancelCleanup} />}
    {deleting && <ConfirmDialog title="워크트리를 정리할까요?" message={`경로: ${deleting.target.path}\n브랜치: ${deleting.label}\nHEAD: ${deleting.target.head ?? '없음'}\n\n폴더와 worktree 등록을 제거합니다. 실행 전에 사용 여부와 변경 내용을 다시 확인합니다. 브랜치는 보존됩니다.`} confirmLabel="이 워크트리 정리" onConfirm={remove} onCancel={dismissRemoval} />}
  </section>
}
