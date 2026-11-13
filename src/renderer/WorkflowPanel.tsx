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

export function WorkflowPanel({ taskId, initialRunId, onOpenPane }: Props) {
  const [view, setView] = useState<WorkflowView>(emptyView)
  const [selected, setSelected] = useState('')
  const [draft, setDraft] = useState<Workflow | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [readError, setReadError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<{ kind: 'retry' | 'remove'; id: string } | null>(null)
  const lock = useRef(false)
  const reading = useRef(false)
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
    setDraft(null)
    setConfirm(null)
    setError('')
    setReadError('')
    setLoading(true)
    const read = async () => {
      if (reading.current || document.hidden) return
      reading.current = true
      try {
        const value = await window.taskminal.workflows.view()
        if (current === generation.current) { setView(value); setReadError('') }
      } catch (reason) {
        if (current === generation.current) setReadError(reason instanceof Error ? reason.message : '작업 흐름을 읽지 못했습니다.')
      } finally {
        reading.current = false
        if (current === generation.current) setLoading(false)
      }
    }
    refresh.current = read
    const poll = async () => {
      await read()
      if (current === generation.current) timer = setTimeout(() => { void poll() }, 2000)
    }
    void poll()
    return () => { mounted.current = false; generation.current++; clearTimeout(timer) }
  }, [taskId])

  const write = async (operation: () => Promise<unknown>, after?: () => void) => {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError('')
    const current = generation.current
    try {
      await operation()
      if (current === generation.current) { after?.(); await refresh.current() }
    } catch (reason) {
      if (current === generation.current) setError(reason instanceof Error ? reason.message : '요청을 처리하지 못했습니다. 다시 시도해 주세요.')
    } finally {
      lock.current = false
      if (mounted.current) setBusy(false)
    }
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
      void write(() => window.taskminal.workflows.remove(target.id), () => { setSelected(''); setDraft(null) })
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
    <h2>작업 흐름</h2>
    <div className="workflow-controls">
      <label className="field"><span>저장된 작업 흐름</span><select value={selected} disabled={busy} onChange={(e) => { setSelected(e.target.value); setDraft(null) }}>
        <option value="">선택하세요</option>{view.templates.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
      </select></label>
      <button type="button" className="button" disabled={busy} onClick={() => setDraft({ id: crypto.randomUUID(), name: '', steps: [newStep()] })}>새로 만들기</button>
      <button type="button" className="button" disabled={busy || !view.templates.some((item) => item.id === selected)} onClick={() => { const item = view.templates.find((item) => item.id === selected); if (item) setDraft(copy(item)) }}>편집</button>
      <button type="button" className="button danger" disabled={busy || !view.templates.some((item) => item.id === selected)} onClick={() => setConfirm({ kind: 'remove', id: selected })}>삭제</button>
      <button type="button" className="button primary" disabled={busy || !view.templates.some((item) => item.id === selected)} onClick={start}>저장된 흐름 실행</button>
    </div>
    {draft && <form className="workflow-editor" onSubmit={(e) => {
      e.preventDefault()
      const snapshot = copy(draft)
      void write(() => window.taskminal.workflows.save(snapshot), () => { setSelected(snapshot.id); setDraft(null) })
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
        {step.paneId && <button type="button" className="button" onClick={() => onOpenPane(step.paneId)}>대화 열기</button>}
      </li>)}</ol>
      {['preparing', 'running', 'waiting'].includes(run.status) && <button type="button" className="button" disabled={busy} onClick={() => { void write(() => window.taskminal.workflows.stop(run.id)) }}>실행 중지</button>}
      {['failed', 'stopped', 'unknown'].includes(run.status) && <button type="button" className="button" disabled={busy} onClick={() => setConfirm({ kind: 'retry', id: run.id })}>이어 실행…</button>}
    </article>)}</div>
    {confirm && <ConfirmDialog title={confirm.kind === 'remove' ? '작업 흐름 삭제' : '남은 단계 이어 실행'} message={confirm.kind === 'remove' ? '저장된 작업 흐름을 삭제합니다. 기존 실행 기록은 남습니다.' : '완료된 단계는 다시 실행하지 않습니다. 결과를 알 수 없는 단계는 이전 지시가 이미 전달되었을 수 있습니다. 이어 실행하면 같은 지시가 다시 전달될 수 있습니다.'} confirmLabel={confirm.kind === 'remove' ? '삭제' : '이어 실행'} onConfirm={accept} onCancel={() => setConfirm(null)} />}
  </section>
}
