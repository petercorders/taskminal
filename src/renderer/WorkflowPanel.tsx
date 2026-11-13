import { useEffect, useRef, useState } from 'react'
import type { Workflow, WorkflowRun, WorkflowStep, WorkflowView } from '../shared/workflows'
import { ConfirmDialog } from './ConfirmDialog'
import './workflow-panel.css'

interface Props { taskId: string; initialRunId?: string | undefined; onOpenPane(paneId: string): void }
const labels: Record<WorkflowRun['status'] | WorkflowRun['steps'][number]['status'], string> = {
  pending: '대기', preparing: '준비 중', running: '진행 중', waiting: '응답 대기', done: '완료', failed: '실패', stopped: '중지됨', unknown: '실행 결과 확인 필요',
}
const copy = (value: Workflow): Workflow => ({ ...value, steps: value.steps.map((step) => ({ ...step, after: [...step.after] })) })
const newStep = (after: string[] = []): WorkflowStep => ({ id: crypto.randomUUID(), name: '', agent: 'claude', prompt: '', after })
const emptyView: WorkflowView = { templates: [], runs: [] }
type DraftOrigin = 'new' | 'edit'
const workflowDrafts = new Map<string, { draft: Workflow; dirty: boolean; origin: DraftOrigin }>()
type DraftChange = { taskId: string; kind: 'new' | 'edit'; draft: Workflow } | { taskId: string; kind: 'template'; id: string }
function useWorkflowDraft(taskId: string) {
  const cached = workflowDrafts.get(taskId)
  const editor = useRef({ taskId, draft: cached?.draft ?? null as Workflow | null, dirty: cached?.dirty ?? false, origin: cached?.origin ?? 'new' as DraftOrigin })
  const [, redraw] = useState(0)
  if (editor.current.taskId !== taskId) editor.current = { taskId, draft: cached?.draft ?? null, dirty: cached?.dirty ?? false, origin: cached?.origin ?? 'new' }
  const setDraft = (next: Workflow | null | ((old: Workflow | null) => Workflow | null), dirty = true, origin = editor.current.origin) => {
    if (editor.current.taskId !== taskId) return
    const draft = typeof next === 'function' ? next(editor.current.draft) : next
    editor.current = { taskId, draft, dirty: !!draft && dirty, origin }
    if (draft) workflowDrafts.set(taskId, { draft, dirty, origin })
    else workflowDrafts.delete(taskId)
    redraw(value => value + 1)
  }
  return [editor.current.draft, setDraft, editor.current.dirty, editor.current.origin] as const
}

export function WorkflowPanel({ taskId, initialRunId, onOpenPane }: Props) {
  const [view, setView] = useState<WorkflowView>(emptyView)
  const [selected, setSelected] = useState('')
  const [draft, setDraft, dirty, origin] = useWorkflowDraft(taskId)
  const currentTask = useRef(taskId)
  currentTask.current = taskId
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [readError, setReadError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<{ kind: 'retry' | 'remove'; id: string } | null>(null)
  const [discard, setDiscard] = useState<DraftChange | null>(null)
  const lock = useRef(false)
  const reading = useRef<Promise<void> | null>(null)
  const readAgain = useRef(false)
  const version = useRef(0)
  const mounted = useRef(false)
  const generation = useRef(0)
  const requests = useRef(new Map<string, string>())
  const refresh = useRef<() => Promise<void>>(async () => {})

  useEffect(() => {
    mounted.current = true
    const current = ++generation.current
    let timer: ReturnType<typeof setTimeout> | undefined
    setView(emptyView)
    setSelected('')
    setConfirm(null)
    setDiscard(null)
    setError('')
    setReadError('')
    setLoading(true)
    const read = (): Promise<void> => {
      if (document.hidden || lock.current) { readAgain.current = true; return Promise.resolve() }
      if (reading.current) { readAgain.current = true; return reading.current }
      readAgain.current = false
      const started = version.current
      const request = window.taskminal.workflows.view().then(value => {
        if (current === generation.current && started === version.current && !lock.current) { setView(value); setReadError('') }
      }).catch((reason: unknown) => {
        if (current === generation.current && started === version.current) setReadError(reason instanceof Error ? reason.message : '작업 흐름을 읽지 못했습니다.')
      }).finally(() => {
        reading.current = null
        if (current === generation.current && started === version.current) setLoading(false)
        if (readAgain.current) { readAgain.current = false; if (mounted.current) void refresh.current() }
      })
      reading.current = request
      return request
    }
    refresh.current = read
    const poll = async () => {
      await read()
      if (current === generation.current) timer = setTimeout(() => { void poll() }, 2000)
    }
    const visible = () => { if (!document.hidden) void read() }
    document.addEventListener('visibilitychange', visible)
    void poll()
    return () => { mounted.current = false; generation.current++; clearTimeout(timer); document.removeEventListener('visibilitychange', visible) }
  }, [taskId])

  const write = async (operation: () => Promise<unknown>, after?: () => void) => {
    if (lock.current) return
    lock.current = true
    version.current++
    setBusy(true)
    setError('')
    const current = generation.current
    const source = taskId
    try {
      await operation()
      if (mounted.current && current === generation.current && currentTask.current === source) after?.()
    } catch (reason) {
      if (mounted.current && current === generation.current && currentTask.current === source) setError(reason instanceof Error ? reason.message : '요청을 처리하지 못했습니다. 다시 시도해 주세요.')
    } finally {
      version.current++; lock.current = false
      if (mounted.current) { setBusy(false); void refresh.current() }
    }
  }
  const replaceDraft = (change: DraftChange) => {
    if (change.taskId !== taskId) return
    if (change.kind === 'template') {
      if (change.id && !view.templates.some(item => item.id === change.id)) { setError('선택한 작업 흐름이 사라졌습니다. 초안을 유지했습니다.'); return }
      setSelected(change.id); setDraft(null)
    } else {
      const target = change.kind === 'edit' ? view.templates.find(item => item.id === change.draft.id) : change.draft
      if (!target) { setError('편집할 작업 흐름이 사라졌습니다. 초안을 유지했습니다.'); return }
      setDraft(copy(target), false, change.kind)
    }
  }
  const requestDraft = (change: DraftChange) => {
    if (draft && dirty) setDiscard(change)
    else replaceDraft(change)
  }
  const editStep = (id: string, change: Partial<WorkflowStep>) => setDraft((old) => old && ({ ...old, steps: old.steps.map((step) => step.id === id ? { ...step, ...change } : step) }))
  const start = () => {
    if (!view.templates.some((item) => item.id === selected)) { setError('저장된 작업 흐름을 다시 선택해 주세요.'); return }
    const key = JSON.stringify([taskId, selected])
    const requestId = requests.current.get(key) ?? crypto.randomUUID()
    requests.current.set(key, requestId)
    void write(() => window.taskminal.workflows.start({ requestId, taskId, workflowId: selected }), () => { requests.current.delete(key) })
  }
  const accept = () => {
    const target = confirm
    setConfirm(null)
    if (!target) return
    if (target.kind === 'remove') {
      if (!view.templates.some((item) => item.id === target.id)) { setError('이미 삭제된 작업 흐름입니다.'); return }
      const cached = workflowDrafts.get(taskId)
      let cleared = false
      void write(async () => {
        await window.taskminal.workflows.remove(target.id)
        if (cached?.draft.id === target.id && workflowDrafts.get(taskId) === cached) { workflowDrafts.delete(taskId); cleared = true }
      }, () => { setSelected(''); if (cleared) setDraft(null) })
    } else {
      const run = view.runs.find((item) => item.id === target.id && item.taskId === taskId)
      if (!run || !['failed', 'stopped', 'unknown'].includes(run.status)) { setError('실행 상태가 바뀌었습니다. 목록을 확인해 주세요.'); return }
      void write(() => window.taskminal.workflows.retry(target.id))
    }
  }
  const openedRun = useRef('')
  useEffect(() => {
    if (!initialRunId || openedRun.current === initialRunId) return
    const target = document.getElementById('workflow-run-' + initialRunId)
    if (target) { openedRun.current = initialRunId; target.scrollIntoView({ block: 'start' }); target.focus({ preventScroll: true }) }
  }, [initialRunId, view.runs])
  const runs = view.runs.filter((run) => run.taskId === taskId)
  return <section className="workflow-panel" aria-label="작업 흐름">
    <div className="workflow-controls">
      <label className="field"><span>저장된 작업 흐름</span><select value={selected} disabled={busy} onChange={(e) => requestDraft({ taskId, kind: 'template', id: e.target.value })}>
        <option value="">선택하세요</option>{view.templates.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
      </select></label>
      <button type="button" className="button" disabled={busy} onClick={() => requestDraft({ taskId, kind: 'new', draft: { id: crypto.randomUUID(), name: '', steps: [newStep()] } })}>새로 만들기</button>
      <button type="button" className="button" disabled={busy || !view.templates.some((item) => item.id === selected)} onClick={() => { const item = view.templates.find((item) => item.id === selected); if (item) requestDraft({ taskId, kind: 'edit', draft: copy(item) }) }}>편집</button>
      <button type="button" className="button danger" disabled={busy || !view.templates.some((item) => item.id === selected)} onClick={() => setConfirm({ kind: 'remove', id: selected })}>삭제</button>
      <button type="button" className="button primary" disabled={busy || !view.templates.some((item) => item.id === selected)} onClick={start}>저장된 흐름 실행</button>
    </div>
    {draft && <div className="workflow-meta">작성 중인 초안은 메모리에만 보존합니다. 패널을 닫거나 일감을 바꿔도 남지만, 앱 종료·화면 새로고침 시 사라집니다. 저장 전에는 실행에 사용하지 않습니다.</div>}
    {draft && <form className="workflow-editor" onSubmit={(e) => {
      e.preventDefault()
      const snapshot = copy(draft)
      const source = taskId, current = generation.current
      const cached = workflowDrafts.get(source)
      void write(async () => {
        if (origin === 'edit') {
          const latest = await window.taskminal.workflows.view()
          if (!mounted.current || current !== generation.current || currentTask.current !== source) return
          if (!latest.templates.some(item => item.id === snapshot.id)) throw new Error('편집하던 작업 흐름이 삭제되었습니다. 초안을 유지했습니다. 새로 만들기로 별도 흐름을 작성해 주세요.')
        }
        if (!mounted.current || current !== generation.current || currentTask.current !== source) return
        await window.taskminal.workflows.save(snapshot)
        if (workflowDrafts.get(source) === cached) workflowDrafts.delete(source)
      }, () => { setSelected(snapshot.id); setDraft(null) })
    }}>
      <fieldset disabled={busy}>
        <legend>작업 흐름 편집</legend>
        <label className="field"><span>흐름 이름</span><input required maxLength={100} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
        {draft.steps.map((step, index) => <fieldset className="workflow-step" key={step.id}>
          <legend>{index + 1}단계</legend>
          <label className="field"><span>단계 이름</span><input required maxLength={100} value={step.name} onChange={(e) => editStep(step.id, { name: e.target.value })} /></label>
          <label className="field"><span>에이전트</span><select value={step.agent} onChange={(e) => editStep(step.id, { agent: e.target.value === 'codex' ? 'codex' : 'claude' })}><option value="claude">Claude</option><option value="codex">Codex</option></select></label>
          <label className="field"><span>보낼 지시</span><textarea required rows={3} maxLength={10000} value={step.prompt} onChange={(e) => editStep(step.id, { prompt: e.target.value })} /></label>
          <fieldset className="workflow-dependencies"><legend>이 단계들이 완료된 뒤 시작</legend>
            {draft.steps.filter((other) => other.id !== step.id).map((other) => <label key={other.id}><input type="checkbox" checked={step.after.includes(other.id)} onChange={(e) => editStep(step.id, { after: e.target.checked ? [...step.after, other.id] : step.after.filter((id) => id !== other.id) })} />{other.name || `${draft.steps.indexOf(other) + 1}단계`}</label>)}
            <div className="workflow-meta">선택하지 않으면 바로 시작합니다.</div>
          </fieldset>
          <button type="button" className="button" disabled={draft.steps.length === 1} onClick={() => setDraft({ ...draft, steps: draft.steps.filter((item) => item.id !== step.id).map((item) => ({ ...item, after: item.after.filter((id) => id !== step.id) })) })}>단계 삭제</button>
        </fieldset>)}
        <div className="workflow-controls"><button type="button" className="button" disabled={draft.steps.length >= 10} onClick={() => setDraft({ ...draft, steps: [...draft.steps, newStep(draft.steps.length ? [draft.steps[draft.steps.length - 1]!.id] : [])] })}>단계 추가 ({draft.steps.length}/10)</button><button type="submit" className="button primary">저장</button><button type="button" className="button" onClick={() => setDraft(null)}>편집 취소</button></div>
      </fieldset>
    </form>}
    {error && <div role="alert" className="workflow-error">{error}</div>}
    {readError && <div role="alert" className="workflow-error">{readError} <button type="button" className="button" onClick={() => { void refresh.current() }}>다시 읽기</button></div>}
    <div role="status" className="workflow-meta">{busy ? '요청 처리 중…' : loading ? '불러오는 중…' : !runs.length && !readError ? '아직 실행한 작업 흐름이 없습니다.' : ''}</div>
    <div className="workflow-runs">{runs.map((run) => <article className="workflow-run" id={"workflow-run-"+run.id} tabIndex={-1} key={run.id} aria-label={`${run.workflow.name} 실행`}>
      <h3>{run.workflow.name}</h3><div className="workflow-meta">{new Date(run.createdAt).toLocaleString()} · {labels[run.status]}</div>
      {run.error && <div className="workflow-error">{run.error}</div>}
      <ol>{run.steps.map((step) => <li key={step.id}>
        <div>{run.workflow.steps.find((item) => item.id === step.id)?.name || '단계'} · {labels[step.status]} · 시도 {step.attempt}</div>
        {step.result && <pre className="workflow-result">{step.result}</pre>}
        {step.paneId && <button type="button" className="button" disabled={step.status === 'pending'} onClick={() => onOpenPane(step.paneId)}>대화 열기</button>}
      </li>)}</ol>
      {['preparing', 'running', 'waiting'].includes(run.status) && <button type="button" className="button" disabled={busy} onClick={() => { void write(() => window.taskminal.workflows.stop(run.id)) }}>실행 중지</button>}
      {['failed', 'stopped', 'unknown'].includes(run.status) && <button type="button" className="button" disabled={busy} onClick={() => setConfirm({ kind: 'retry', id: run.id })}>이어 실행…</button>}
    </article>)}</div>
    {confirm && <ConfirmDialog title={confirm.kind === 'remove' ? '작업 흐름 삭제' : '남은 단계 이어 실행'} message={confirm.kind === 'remove' ? '저장된 작업 흐름을 삭제합니다. 기존 실행 기록은 남습니다.' : '완료된 단계는 다시 실행하지 않습니다. 결과를 알 수 없는 단계는 이전 지시가 이미 전달되었을 수 있습니다. 이어 실행하면 같은 지시가 다시 전달될 수 있습니다.'} confirmLabel={confirm.kind === 'remove' ? '삭제' : '이어 실행'} onConfirm={accept} onCancel={() => setConfirm(null)} />}
    {discard && <ConfirmDialog title="작성 중인 초안 버리기" message="저장하지 않은 초안을 버리고 선택한 편집 화면으로 이동합니다." confirmLabel="초안 버리기" onConfirm={() => { const target = discard; setDiscard(null); replaceDraft(target) }} onCancel={() => setDiscard(null)} />}
  </section>
}
