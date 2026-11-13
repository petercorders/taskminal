// `taskminal` 명령줄 도구 (24단계) — 인자 해석 · 소켓 요청 모양 · 이름 → id · list 글. 순수 (CLI · main · renderer 가 함께 쓴다).
import { isObj } from './guards'
import { formatDuration, taskActivity, type PaneActivity } from './activity'
import { hasPane, paneIds } from './layout'
import { tabShownLabel } from './model'
import { isPaneId } from './pty'
import type { AppState, Id, Task } from './types'

export const CLI_PROTOCOL = 1
/** 기다리기 기본 · 최대 */
export const WAIT_DEFAULT_MS = 30 * 60_000
export const WAIT_MAX_MS = 24 * 3600_000
export const QUIET_DEFAULT_MS = 3000
export const READ_DEFAULT_LINES = 50
export const TEXT_MAX = 100_000
/** 종료 코드 — 0 됨 · 1 오류 · 2 사용법 · 찾지 못함 · 3 앱이 꺼짐 · 124 시간 초과 */
export const EXIT = { ok: 0, error: 1, usage: 2, down: 3, timeout: 124 } as const

export type WaitFor = { kind: 'idle' | 'prompt' | 'exit' } | { kind: 'text'; text: string }
export type ChatWhere = 'right' | 'down' | 'tab'

/** 소켓으로 가는 요청. self = 부른 터미널의 pane id (TASKMINAL_PANE_ID) */
export type CliRequest = { self?: string } & (
  | { op: 'list' }
  | { op: 'task.new'; name: string; cwd?: string; template?: string; group?: string; status?: string }
  | { op: 'task.move'; task?: string; status?: string; group?: string }
  | { op: 'task.open'; task?: string }
  | { op: 'task.rename'; task?: string; name: string }
  | { op: 'task.color'; task?: string; color: string }
  | { op: 'task.remove'; task?: string; force: boolean }
  | { op: 'task.note'; task?: string; text: string }
  | { op: 'tab.new'; task?: string; template?: string; cmd?: string; title?: string }
  | { op: 'pane.split'; pane?: string; dir: 'right' | 'down'; cmd?: string }
  | { op: 'pane.send'; pane: string; text: string; enter: boolean }
  | { op: 'pane.read'; pane: string; lines: number }
  | { op: 'pane.wait'; pane: string; for: WaitFor; timeoutMs: number; quietMs: number }
  | { op: 'notify'; task?: string; text: string }
  | { op: 'chat.new'; task?: string; agent: 'claude' | 'codex'; where: ChatWhere; text: string }
  | { op: 'chat.send'; pane: string; text: string }
  | { op: 'chat.wait'; panes: string[]; all: boolean; task?: string; timeoutMs: number }
  | { op: 'chat.read'; pane: string }
)
export type CliOp = CliRequest['op']

/** 앱의 답. text = 사람이 읽는 글, data = --json. exit 가 없으면 ok 는 0 · 아니면 1 */
export type CliReply = { ok: true; text?: string; data?: unknown; exit?: number } | { ok: false; error: string; candidates?: string[]; exit?: number }

export type Parsed = { kind: 'request'; req: CliRequest; json: boolean } | { kind: 'help' } | { kind: 'version' } | { kind: 'usage'; error: string }

// ─── 시간 ────────────────────────────────────────────────────

/** '10m' · '30s' · '1h' · '500ms' · '90'(초) → ms. 틀리면 null */
export function parseDuration(s: string): number | null {
  const m = /^(\d{1,9})(ms|s|m|h)?$/.exec(s.trim())
  if (!m) return null
  const n = Number(m[1])
  const unit = m[2] ?? 's'
  const ms = unit === 'ms' ? n : unit === 's' ? n * 1000 : unit === 'm' ? n * 60_000 : n * 3_600_000
  return ms <= WAIT_MAX_MS ? ms : null
}

// ─── 인자 해석 ───────────────────────────────────────────────

interface Spec {
  /** 값을 받는 옵션 */
  values?: readonly string[]
  /** 켜기만 하는 옵션 */
  flags?: readonly string[]
  /** 자리 인자 수 [최소, 최대] */
  pos: [number, number]
}

const SPECS: Record<string, Spec> = {
  list: { flags: ['json'], pos: [0, 0] },
  'task new': { values: ['cwd', 'template', 'group', 'status'], pos: [1, 1] },
  'task move': { values: ['status', 'group'], pos: [0, 1] },
  'task open': { pos: [0, 1] },
  'task rename': { pos: [1, 2] },
  'task color': { pos: [1, 2] },
  'task remove': { flags: ['force'], pos: [0, 1] },
  'task note': { pos: [1, 2] },
  'tab new': { values: ['template', 'cmd', 'title'], pos: [0, 1] },
  'pane split': { values: ['cmd'], flags: ['right', 'down'], pos: [0, 1] },
  'pane send': { flags: ['enter'], pos: [2, 2] },
  'pane read': { values: ['lines'], flags: ['json'], pos: [1, 1] },
  'pane wait': { values: ['for', 'timeout', 'quiet'], pos: [1, 1] },
  notify: { values: ['task'], pos: [1, 1] },
  'chat new': { values: ['agent', 'task'], flags: ['right', 'down', 'tab'], pos: [1, 1] },
  'chat send': { pos: [2, 2] },
  'chat wait': { values: ['timeout', 'task'], flags: ['all'], pos: [0, 20] },
  'chat read': { flags: ['json'], pos: [1, 1] },
}
const GROUPS = new Set(['task', 'tab', 'pane', 'chat'])

const usage = (error: string): Parsed => ({ kind: 'usage', error })

/** argv = 명령 뒤의 인자들 (node · 스크립트 경로 뺀 것). self 는 부르는 쪽이 붙인다 */
export function parseArgs(argv: readonly string[]): Parsed {
  const args = [...argv]
  let json = false
  // 맨 앞의 --json 도 받는다 (`taskminal --json list`)
  while (args[0] === '--json') {
    json = true
    args.shift()
  }
  const first = args[0]
  if (first === undefined || first === 'help' || first === '--help' || first === '-h') return { kind: 'help' }
  if (first === '--version' || first === '-v' || first === 'version') return { kind: 'version' }
  let name = first
  args.shift()
  if (GROUPS.has(first)) {
    const sub = args.shift()
    if (sub === undefined) return usage(`'${first}' 뒤에 할 일을 적어 주세요 (taskminal help)`)
    name = `${first} ${sub}`
  }
  const spec = SPECS[name]
  if (!spec) return usage(`모르는 명령: ${name} (taskminal help)`)

  const values: Record<string, string> = {}
  const flags = new Set<string>()
  const pos: string[] = []
  let rest = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (rest || !a.startsWith('--') || a === '--') {
      if (a === '--' && !rest) {
        rest = true
        continue
      }
      pos.push(a)
      continue
    }
    const eq = a.indexOf('=')
    const key = (eq >= 0 ? a.slice(2, eq) : a.slice(2)).trim()
    if (key === 'json' && !spec.flags?.includes('json')) {
      json = true
      continue
    }
    if (spec.flags?.includes(key)) {
      if (eq >= 0) return usage(`--${key} 는 값을 받지 않아요`)
      flags.add(key)
      if (key === 'json') json = true
      continue
    }
    if (spec.values?.includes(key)) {
      const v = eq >= 0 ? a.slice(eq + 1) : args[++i]
      if (v === undefined) return usage(`--${key} 뒤에 값을 적어 주세요`)
      values[key] = v
      continue
    }
    return usage(`'${name}' 에 없는 옵션: --${key} — 글이 - 로 시작하면 옵션 뒤에 -- 를 두고 적어 주세요 (예: taskminal ${name} … -- "--- 요약")`)
  }
  const [min, max] = spec.pos
  if (pos.length < min) return usage(`'${name}' 에 인자가 모자라요 (taskminal help)`)
  if (pos.length > max) return usage(`'${name}' 에 인자가 너무 많아요: ${pos.slice(max).join(' ')} — 띄어 쓴 글은 따옴표로 묶어 주세요`)
  for (const v of [...pos, ...Object.values(values)]) if (v.length > TEXT_MAX) return usage('글이 너무 길어요')

  const req = build(name, pos, values, flags)
  return typeof req === 'string' ? usage(req) : { kind: 'request', req, json }
}

function build(name: string, pos: string[], v: Record<string, string>, f: Set<string>): CliRequest | string {
  const opt = <K extends string>(key: K, val: string | undefined) => (val !== undefined ? ({ [key]: val } as Record<K, string>) : {})
  // 자리 인자가 하나 · 둘인 명령: 둘이면 앞이 일감, 하나면 이 일감
  const two = () => (pos.length === 2 ? { task: pos[0]!, last: pos[1]! } : { last: pos[0]! })
  switch (name) {
    case 'list':
      return { op: 'list' }
    case 'task new':
      if (!pos[0]!.trim()) return '일감 이름이 비었어요'
      return { op: 'task.new', name: pos[0]!, ...opt('cwd', v['cwd']), ...opt('template', v['template']), ...opt('group', v['group']), ...opt('status', v['status']) }
    case 'task move':
      if (v['status'] === undefined && v['group'] === undefined) return '--status 나 --group 을 적어 주세요'
      return { op: 'task.move', ...opt('task', pos[0]), ...opt('status', v['status']), ...opt('group', v['group']) }
    case 'task open':
      return { op: 'task.open', ...opt('task', pos[0]) }
    case 'task rename': {
      const t = two()
      if (!t.last.trim()) return '새 이름이 비었어요'
      return { op: 'task.rename', ...opt('task', t.task), name: t.last }
    }
    case 'task color': {
      const t = two()
      if (!/^#[0-9a-fA-F]{6}$/.test(t.last) && t.last !== 'none') return '색은 #rrggbb 또는 none 으로 적어 주세요'
      return { op: 'task.color', ...opt('task', t.task), color: t.last }
    }
    case 'task remove':
      return { op: 'task.remove', ...opt('task', pos[0]), force: f.has('force') }
    case 'task note': {
      const t = two()
      if (!t.last.trim()) return '메모가 비었어요'
      return { op: 'task.note', ...opt('task', t.task), text: t.last }
    }
    case 'tab new':
      return { op: 'tab.new', ...opt('task', pos[0]), ...opt('template', v['template']), ...opt('cmd', v['cmd']), ...opt('title', v['title']) }
    case 'pane split':
      if (f.has('right') && f.has('down')) return '--right 와 --down 중 하나만'
      return { op: 'pane.split', ...opt('pane', pos[0]), dir: f.has('down') ? 'down' : 'right', ...opt('cmd', v['cmd']) }
    case 'pane send':
      return { op: 'pane.send', pane: pos[0]!, text: pos[1]!, enter: f.has('enter') }
    case 'pane read': {
      const lines = v['lines'] === undefined ? READ_DEFAULT_LINES : Number(v['lines'])
      if (!Number.isInteger(lines) || lines < 1 || lines > 1000) return '--lines 는 1~1000'
      return { op: 'pane.read', pane: pos[0]!, lines }
    }
    case 'pane wait': {
      const w = v['for']
      if (w === undefined) return '--for idle|prompt|exit|text:"…" 를 적어 주세요'
      let wf: WaitFor
      if (w === 'idle' || w === 'prompt' || w === 'exit') wf = { kind: w }
      else if (w.startsWith('text:') && w.length > 5) wf = { kind: 'text', text: w.slice(5) }
      else return `--for 는 idle · prompt · exit · text:"…" 중 하나: ${w}`
      const timeoutMs = v['timeout'] === undefined ? WAIT_DEFAULT_MS : parseDuration(v['timeout'])
      const quietMs = v['quiet'] === undefined ? QUIET_DEFAULT_MS : parseDuration(v['quiet'])
      if (timeoutMs === null) return `--timeout 을 읽지 못했어요: ${v['timeout']} (예: 10m · 30s)`
      if (quietMs === null || quietMs < 100) return `--quiet 를 읽지 못했어요: ${v['quiet']} (예: 3s)`
      return { op: 'pane.wait', pane: pos[0]!, for: wf, timeoutMs, quietMs }
    }
    case 'notify':
      if (!pos[0]!.trim()) return '알릴 글이 비었어요'
      return { op: 'notify', ...opt('task', v['task']), text: pos[0]! }
    case 'chat new': {
      const agent = v['agent'] ?? 'claude'
      if (agent !== 'claude' && agent !== 'codex') return '--agent 는 claude 또는 codex'
      const n = ['right', 'down', 'tab'].filter((k) => f.has(k))
      if (n.length > 1) return '--right · --down · --tab 중 하나만'
      if (!pos[0]!.trim()) return '보낼 글이 비었어요'
      return { op: 'chat.new', ...opt('task', v['task']), agent, where: (n[0] as ChatWhere | undefined) ?? 'right', text: pos[0]! }
    }
    case 'chat send':
      if (!pos[1]!.trim()) return '보낼 글이 비었어요'
      return { op: 'chat.send', pane: pos[0]!, text: pos[1]! }
    case 'chat wait': {
      if (!f.has('all') && pos.length === 0) return '기다릴 대화 pane 을 적거나 --all'
      if (f.has('all') && pos.length > 0) return '--all 과 pane 을 함께 적지 않아요'
      const timeoutMs = v['timeout'] === undefined ? WAIT_DEFAULT_MS : parseDuration(v['timeout'])
      if (timeoutMs === null) return `--timeout 을 읽지 못했어요: ${v['timeout']}`
      return { op: 'chat.wait', panes: pos, all: f.has('all'), ...opt('task', v['task']), timeoutMs }
    }
    case 'chat read':
      return { op: 'chat.read', pane: pos[0]! }
  }
  return `모르는 명령: ${name}`
}

// ─── 소켓에서 받은 값 검사 (main) ─────────────────────────────

const str = (v: unknown, max = TEXT_MAX): v is string => typeof v === 'string' && v.length <= max
const optStr = (v: unknown, max = 4096): boolean => v === undefined || str(v, max)
const okText = (v: unknown): v is string => str(v) && v.trim().length > 0
const okMs = (v: unknown, min = 0): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= WAIT_MAX_MS

/** 같은 사용자의 아무 프로그램이나 소켓에 쓸 수 있다 — 모양을 다시 본다(모르는 칸은 버린다) */
export function isCliRequest(v: unknown): v is CliRequest {
  if (!isObj(v) || typeof v['op'] !== 'string') return false
  if (v['self'] !== undefined && !isPaneId(v['self'])) return false
  const o = v as Record<string, unknown>
  switch (o['op']) {
    case 'list':
      return true
    case 'task.new':
      return okText(o['name']) && ['cwd', 'template', 'group', 'status'].every((k) => optStr(o[k]))
    case 'task.move':
      return ['task', 'status', 'group'].every((k) => optStr(o[k])) && (o['status'] !== undefined || o['group'] !== undefined)
    case 'task.open':
      return optStr(o['task'])
    case 'task.rename':
      return optStr(o['task']) && okText(o['name']) && (o['name'] as string).length <= 200
    case 'task.color':
      return optStr(o['task']) && typeof o['color'] === 'string' && (/^#[0-9a-fA-F]{6}$/.test(o['color']) || o['color'] === 'none')
    case 'task.remove':
      return optStr(o['task']) && typeof o['force'] === 'boolean'
    case 'task.note':
    case 'notify':
      return optStr(o['task']) && okText(o['text'])
    case 'tab.new':
      return ['task', 'template', 'title'].every((k) => optStr(o[k])) && optStr(o['cmd'], TEXT_MAX)
    case 'pane.split':
      return optStr(o['pane']) && (o['dir'] === 'right' || o['dir'] === 'down') && optStr(o['cmd'], TEXT_MAX)
    case 'pane.send':
      return str(o['pane'], 4096) && str(o['text']) && typeof o['enter'] === 'boolean'
    case 'pane.read':
      return str(o['pane'], 4096) && Number.isInteger(o['lines']) && (o['lines'] as number) >= 1 && (o['lines'] as number) <= 1000
    case 'pane.wait': {
      const w = o['for']
      const okFor = isObj(w) && (w['kind'] === 'idle' || w['kind'] === 'prompt' || w['kind'] === 'exit' || (w['kind'] === 'text' && okText(w['text'])))
      return str(o['pane'], 4096) && okFor && okMs(o['timeoutMs']) && okMs(o['quietMs'], 100)
    }
    case 'chat.new':
      return optStr(o['task']) && (o['agent'] === 'claude' || o['agent'] === 'codex') && (o['where'] === 'right' || o['where'] === 'down' || o['where'] === 'tab') && okText(o['text'])
    case 'chat.send':
      return str(o['pane'], 4096) && okText(o['text'])
    case 'chat.wait':
      return Array.isArray(o['panes']) && o['panes'].length <= 20 && o['panes'].every((p) => str(p, 4096)) && typeof o['all'] === 'boolean' && optStr(o['task']) && okMs(o['timeoutMs'])
    case 'chat.read':
      return str(o['pane'], 4096)
    default:
      return false
  }
}

// ─── 이름 → id ───────────────────────────────────────────────

export type Resolved<T> = { ok: true; value: T } | { ok: false; error: string; candidates?: string[] }

const fail = <T>(error: string, candidates?: string[]): Resolved<T> => (candidates ? { ok: false, error, candidates } : { ok: false, error })

function taskOfPane(state: AppState, paneId: string | undefined): Task | undefined {
  return paneId ? state.tasks.find((t) => Object.hasOwn(t.panes, paneId)) : undefined
}

/** 일감: 생략 → 부른 터미널의 일감 · id · 이름(같음 → 대소문자 무시). 둘 이상이면 후보 */
export function resolveTask(state: AppState, ref: string | undefined, self: string | undefined): Resolved<Task> {
  if (ref === undefined) {
    const t = taskOfPane(state, self)
    return t ? { ok: true, value: t } : fail('어느 일감인지 적어 주세요 — 이 터미널은 Taskminal 의 일감 안이 아니에요')
  }
  const byId = state.tasks.find((t) => t.id === ref)
  if (byId) return { ok: true, value: byId }
  const exact = state.tasks.filter((t) => t.name === ref)
  const hits = exact.length > 0 ? exact : state.tasks.filter((t) => t.name.toLowerCase() === ref.trim().toLowerCase())
  if (hits.length === 1) return { ok: true, value: hits[0]! }
  if (hits.length > 1) return fail(`'${ref}' 인 일감이 ${hits.length}개예요 — id 로 적어 주세요`, hits.map((t) => `${t.name}  ${t.id}`))
  return fail(`'${ref}' 일감을 찾지 못했어요`)
}

export interface PaneRef {
  taskId: Id
  tabId: Id
  paneId: Id
}

function tabOf(task: Task, paneId: Id): Id | null {
  return task.tabs.find((t) => hasPane(t.layout, paneId))?.id ?? null
}

/** pane: 생략 → 부른 터미널 · pane id · 일감(활성 탭의 활성 pane) · 일감:탭(탭 이름 또는 1부터 번호) */
export function resolvePane(state: AppState, ref: string | undefined, self: string | undefined): Resolved<PaneRef> {
  const at = (task: Task, paneId: Id): Resolved<PaneRef> => {
    const tabId = tabOf(task, paneId)
    return tabId ? { ok: true, value: { taskId: task.id, tabId, paneId } } : fail('그 pane 이 든 탭이 없어요')
  }
  if (ref === undefined) {
    const t = taskOfPane(state, self)
    return t && self ? at(t, self) : fail('어느 pane 인지 적어 주세요 — 이 터미널은 Taskminal 의 일감 안이 아니에요')
  }
  const owner = taskOfPane(state, ref)
  if (owner) return at(owner, ref)
  const whole = resolveTask(state, ref, undefined)
  if (whole.ok) {
    const tab = whole.value.tabs.find((t) => t.id === whole.value.activeTabId)
    return tab ? { ok: true, value: { taskId: whole.value.id, tabId: tab.id, paneId: tab.activePaneId } } : fail(`'${whole.value.name}' 에 탭이 없어요`)
  }
  if (whole.candidates) return whole
  const colon = ref.lastIndexOf(':')
  if (colon <= 0) return fail(`'${ref}' pane 을 찾지 못했어요 — pane id · 일감 이름 · 일감:탭 으로 적어 주세요`)
  const task = resolveTask(state, ref.slice(0, colon), undefined)
  if (!task.ok) return task
  const tabRef = ref.slice(colon + 1).trim()
  const tabs = task.value.tabs
  const n = /^\d+$/.test(tabRef) ? Number(tabRef) : NaN
  const hits = Number.isInteger(n) ? (tabs[n - 1] ? [tabs[n - 1]!] : []) : tabs.filter((t) => tabShownLabel(task.value, t).toLowerCase() === tabRef.toLowerCase())
  if (hits.length === 1) return { ok: true, value: { taskId: task.value.id, tabId: hits[0]!.id, paneId: hits[0]!.activePaneId } }
  if (hits.length > 1) return fail(`'${task.value.name}' 에 '${tabRef}' 탭이 ${hits.length}개예요 — 번호로 적어 주세요`, hits.map((t) => `${task.value.name}:${tabs.indexOf(t) + 1}  ${tabShownLabel(task.value, t)}`))
  return fail(`'${task.value.name}' 에 '${tabRef}' 탭이 없어요`, tabs.map((t, i) => `${task.value.name}:${i + 1}  ${tabShownLabel(task.value, t)}`))
}

// ─── list ────────────────────────────────────────────────────

export interface ListRow {
  task: string
  taskId: Id
  status: string
  tab: string
  paneId: Id
  kind: 'terminal' | 'chat' | 'review'
  activity: 'attention' | 'running' | 'failed' | 'done' | 'idle'
  command?: string
  /** 사람이 읽는 끝 칸 (exit · 걸린 시간) */
  detail?: string
  here: boolean
}

const ACT_LABEL: Record<ListRow['activity'], string> = { attention: '확인 필요', running: '실행 중', failed: '실패', done: '끝남', idle: '쉼' }
const ACT_RANK: Record<ListRow['activity'], number> = { attention: 0, failed: 1, running: 2, done: 3, idle: 4 }

/** pane 한 줄씩 — 확인 필요 → 실패 → 실행 중 → 끝남 → 쉼, 같으면 일감 순서. mask = 명령 글 가리기 */
export function listRows(state: AppState, activity: Readonly<Record<string, PaneActivity>>, self: string | undefined, now: number, mask: (s: string) => string = (s) => s): ListRow[] {
  const rows: ListRow[] = []
  for (const task of state.tasks) {
    const status = state.settings.statuses.find((s) => s.id === task.statusId)?.name ?? ''
    for (const tab of task.tabs) {
      for (const paneId of paneIds(tab.layout)) {
        const pane = task.panes[paneId]
        if (!pane) continue
        const a = activity[paneId]
        const act: ListRow['activity'] = !a ? 'idle' : a.attention ? 'attention' : a.state === 'running' || a.busy ? 'running' : a.state === 'failed' ? 'failed' : a.state === 'done' ? 'done' : 'idle'
        const row: ListRow = { task: task.name, taskId: task.id, status, tab: tabShownLabel(task, tab), paneId, kind: pane.kind === 'chat' ? 'chat' : pane.kind === 'review' ? 'review' : 'terminal', activity: act, here: paneId === self }
        if (a?.command) row.command = mask(a.command)
        const detail =
          act === 'attention'
            ? a?.message
              ? mask(a.message)
              : '입력 기다림'
            : act === 'running' && a?.startedAt !== undefined
              ? `${formatDuration(now - a.startedAt)}째`
              : (act === 'failed' || act === 'done') && a?.exitCode !== undefined
                ? `${act === 'failed' ? '✗' : '✓'} exit ${a.exitCode}`
                : undefined
        if (detail) row.detail = detail
        rows.push(row)
      }
    }
  }
  return rows.sort((x, y) => ACT_RANK[x.activity] - ACT_RANK[y.activity])
}

/** 사람이 읽는 표 — 칸 너비를 맞춘다 */
export function formatRows(rows: readonly ListRow[]): string {
  if (rows.length === 0) return '일감이 없어요'
  const cells = rows.map((r) => [ACT_LABEL[r.activity], `${r.task} › ${r.tab}`, r.kind === 'chat' ? '(대화)' : r.kind === 'review' ? '(변경)' : (r.command ?? ''), r.detail ?? '', r.paneId + (r.here ? '  ← 여기' : '')])
  const width = (s: string) => [...s].reduce((n, ch) => n + (/[ᄀ-ᇿ㄰-㆏가-힯一-鿿＀-￯]/.test(ch) ? 2 : 1), 0)
  const cols = [0, 1, 2, 3].map((i) => Math.min(40, Math.max(...cells.map((c) => width(c[i]!)))))
  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - width(s)))
  return cells.map((c) => c.map((s, i) => (i < 4 ? pad(s, cols[i]!) : s)).join('  ').trimEnd()).join('\n')
}

/** 한 일감 — 확인 필요 칸 수 (task.remove --force 판단 · 시험) */
export function runningCount(task: Task, activity: Readonly<Record<string, PaneActivity>>): number {
  return taskActivity(Object.keys(task.panes).map((id) => activity[id])).running
}

// ─── 소켓 경로 · 도움말 ───────────────────────────────────────

/** `<userData>/cli.sock` — 맥 한도(104바이트)를 넘으면 `<tmp>/taskminal-<해시>-cli.sock` (지킴이 소켓과 같은 규칙) */
export function cliSocketPath(userData: string, tmp: string, hash: (s: string) => string): string {
  const direct = `${userData.replace(/\/+$/, '')}/cli.sock`
  if (new TextEncoder().encode(direct).length < 104) return direct
  return `${tmp.replace(/\/+$/, '')}/taskminal-${hash(userData).slice(0, 16)}-cli.sock`
}

export const HELP = `taskminal — Taskminal 의 일감 · 탭 · 터미널을 명령줄에서 다뤄요 (앱이 켜져 있어야 해요)

  taskminal list [--json]                          일감 · 탭 · 터미널과 활동 (← 여기 = 이 터미널)
  taskminal task new <이름> [--cwd 폴더] [--template 이름] [--group 이름] [--status 이름]
  taskminal task move [<일감>] [--status 이름] [--group 이름]
  taskminal task open [<일감>]                     화면에 열기
  taskminal task rename [<일감>] <새 이름>
  taskminal task color [<일감>] <#rrggbb|none>
  taskminal task remove [<일감>] [--force]         실행 중인 명령이 있으면 --force
  taskminal task note [<일감>] "글"                 일감 메모에 덧붙이기 (에이전트가 남김)
  taskminal tab new [<일감>] [--template 이름] [--cmd "…"] [--title 이름]
  taskminal pane split [<pane>] [--right|--down] [--cmd "…"]   → 새 pane id
  taskminal pane send <pane> "글" [--enter]
  taskminal pane read <pane> [--lines 50] [--json]
  taskminal pane wait <pane> --for idle|prompt|exit|text:"…" [--timeout 30m] [--quiet 3s]
  taskminal notify [--task <일감>] "글"             확인 필요에 올리고 macOS 알림
  taskminal chat new [--task <일감>] [--agent claude|codex] [--right|--down|--tab] "글"  → 대화 pane id
  taskminal chat send <pane> "글"
  taskminal chat wait <pane…> | --all [--timeout 30m]   턴이 끝나거나 허락 · 질문을 기다릴 때까지
  taskminal chat read <pane> [--json]               마지막 턴의 에이전트 글

  <일감> = id · 이름 · <pane> = pane id · 일감 이름 · 일감:탭(이름 또는 번호). 생략하면 이 터미널.
  에이전트에게: 일을 마치면 'taskminal task note "다음 할 일 …"', 사람 확인이 필요하면 'taskminal notify "…"'.
  종료 코드: 0 됨 · 1 오류 · 2 사용법 · 찾지 못함 · 3 앱이 꺼짐 · 124 시간 초과
  출력의 비밀값은 가려져요.`

// ─── main ↔ 창 (renderer) ─────────────────────────────────────

/** 이름을 푼 pane — main 이 셸 · 대화에 직접 할 일(보내기 · 읽기 · 기다리기)에 쓴다 */
export interface PaneTarget {
  paneId: Id
  /** '일감 › 탭' */
  label: string
  kind: 'terminal' | 'chat' | 'review'
  cwd: string
  chat?: { agent: 'claude' | 'codex'; sessionId?: string; forkAt?: string }
  /** 아직 보내지 않은 시작 명령이 있다 */
  pending: boolean
}

/** main 이 창에 묻는 것: 화면 상태를 바꾸는 CLI 요청 그대로 · 이름 풀기(필요하면 그 탭을 띄운다) */
export type UiRequest =
  | {op:'workflow.prepare'; taskId:string;paneId:string;tabId:string;agent:'claude'|'codex';runId:string;label:string;self?:string}
  | Exclude<CliRequest, { op: 'pane.send' | 'pane.read' | 'pane.wait' | 'chat.send' | 'chat.wait' | 'chat.read' }>
  | { op: 'pane.resolve'; pane?: string; self?: string }
  | { op: 'chat.panes'; panes: string[]; all: boolean; task?: string; self?: string }

export type UiReply = ({ ok: true; text?: string; data?: unknown; exit?: number; target?: PaneTarget; targets?: PaneTarget[] }) | { ok: false; error: string; candidates?: string[]; exit?: number }

const isTarget = (v: unknown): v is PaneTarget =>
  isObj(v) &&
  isPaneId(v['paneId']) &&
  str(v['label'], 1000) &&
  (v['kind'] === 'terminal' || v['kind'] === 'chat' || v['kind'] === 'review') &&
  str(v['cwd'], 4096) &&
  typeof v['pending'] === 'boolean' &&
  (v['chat'] === undefined || (isObj(v['chat']) && (v['chat']['agent'] === 'claude' || v['chat']['agent'] === 'codex')))

/** 창이 보낸 답 — 모양이 틀리면 null (main 이 '앱 화면이 답하지 않아요' 로) */
export function parseUiReply(v: unknown): UiReply | null {
  if (!isObj(v) || typeof v['ok'] !== 'boolean') return null
  const exit = v['exit']
  if (exit !== undefined && !(Number.isInteger(exit) && (exit as number) >= 0 && (exit as number) <= 255)) return null
  if (!v['ok']) {
    if (!str(v['error'], 10_000)) return null
    const c = v['candidates']
    if (c !== undefined && !(Array.isArray(c) && c.length <= 100 && c.every((x) => str(x, 1000)))) return null
    return v as UiReply
  }
  if (v['text'] !== undefined && !str(v['text'], 1_000_000)) return null
  if (v['target'] !== undefined && !isTarget(v['target'])) return null
  if (v['targets'] !== undefined && !(Array.isArray(v['targets']) && v['targets'].length <= 200 && v['targets'].every(isTarget))) return null
  return v as UiReply
}
