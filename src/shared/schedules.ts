export type ScheduleTiming = { kind: 'interval'; minutes: number } | { kind: 'daily'; time: string; timeZone: string }
export interface ScheduleSpec { id: string; name: string; taskId: string; workflowId: string; timing: ScheduleTiming; enabled?: boolean }
export type ScheduleStatus = 'claimed' | 'missed' | 'skipped' | 'unknown' | 'preparing' | 'running' | 'waiting' | 'done' | 'failed' | 'stopped'
export interface ScheduleEntry { id: string; requestId: string; taskId: string; workflowId: string; at: number; dueAt: number; status: ScheduleStatus; runId?: string; reason?: string }
export interface Schedule extends ScheduleSpec { enabled: boolean; nextAt: number | null; lastLocalDate?: string; history: ScheduleEntry[] }
export interface ScheduleRequest { requestId: string; scheduleId: string; entryId: string }
export interface ScheduleView { schedules: Schedule[]; requests: ScheduleRequest[]; warning?: string }

const id = (v: unknown): v is string => typeof v === 'string' && /^[\w-]{1,100}$/.test(v)
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object'
const stamp = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 8.64e15
const states: ScheduleStatus[] = ['claimed', 'missed', 'skipped', 'unknown', 'preparing', 'running', 'waiting', 'done', 'failed', 'stopped']
const formatters = new Map<string, Intl.DateTimeFormat>()
function formatter(timeZone: string): Intl.DateTimeFormat {
  let value = formatters.get(timeZone)
  if (!value) {
    value = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    if (formatters.size >= 100) formatters.clear()
    formatters.set(timeZone, value)
  }
  return value
}
export function localClock(at: number, timeZone: string): { date: string; time: string } {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(at).map(p => [p.type, p.value]))
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` }
}
export function validTiming(v: unknown): v is ScheduleTiming {
  if (!object(v)) return false
  if (v.kind === 'interval') return Number.isInteger(v.minutes) && Number(v.minutes) >= 5 && Number(v.minutes) <= 10080
  if (v.kind !== 'daily' || typeof v.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v.time) || typeof v.timeZone !== 'string' || v.timeZone.length > 100) return false
  try { formatter(v.timeZone); return true } catch { return false }
}
export function validScheduleSpec(v: unknown): v is ScheduleSpec {
  return object(v) && id(v.id) && id(v.taskId) && id(v.workflowId) && typeof v.name === 'string' && !!v.name.trim() && v.name.length <= 100 && validTiming(v.timing) && (v.enabled === undefined || typeof v.enabled === 'boolean')
}
export function validScheduleView(v: unknown): v is ScheduleView {
  if (!object(v) || !Array.isArray(v.schedules) || v.schedules.length > 50 || !Array.isArray(v.requests) || v.requests.length > 10000) return false
  if (!v.requests.every(r => r && id(r.requestId) && id(r.scheduleId) && id(r.entryId)) || new Set(v.requests.map(r => r.requestId)).size !== v.requests.length) return false
  const requestIds = new Set<string>()
  return new Set(v.schedules.map(s => s?.id)).size === v.schedules.length && v.schedules.every((value: unknown) => {
    if (!validScheduleSpec(value)) return false
    const s = value as Schedule
    if (typeof s.enabled !== 'boolean' || !(s.nextAt === null || stamp(s.nextAt)) || (s.enabled ? s.nextAt === null : s.nextAt !== null)) return false
    if (s.lastLocalDate !== undefined && (typeof s.lastLocalDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s.lastLocalDate))) return false
    if (!Array.isArray(s.history) || s.history.length > 100) return false
    return new Set(s.history.map((h: ScheduleEntry) => h?.id)).size === s.history.length && s.history.every((h: ScheduleEntry) => {
      if (!h || !id(h.id) || !id(h.requestId) || !id(h.taskId) || !id(h.workflowId) || requestIds.has(h.requestId) || !stamp(h.at) || !stamp(h.dueAt) || !states.includes(h.status) || (h.runId !== undefined && !id(h.runId)) || (h.reason !== undefined && (typeof h.reason !== 'string' || h.reason.length > 2000))) return false
      requestIds.add(h.requestId)
      return true
    })
  })
}

/** Search actual UTC minutes: missing wall times skip a day; repeated hours use the first occurrence. */
export function nextOccurrence(timing: ScheduleTiming, after: number, lastLocalDate?: string): number {
  if (!validTiming(timing) || !stamp(after)) throw new Error('예약 시각을 확인해 주세요')
  if (timing.kind === 'interval') return after + timing.minutes * 60000
  const afterDate = localClock(after, timing.timeZone).date
  // A stored date can be far ahead after a clock rollback; jump near that date instead of scanning years.
  const earliest = lastLocalDate && lastLocalDate > afterDate ? Math.max(after, Date.parse(`${lastLocalDate}T00:00:00Z`) - 14 * 3600000) : after
  const first = Math.floor(earliest / 60000) * 60000 + 60000
  for (let minute = first; minute <= first + 4 * 86400000; minute += 60000) {
    const local = localClock(minute, timing.timeZone)
    if (local.time === timing.time && (!lastLocalDate || local.date > lastLocalDate)) return minute
  }
  throw new Error('다음 예약 시각을 계산하지 못했어요')
}

export interface ScheduleApi { view(): Promise<ScheduleView>; save(value: ScheduleSpec): Promise<void>; remove(id: string): Promise<void>; runNow(id: string, requestId: string): Promise<ScheduleEntry> }
