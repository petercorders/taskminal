import { describe, expect, it, vi } from 'vitest'
import { ScheduleLoop, ScheduleRunner, type ScheduleDeps } from '../../src/main/schedule-runner'
import { nextOccurrence, validScheduleView, validTiming, type ScheduleSpec, type ScheduleView } from '../../src/shared/schedules'

function fixture(initial?: ScheduleView) {
  let time = Date.parse('2026-01-01T00:00:00Z')
  let disk: ScheduleView = initial ?? { schedules: [], requests: [] }
  let fail = false
  let sequence = 0
  const runs: Array<{ id: string; requestId: string; taskId: string; workflow: { id: string }; status: string }> = []
  const save = vi.fn((value: ScheduleView) => { if (fail) throw new Error('disk'); disk = structuredClone(value) })
  const start = vi.fn((input: { requestId: string; taskId: string; workflowId: string }) => {
    expect(disk.schedules.some(s => s.history.some(h => h.requestId === input.requestId && h.status === 'claimed'))).toBe(true)
    const run = { id: `run-${runs.length}`, requestId: input.requestId, taskId: input.taskId, workflow: { id: input.workflowId }, status: 'running' }
    runs.push(run)
    return run.id
  })
  const deps: ScheduleDeps = { id: () => `id-${++sequence}`, now: () => time, validTask: () => true, workflowView: () => ({ templates: [{ id: 'workflow' }], runs }), start }
  const store = { load: () => structuredClone(disk), save }
  const runner = new ScheduleRunner(store, deps)
  const spec: ScheduleSpec = { id: 'schedule', name: '점검', taskId: 'task', workflowId: 'workflow', timing: { kind: 'interval', minutes: 5 } }
  return { runner, deps, store, spec, start, save, runs, clock: (value: number) => { time = value }, fail: () => { fail = true }, disk: () => disk }
}

describe('schedule execution claims', () => {
  it('defaults disabled; saving/enabling never executes; claims durably before start; duplicate ticks do not overlap', async () => {
    const f = fixture()
    f.runner.save(f.spec)
    expect(f.runner.view().schedules[0]!.enabled).toBe(false)
    f.runner.save({ ...f.spec, enabled: true })
    expect(f.start).not.toHaveBeenCalled()
    f.clock(Date.parse('2026-01-01T00:05:00Z'))
    await Promise.all([f.runner.tick(), f.runner.tick()])
    expect(f.start).toHaveBeenCalledTimes(1)
    expect(f.runner.view().schedules[0]!.history[0]!.status).toBe('running')
  })
  it('deduplicates explicit manual request IDs even when paused', async () => {
    const f = fixture(); f.runner.save(f.spec)
    await f.runner.runNow('schedule', 'manual-request')
    await f.runner.runNow('schedule', 'manual-request')
    expect(f.start).toHaveBeenCalledTimes(1)
  })
  it('marks sleep lag and startup overdue missed without catchup', async () => {
    const f = fixture(); f.runner.save({ ...f.spec, enabled: true })
    f.clock(Date.parse('2026-01-01T00:10:00Z')); await f.runner.tick()
    expect(f.start).not.toHaveBeenCalled()
    expect(f.runner.view().schedules[0]!.history[0]!.status).toBe('missed')
    const restarted = new ScheduleRunner(f.store, { ...f.deps, now: () => Date.parse('2026-01-02T00:00:00Z') })
    expect(restarted.view().schedules[0]!.nextAt).toBeGreaterThan(Date.parse('2026-01-02T00:00:00Z'))
    expect(f.start).not.toHaveBeenCalled()
  })
  it('never replays an unresolved claimed entry on restart and reconciles by request ID', async () => {
    const f = fixture(); f.runner.save(f.spec)
    const data = f.disk(); data.schedules[0]!.history.push({ id: 'entry', requestId: 'request', taskId: 'task', workflowId: 'workflow', at: 1, dueAt: 1, status: 'claimed' })
    const r = new ScheduleRunner(f.store, f.deps)
    expect(r.view().schedules[0]!.history[0]!.status).toBe('unknown')
    await r.tick(); expect(f.start).not.toHaveBeenCalled()
  })
  it('validates current task/template and skips active tasks', async () => {
    const f = fixture(); f.runner.save(f.spec)
    f.deps.validTask = () => false
    await f.runner.runNow('schedule', 'deleted')
    expect(f.start).not.toHaveBeenCalled()
    expect(f.runner.view().schedules[0]!.history[0]!.status).toBe('skipped')
    f.deps.validTask = () => true
    f.runs.push({ id: 'other', requestId: 'other', taskId: 'task', workflow: { id: 'workflow' }, status: 'waiting' })
    await f.runner.runNow('schedule', 'overlap'); expect(f.start).not.toHaveBeenCalled()
  })
  it('fails closed on journal writes and malformed journal', async () => {
    const f = fixture(); f.runner.save(f.spec); f.fail()
    await expect(f.runner.runNow('schedule', 'no-disk')).rejects.toThrow()
    expect(f.start).not.toHaveBeenCalled()
    expect(() => f.runner.view()).toThrow()
    const r = new ScheduleRunner({ load: () => ({ schedules: [null] }) as unknown as ScheduleView, save: () => {} }, f.deps)
    expect(() => r.view()).toThrow()
    expect(validScheduleView({ schedules: [null] })).toBe(false)
  })
  it('retains earliest manual request after visible history is pruned and rejects cross-schedule reuse', async () => {
    const f = fixture(); f.runner.save(f.spec); f.deps.validTask = () => false
    await f.runner.runNow('schedule', 'first')
    for (let index = 0; index < 101; index++) await f.runner.runNow('schedule', `later-${index}`)
    expect(f.runner.view().schedules[0]!.history).toHaveLength(100)
    f.deps.validTask = () => true
    expect((await f.runner.runNow('schedule', 'first')).status).toBe('unknown')
    await expect(f.runner.runNow('other-schedule', 'first')).rejects.toThrow('다른 예약')
    expect(f.start).not.toHaveBeenCalled()
  })
  it('hard stops new claims at 10000 tombstones without pruning existing request IDs', async () => {
    const f = fixture()
    f.disk().requests = Array.from({ length: 10000 }, (_, index) => ({ requestId: `request-${index}`, scheduleId: 'schedule', entryId: `entry-${index}` }))
    const r = new ScheduleRunner(f.store, f.deps); r.save(f.spec)
    await expect(r.runNow('schedule', 'one-more')).rejects.toThrow('10000')
    expect((await r.runNow('schedule', 'request-0')).status).toBe('unknown')
    expect(r.view().requests).toHaveLength(10000)
    expect(f.start).not.toHaveBeenCalled()
  })
  it('does not overlap while a start response is pending, including duplicate manual requests', async () => {
    const f = fixture(); f.runner.save({ ...f.spec, enabled: true })
    let resolve!: (id: string) => void
    f.deps.start = vi.fn(() => new Promise<string>(done => { resolve = done }))
    const pending = f.runner.runNow('schedule', 'pending')
    expect((await f.runner.runNow('schedule', 'pending')).status).toBe('claimed')
    f.clock(Date.parse('2026-01-01T00:05:00Z')); await f.runner.tick()
    await expect(f.runner.runNow('schedule', 'different')).rejects.toThrow('처리 중')
    expect(f.deps.start).toHaveBeenCalledTimes(1)
    resolve('run-late'); await pending
  })
  it('reconciles a durable claim after the result write fails, without resending', async () => {
    const f = fixture(); f.runner.save(f.spec)
    f.deps.start = input => { const id = f.start(input); f.fail(); return id }
    await expect(f.runner.runNow('schedule', 'write-failed')).rejects.toThrow('disk')
    expect(f.disk().schedules[0]!.history[0]!.status).toBe('claimed')
    const recovered = new ScheduleRunner({ load: f.store.load, save: value => { Object.assign(f.disk(), structuredClone(value)) } }, f.deps)
    expect(recovered.view().schedules[0]!.history[0]!.status).toBe('running')
    await recovered.runNow('schedule', 'write-failed')
    expect(f.start).toHaveBeenCalledTimes(1)
  })
  it('pause save and explicit resume never replay missed slots', async () => {
    const f = fixture(); f.runner.save({ ...f.spec, enabled: true })
    f.clock(Date.parse('2026-01-01T00:05:01Z')); f.runner.resume()
    expect(f.runner.view().schedules[0]!.history[0]!.status).toBe('missed')
    f.runner.save({ ...f.spec, enabled: false })
    f.clock(Date.parse('2026-02-01T00:00:00Z')); await f.runner.tick()
    f.runner.save({ ...f.spec, enabled: true })
    expect(f.runner.view().schedules[0]!.nextAt).toBe(Date.parse('2026-02-01T00:05:00Z'))
    expect(f.start).not.toHaveBeenCalled()
  })
  it('records runner rejection as skipped and never reissues that explicit request', async () => {
    const f = fixture(); f.runner.save(f.spec)
    const reject = vi.fn(() => { throw new Error('busy') }); f.deps.start = reject
    expect((await f.runner.runNow('schedule', 'rejected')).status).toBe('skipped')
    f.deps.start = f.start
    await f.runner.runNow('schedule', 'rejected')
    expect(reject).toHaveBeenCalledTimes(1); expect(f.start).not.toHaveBeenCalled()
  })
  it('bounds schedule count, interval range and timezone names without executing', () => {
    const f = fixture()
    for (let index = 0; index < 50; index++) f.runner.save({ ...f.spec, id: `schedule-${index}` })
    expect(() => f.runner.save({ ...f.spec, id: 'extra' })).toThrow('50')
    expect(validTiming({ kind: 'interval', minutes: 4 })).toBe(false)
    expect(validTiming({ kind: 'interval', minutes: 10081 })).toBe(false)
    expect(validTiming({ kind: 'daily', time: '02:30', timeZone: 'not/a-zone' })).toBe(false)
    expect(f.start).not.toHaveBeenCalled()
  })
})

describe('daily wall clock', () => {
  const timing = { kind: 'daily' as const, time: '02:30', timeZone: 'America/New_York' }
  it('skips a spring gap day', () => expect(nextOccurrence(timing, Date.parse('2026-03-08T05:00:00Z'))).toBe(Date.parse('2026-03-09T06:30:00Z')))
  it('runs fall-back local date once, including clock rollback', () => {
    const fall = { ...timing, time: '01:30' }
    expect(nextOccurrence(fall, Date.parse('2026-11-01T04:00:00Z'))).toBe(Date.parse('2026-11-01T05:30:00Z'))
    expect(nextOccurrence(fall, Date.parse('2026-11-01T05:31:00Z'), '2026-11-01')).toBe(Date.parse('2026-11-02T06:30:00Z'))
    expect(nextOccurrence(fall, Date.parse('2026-11-01T04:00:00Z'), '2026-11-01')).toBe(Date.parse('2026-11-02T06:30:00Z'))
  })
})

it('reconciles run identity captured at execution even after editing the schedule target', async () => {
 const f=fixture();f.runner.save(f.spec);await f.runner.runNow('schedule','edit-target');f.runner.save({...f.spec,workflowId:'other'});f.runs[0]!.status='done';f.runner.reconcile();expect(f.runner.view().schedules[0]!.history[0]!.status).toBe('done')
})
it('masks old names with current redaction settings in views and later writes', () => {
 const f=fixture();f.runner.save({...f.spec,name:'PRIVATE'});f.deps.redact=t=>t.replaceAll('PRIVATE','masked');expect(f.runner.view().schedules[0]!.name).toBe('masked');f.runner.save({...f.spec,name:'PRIVATE'});expect(JSON.stringify(f.disk())).not.toContain('PRIVATE')
})

it('suspend latch prevents overdue timer execution before the resume notification', async () => {
 const f=fixture();f.runner.save({...f.spec,enabled:true})
 const loop=new ScheduleLoop(f.runner,()=>true,()=>{})
 loop.suspend();f.clock(Date.parse('2026-01-01T00:05:30Z'));await loop.tick();expect(f.start).not.toHaveBeenCalled()
 loop.resume();await loop.tick();expect(f.start).not.toHaveBeenCalled();expect(f.runner.view().schedules[0]!.history[0]!.status).toBe('missed')
})
