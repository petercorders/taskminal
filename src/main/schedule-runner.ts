import { localClock, nextOccurrence, validScheduleSpec, validScheduleView, type Schedule, type ScheduleEntry, type ScheduleSpec, type ScheduleStatus, type ScheduleView } from '../shared/schedules'

interface Journal { load(fallback: ScheduleView): ScheduleView; save(value: ScheduleView): void }
interface WorkflowSnapshot { templates: Array<{ id: string }>; runs: Array<{ id: string; requestId: string; taskId: string; workflow: { id: string }; status: string }> }
export interface ScheduleDeps {
  redact?(text: string): string
  id(): string
  now(): number
  validTask(taskId: string): boolean
  workflowView(): WorkflowSnapshot
  start(input: { requestId: string; taskId: string; workflowId: string }): string | Promise<string>
}
const active = (status: string) => ['preparing', 'running', 'waiting'].includes(status)
const terminal = (status: string) => ['done', 'failed', 'stopped', 'unknown'].includes(status)

/** No timers or Electron resources: the owner calls tick; construction never starts workflows. */
export class ScheduleRunner {
  private data: ScheduleView = { schedules: [], requests: [] }
  private failure = ''
  private busy = false
  private resumePending = false
  constructor(private readonly store: Journal, private readonly deps: ScheduleDeps) {
    try {
      this.data = structuredClone(store.load(this.data))
      if (!validScheduleView(this.data)) throw new Error('예약 기록 형식이 올바르지 않습니다.')
      const copy = structuredClone(this.data)
      for (const schedule of copy.schedules) {
        this.reconcileEntries(schedule)
        if (schedule.enabled && schedule.nextAt! <= deps.now()) this.miss(schedule, deps.now(), '앱이 꺼져 있는 동안 예약을 놓쳤습니다.')
      }
      if (JSON.stringify(copy) !== JSON.stringify(this.data)) this.commit(copy)
    } catch (reason) { this.failure = reason instanceof Error ? reason.message : '예약 기록을 읽지 못했습니다.' }
  }
  private ready() { if (this.failure) throw new Error(this.failure) }
  private commit(value: ScheduleView) {
    this.ready()
    try {
      if (!validScheduleView(value)) throw new Error('예약 기록 형식이 올바르지 않습니다.')
      value = this.mask(value)
      this.store.save(structuredClone(value))
      this.data = value
    } catch (reason) {
      this.failure = reason instanceof Error ? reason.message : '예약 기록을 저장하지 못했습니다.'
      throw new Error(this.failure)
    }
  }
  private mask(value: ScheduleView): ScheduleView {
    const copy = structuredClone(value)
    for (const s of copy.schedules) { s.name = (this.deps.redact?.(s.name) ?? s.name).slice(0, 100); for (const e of s.history) if (e.reason) e.reason = (this.deps.redact?.(e.reason) ?? e.reason).slice(0, 2000) }
    return copy
  }
  view(): ScheduleView { this.ready(); return this.mask(this.data) }
  save(spec: ScheduleSpec) {
    this.ready()
    if (this.busy) throw new Error('실행 요청을 처리 중입니다.')
    if (!validScheduleSpec(spec)) throw new Error('예약 이름·간격·시각·시간대를 확인해 주세요.')
    const copy = this.view()
    const old = copy.schedules.find(s => s.id === spec.id)
    if (!old && copy.schedules.length >= 50) throw new Error('예약은 50개까지 저장할 수 있습니다.')
    const schedule: Schedule = { ...structuredClone(spec), enabled: spec.enabled ?? false, nextAt: null, history: old?.history ?? [], ...(old?.lastLocalDate ? { lastLocalDate: old.lastLocalDate } : {}) }
    if (schedule.enabled) schedule.nextAt = nextOccurrence(schedule.timing, this.deps.now(), schedule.lastLocalDate)
    copy.schedules = copy.schedules.filter(s => s.id !== schedule.id).concat(schedule)
    this.commit(copy)
  }
  remove(id: string) {
    this.ready()
    if (this.busy) throw new Error('실행 요청을 처리 중입니다.')
    const copy = this.view(); copy.schedules = copy.schedules.filter(s => s.id !== id); this.commit(copy)
  }
  private append(schedule: Schedule, entry: ScheduleEntry) { schedule.history.push(entry); schedule.history = schedule.history.slice(-100) }
  private advance(schedule: Schedule, due: number, now: number) {
    if (schedule.timing.kind === 'daily') {
      const date = localClock(due, schedule.timing.timeZone).date
      if (!schedule.lastLocalDate || date > schedule.lastLocalDate) schedule.lastLocalDate = date
    }
    schedule.nextAt = schedule.enabled ? nextOccurrence(schedule.timing, now, schedule.lastLocalDate) : null
  }
  private miss(schedule: Schedule, now: number, reason: string) {
    const due = schedule.nextAt!
    this.append(schedule, { id: this.deps.id(), requestId: this.deps.id(), taskId: schedule.taskId, workflowId: schedule.workflowId, at: now, dueAt: due, status: 'missed', reason })
    this.advance(schedule, due, now)
  }
  private reconcileEntries(schedule: Schedule) {
    const runs = this.deps.workflowView().runs
    for (const entry of schedule.history) {
      if (entry.status !== 'claimed' && !active(entry.status) && entry.status !== 'unknown') continue
      const run = runs.find(r => r.requestId === entry.requestId && r.taskId === entry.taskId && r.workflow.id === entry.workflowId)
      if (run && (active(run.status) || terminal(run.status))) { entry.status = run.status as ScheduleStatus; entry.runId = run.id }
      else if (entry.status === 'claimed' || active(entry.status)) { entry.status = 'unknown'; entry.reason = '실행 결과를 확인하지 못했습니다. 자동으로 다시 보내지 않습니다.' }
    }
  }
  reconcile() {
    this.ready()
    if (this.busy) return
    const copy = this.view()
    for (const schedule of copy.schedules) this.reconcileEntries(schedule)
    if (JSON.stringify(copy) !== JSON.stringify(this.data)) this.commit(copy)
  }
  resume() {
    this.ready()
    if (this.busy) { this.resumePending = true; return }
    this.resumePending = false
    const copy = this.view()
    for (const schedule of copy.schedules) {
      this.reconcileEntries(schedule)
      if (schedule.enabled && schedule.nextAt! <= this.deps.now()) this.miss(schedule, this.deps.now(), '절전 중 예약을 놓쳤습니다.')
    }
    if (JSON.stringify(copy) !== JSON.stringify(this.data)) this.commit(copy)
  }
  async tick() {
    this.ready()
    if (this.busy) return
    this.busy = true
    try {
      for (const id of this.data.schedules.map(s => s.id)) {
        const schedule = this.data.schedules.find(s => s.id === id)!
        if (!schedule.enabled || schedule.nextAt! > this.deps.now()) continue
        if (this.deps.now() - schedule.nextAt! > 90000) {
          const copy = this.view(); this.miss(copy.schedules.find(s => s.id === id)!, this.deps.now(), '절전 또는 지연으로 예약을 놓쳤습니다.'); this.commit(copy)
        } else await this.execute(id, this.deps.id(), schedule.nextAt!, true)
      }
    } finally { this.busy = false; if (this.resumePending && !this.failure) this.resume() }
  }
  async runNow(id: string, requestId: string): Promise<ScheduleEntry> {
    this.ready()
    if (!/^[\w-]{1,100}$/.test(requestId)) throw new Error('실행 요청 번호를 확인해 주세요.')
    const existing = this.data.requests.find(r => r.requestId === requestId)
    if (existing) {
      if (existing.scheduleId !== id) throw new Error('다른 예약의 요청 번호입니다.')
      const entry = this.data.schedules.find(s => s.id === id)?.history.find(h => h.id === existing.entryId)
      return entry ? structuredClone(entry) : { id: existing.entryId, requestId, taskId: this.data.schedules.find(s => s.id === id)?.taskId ?? "deleted", workflowId: this.data.schedules.find(s => s.id === id)?.workflowId ?? "deleted", at: 0, dueAt: 0, status: 'unknown', reason: '이미 처리한 요청입니다. 상세 이력 보존 범위를 지났으며 다시 실행하지 않습니다.' }
    }
    if (this.busy) throw new Error('실행 요청을 처리 중입니다.')
    this.busy = true
    try { return await this.execute(id, requestId, this.deps.now(), false) }
    finally { this.busy = false; if (this.resumePending && !this.failure) this.resume() }
  }
  private async execute(id: string, requestId: string, dueAt: number, scheduled: boolean): Promise<ScheduleEntry> {
    const copy = this.view()
    const schedule = copy.schedules.find(s => s.id === id)
    if (!schedule) throw new Error('예약이 사라졌습니다.')
    if (copy.requests.length >= 10000) throw new Error('예약 요청 기록 10000개 한도에 도달해 새 실행을 중지했습니다. 기존 기록은 자동 삭제하지 않습니다.')
    if (copy.requests.some(r => r.requestId === requestId)) throw new Error('이미 처리한 실행 요청 번호입니다.')
    const entry: ScheduleEntry = { id: this.deps.id(), requestId, taskId: schedule.taskId, workflowId: schedule.workflowId, at: this.deps.now(), dueAt, status: 'claimed' }
    copy.requests.push({ requestId, scheduleId: id, entryId: entry.id })
    this.append(schedule, entry)
    if (scheduled) this.advance(schedule, dueAt, this.deps.now())
    this.commit(copy) // A failure here MUST prevent any workflow start.
    const finish = (status: ScheduleStatus, reason?: string, runId?: string) => {
      const updated = this.view()
      const result = updated.schedules.find(s => s.id === id)!.history.find(h => h.id === entry.id)!
      Object.assign(result, { status, ...(reason ? { reason: reason.slice(0, 2000) } : {}), ...(runId ? { runId } : {}) })
      this.commit(updated)
      return structuredClone(result)
    }
    const workflows = this.deps.workflowView()
    if (!this.deps.validTask(schedule.taskId)) return finish('skipped', '일감이 닫혔거나 보관·삭제·원격으로 변경되었습니다.')
    if (!workflows.templates.some(w => w.id === schedule.workflowId)) return finish('skipped', '작업 흐름이 삭제되었습니다.')
    if (workflows.runs.some(r => r.taskId === schedule.taskId && active(r.status))) return finish('skipped', '이 일감의 이전 실행이 진행 중입니다.')
    let runId: string
    try {
      runId = await this.deps.start({ requestId, taskId: schedule.taskId, workflowId: schedule.workflowId })
    } catch {
      const found = this.deps.workflowView().runs.find(r => r.requestId === requestId && r.taskId === schedule.taskId && r.workflow.id === schedule.workflowId)
      return found ? finish(found.status as ScheduleStatus, undefined, found.id) : finish('skipped', '작업 흐름 실행기가 요청을 거절했습니다. 자동 재전송하지 않습니다.')
    }
    const run = this.deps.workflowView().runs.find(r => r.id === runId && r.requestId === requestId)
    return finish(run ? run.status as ScheduleStatus : 'unknown', run ? undefined : '실행 결과를 아직 확인하지 못했습니다.', runId)
  }
}

/** Power event ordering: overdue interval callbacks must stay blocked until resume has skipped missed slots. */
export class ScheduleLoop {
  private sleeping = false
  private failed = false
  constructor(private readonly runner: Pick<ScheduleRunner,'tick'|'reconcile'|'resume'>, private readonly available: () => boolean, private readonly failure: (reason: unknown) => void) {}
  suspend() { this.sleeping = true }
  private fail(reason: unknown) { this.failed = true; this.failure(reason) }
  resume() {
    if (this.failed) return
    try { this.runner.resume(); this.sleeping = false } catch (reason) { this.fail(reason) }
  }
  async tick() {
    if (this.failed || this.sleeping || !this.available()) return
    try { this.runner.reconcile(); await this.runner.tick() } catch (reason) { this.fail(reason) }
  }
}
