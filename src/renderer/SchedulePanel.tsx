import { useEffect, useRef, useState } from 'react'
import type { Schedule, ScheduleEntry, ScheduleSpec, ScheduleStatus, ScheduleView } from '../shared/schedules'
import { ConfirmDialog } from './ConfirmDialog'
import './schedule-panel.css'

interface Props { taskId: string; onOpenRun(runId: string): void }
interface Template { id: string; name: string }
const names: Record<ScheduleStatus, string> = { claimed: '실행 준비', preparing: '준비 중', running: '진행 중', waiting: '응답 대기', done: '완료', failed: '실패', stopped: '중지됨', unknown: '실행 결과 확인 필요', missed: '놓침', skipped: '건너뜀' }
const date = (at: number) => new Date(at).toLocaleString()
const message = (reason: unknown, fallback: string) => reason instanceof Error ? reason.message : fallback
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
const description = (schedule: Schedule) => schedule.timing.kind === 'interval' ? `${schedule.timing.minutes}분 간격` : `매일 ${schedule.timing.time} · ${schedule.timing.timeZone}`
// Keep uncertain manual requests when the tool panel is closed and reopened in this renderer.
const pendingRunRequests = new Map<string, string>()

export function SchedulePanel({ taskId, onOpenRun }: Props) {
  const [view, setView] = useState<ScheduleView>({ schedules: [], requests: [] })
  const [templates, setTemplates] = useState<Template[]>([])
  const [draft, setDraft] = useState<ScheduleSpec | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [readError, setReadError] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null)
  const lifecycle = useRef(0)
  const mounted = useRef(false)
  const version = useRef(0)
  const lock = useRef(false)
  const reading = useRef<Promise<void> | null>(null)
  const readAgain = useRef(false)
  const refresh = useRef<() => Promise<void>>(async () => {})
  const requests = useRef(pendingRunRequests)

  useEffect(() => {
    mounted.current = true
    const current = ++lifecycle.current
    let timer: ReturnType<typeof setTimeout> | undefined
    setView({ schedules: [], requests: [] }); setTemplates([]); setDraft(null); setDeleting(null)
    setLoading(true); setReadError(''); setError(''); setNotice('')
    const read = (): Promise<void> => {
      if (document.hidden || lock.current) { readAgain.current = true; return Promise.resolve() }
      if (reading.current) { readAgain.current = true; return reading.current }
      readAgain.current = false
      const started = version.current
      const request = Promise.all([window.taskminal.schedules.view(), window.taskminal.workflows.view()])
        .then(([schedules, workflows]) => {
          if (lifecycle.current === current && started === version.current && !lock.current) {
            setView(schedules); setTemplates(workflows.templates); setReadError('')
          }
        })
        .catch((reason: unknown) => {
          if (lifecycle.current === current && started === version.current) setReadError(message(reason, '예약을 읽지 못했습니다.'))
        })
        .finally(() => {
          reading.current = null
          if (lifecycle.current === current && started === version.current) setLoading(false)
          if (readAgain.current) { readAgain.current = false; if (mounted.current) void refresh.current() }
        })
      reading.current = request
      return request
    }
    refresh.current = read
    const poll = async () => {
      await read()
      if (lifecycle.current === current) timer = setTimeout(() => { void poll() }, 2000)
    }
    const visible = () => { if (!document.hidden) void read() }
    document.addEventListener('visibilitychange', visible)
    void poll()
    return () => { mounted.current = false; lifecycle.current++; clearTimeout(timer); document.removeEventListener('visibilitychange', visible) }
  }, [taskId])

  const write = async (operation: () => Promise<unknown>, after?: (value: unknown) => void) => {
    if (lock.current) return
    lock.current = true; version.current++; setBusy(true); setError(''); setNotice('')
    const current = lifecycle.current
    try {
      const value = await operation()
      if (current === lifecycle.current) after?.(value)
    } catch (reason) {
      if (current === lifecycle.current) setError(message(reason, '요청을 처리하지 못했습니다.'))
    } finally {
      version.current++; lock.current = false
      if (mounted.current) { setBusy(false); void refresh.current() }
    }
  }
  const newSchedule = () => {
    setError(''); setNotice('')
    setDraft({ id: crypto.randomUUID(), taskId, name: '', workflowId: templates[0]?.id ?? '', enabled: false, timing: { kind: 'interval', minutes: 60 } })
  }
  const run = (schedule: Schedule) => {
    if (lock.current) return
    const key = JSON.stringify([taskId, schedule.id])
    if (!requests.current.has(key) && requests.current.size >= 10000) { setError('응답을 확인하지 못한 실행 요청이 너무 많습니다. 기존 실행 결과를 확인해 주세요.'); return }
    const requestId = requests.current.get(key) ?? crypto.randomUUID()
    requests.current.set(key, requestId)
    void write(async () => {
      const reply = await window.taskminal.schedules.runNow(schedule.id, requestId)
      requests.current.delete(key)
      return reply
    }, (value) => {
      const entry = value as ScheduleEntry | undefined
      setNotice(entry?.status ? `지금 실행: ${names[entry.status]}${entry.reason ? ` · ${entry.reason}` : ''}` : '실행 요청을 처리했습니다. 이력에서 결과를 확인하세요.')
    })
  }
  const remove = () => {
    const target = deleting
    setDeleting(null)
    if (!target) return
    if (!view.schedules.some(s => s.id === target.id && s.taskId === taskId)) { setError('예약이 이미 삭제되었습니다.'); return }
    void write(() => window.taskminal.schedules.remove(target.id), () => { if (draft?.id === target.id) setDraft(null); setNotice('예약을 삭제했습니다.') })
  }
  const schedules = view.schedules.filter(schedule => schedule.taskId === taskId)
  return <section className="schedule-panel" aria-label="예약과 결과함">
    <div className="schedule-intro">앱이 실행 중일 때만 예약을 실행합니다. 앱 종료·절전 동안 놓친 예약은 나중에 몰아서 실행하지 않습니다.</div>
    <div><button type="button" className="button" disabled={busy} onClick={newSchedule}>새 예약</button></div>
    {draft && <form className="schedule-editor" onSubmit={(event) => {
      event.preventDefault()
      const snapshot = structuredClone(draft)
      void write(() => window.taskminal.schedules.save(snapshot), () => { setDraft(null); setNotice(snapshot.enabled ? '예약을 저장하고 활성화했습니다. 다음 미래 시각부터 실행합니다.' : '예약을 일시정지 상태로 저장했습니다.') })
    }}><fieldset disabled={busy}>
      <legend>{view.schedules.some(schedule => schedule.id === draft.id) ? '예약 편집' : '새 예약'}</legend>
      <label className="field"><span>예약 이름</span><input required maxLength={100} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
      <label className="field"><span>작업 흐름</span><select required value={draft.workflowId} onChange={e => setDraft({ ...draft, workflowId: e.target.value })}>
        <option value="">선택하세요</option>{templates.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}
        {draft.workflowId && !templates.some(template => template.id === draft.workflowId) && <option value={draft.workflowId} disabled>삭제된 작업 흐름</option>}
      </select></label>
      {!templates.length && <div className="schedule-meta">작업 흐름 화면에서 먼저 템플릿을 저장하세요.</div>}
      <label className="field"><span>반복 방식</span><select value={draft.timing.kind} onChange={e => setDraft({ ...draft, timing: e.target.value === 'daily' ? { kind: 'daily', time: '09:00', timeZone: zone() } : { kind: 'interval', minutes: 60 } })}><option value="interval">분 간격</option><option value="daily">매일 지정 시각</option></select></label>
      {draft.timing.kind === 'interval' ? <label className="field"><span>간격 (5~10080분)</span><input required type="number" min={5} max={10080} step={1} value={Number.isNaN(draft.timing.minutes) ? '' : draft.timing.minutes} onChange={e => setDraft({ ...draft, timing: { kind: 'interval', minutes: e.target.valueAsNumber } })} /></label> : <>
        <label className="field"><span>현지 시각</span><input required type="time" value={draft.timing.time} onChange={e => { if (draft.timing.kind === 'daily') setDraft({ ...draft, timing: { ...draft.timing, time: e.target.value } }) }} /></label>
        <label className="field"><span>시간대 (예: Asia/Seoul)</span><input required maxLength={100} value={draft.timing.timeZone} onChange={e => { if (draft.timing.kind === 'daily') setDraft({ ...draft, timing: { ...draft.timing, timeZone: e.target.value } }) }} /></label>
        <div className="schedule-meta">서머타임으로 없는 시각은 그날 건너뛰며, 같은 날짜의 반복 시각은 한 번만 실행합니다.</div>
      </>}
      <label className="schedule-check"><input type="checkbox" checked={draft.enabled ?? false} onChange={e => setDraft({ ...draft, enabled: e.target.checked })} />저장 후 예약 활성화</label>
      <div className="schedule-meta">체크를 끄고 저장하면 일시정지합니다. 저장은 지금 실행 중인 작업을 멈추지 않습니다.</div>
      <div className="schedule-actions"><button type="submit" className="button primary" disabled={!templates.some(template => template.id === draft.workflowId)}>저장</button><button type="button" className="button" onClick={() => setDraft(null)}>편집 취소</button></div>
    </fieldset></form>}
    {view.warning && <div role="alert" className="schedule-error">{view.warning}</div>}
    {error && <div role="alert" className="schedule-error">{error} 입력을 유지했습니다. 같은 버튼으로 다시 시도할 수 있습니다.</div>}
    {readError && <div role="alert" className="schedule-error">{readError} <button type="button" className="button" onClick={() => { void refresh.current() }}>다시 읽기</button></div>}
    <div role="status" className="schedule-meta">{busy ? '요청 처리 중…' : loading ? '불러오는 중…' : notice || (!schedules.length && !readError ? '아직 저장한 예약이 없습니다.' : '')}</div>
    <div className="schedule-list">{schedules.map(schedule => <article className="schedule-card" key={schedule.id} aria-label={schedule.name}>
      <h3>{schedule.name}</h3><div className="schedule-meta">{schedule.enabled ? '활성' : '일시정지'} · {description(schedule)}</div>
      <div className="schedule-meta">작업 흐름: {templates.find(template => template.id === schedule.workflowId)?.name ?? '삭제된 작업 흐름'}</div>
      <div>다음 실행: {schedule.enabled && schedule.nextAt !== null ? date(schedule.nextAt) : '예약 없음'} <span className="schedule-meta">(이 기기 시각)</span></div>
      <div className="schedule-actions">
        <button type="button" className="button" disabled={busy} onClick={() => { setDraft({ id: schedule.id, name: schedule.name, taskId, workflowId: schedule.workflowId, timing: structuredClone(schedule.timing), enabled: schedule.enabled }); setError('') }}>편집</button>
        <button type="button" className="button" disabled={busy} onClick={() => { const snapshot: ScheduleSpec = { id: schedule.id, name: schedule.name, taskId, workflowId: schedule.workflowId, timing: structuredClone(schedule.timing), enabled: !schedule.enabled }; void write(() => window.taskminal.schedules.save(snapshot), () => setNotice(snapshot.enabled ? '다음 미래 시각부터 예약을 실행합니다.' : '예약을 일시정지했습니다. 진행 중인 실행은 계속됩니다.')) }}>{schedule.enabled ? '일시정지' : '활성화'}</button>
        <button type="button" className="button" disabled={busy} onClick={() => run(schedule)}>지금 실행</button>
        <button type="button" className="button danger" disabled={busy} onClick={() => setDeleting({ id: schedule.id, name: schedule.name })}>삭제…</button>
      </div>
      <details><summary>실행 이력 ({schedule.history.length})</summary>
        {!schedule.history.length && <div className="schedule-meta">아직 실행 이력이 없습니다.</div>}
        <ol className="schedule-history">{[...schedule.history].reverse().map(entry => <li key={entry.id}>
          <div>{names[entry.status]} · {date(entry.at)}</div><div className="schedule-meta">예정 시각: {date(entry.dueAt)}</div>
          {entry.reason && <div className="schedule-reason">{entry.reason}</div>}
          {entry.runId && <button type="button" className="button" onClick={() => { try { onOpenRun(entry.runId!) } catch (reason) { setError(message(reason, '실행 기록을 열지 못했습니다.')) } }}>실행 결과 열기</button>}
        </li>)}</ol>
      </details>
    </article>)}</div>
    {deleting && <ConfirmDialog title="예약 삭제" message={`‘${deleting.name}’ 예약과 이 화면의 이력을 삭제합니다. 진행 중인 작업 흐름은 계속되며 작업 흐름 화면에서 확인할 수 있습니다.`} confirmLabel="삭제" onConfirm={remove} onCancel={() => setDeleting(null)} />}
  </section>
}
