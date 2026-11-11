// 대화 pane (21단계) — 에이전트 출력을 공통 이벤트로 바꾸고, 화면 블록 · 상태를 만든다. 순수 함수라 단위 시험한다.
// Claude 모양은 2026-11-11 스파이크(claude 2.1.322, stream-json + --permission-prompt-tool stdio)로 확인했다 — tests/fixtures/claude/*.jsonl
import { isDangerous } from './danger'
import { isObj, type Obj } from './guards'
import { redact, type SecretOptions } from './redact'

export type ChatAgent = 'claude'
/** 허락 방식 — 처음은 'ask'(매번 묻기). 앱 설정에 저장돼 새 대화 · 재시작 뒤에도 유지 */
export type ChatPermission = 'ask' | 'edits' | 'auto'
export const CHAT_PERMISSIONS: ReadonlyArray<{ id: ChatPermission; name: string; mode: string }> = [
  { id: 'ask', name: '매번 묻기', mode: 'default' },
  { id: 'edits', name: '파일 고치기는 자동', mode: 'acceptEdits' },
  { id: 'auto', name: '자동', mode: 'auto' },
]
export const isChatPermission = (v: unknown): v is ChatPermission => CHAT_PERMISSIONS.some((p) => p.id === v)

export interface ChatQuestion {
  question: string
  header: string
  multi: boolean
  options: { label: string; description: string }[]
}

/** 허락 · 질문 답 (renderer → main) */
export type ChatDecision = { how: 'allow' | 'always' | 'deny'; message?: string } | { how: 'answer'; answers: Record<string, string> }
export function isChatDecision(v: unknown): v is ChatDecision {
  if (!isObj(v)) return false
  if (v['how'] === 'answer') {
    const a = v['answers']
    return isObj(a) && Object.keys(a).length <= 20 && Object.entries(a).every(([k, x]) => k.length <= 2000 && typeof x === 'string' && x.length <= 20000)
  }
  if (v['how'] !== 'allow' && v['how'] !== 'always' && v['how'] !== 'deny') return false
  return v['message'] === undefined || (typeof v['message'] === 'string' && v['message'].length <= 20000)
}

export type ErrorKind = 'login' | 'limit' | 'missing' | 'crash' | 'other'
export type AnswerHow = 'allow' | 'always' | 'deny' | 'answer' | 'lost'

/** 에이전트가 무엇이든 화면 · 디스크는 이 모양만 안다 */
export type ChatEvent =
  | { t: 'user'; text: string; at: number }
  | { t: 'session'; id: string; model?: string }
  | { t: 'text'; text: string }
  | { t: 'tool'; id: string; name: string; summary: string }
  | { t: 'tool_end'; id: string; ok: boolean; tail: string }
  | { t: 'permission'; id: string; tool: string; summary: string; why: string; danger: boolean }
  | { t: 'question'; id: string; questions: ChatQuestion[] }
  | { t: 'answered'; id: string; how: AnswerHow }
  | { t: 'turn_end'; ok: boolean; ms: number; reason: string; ctxPct?: number }
  | { t: 'stopped' }
  | { t: 'error'; kind: ErrorKind; message: string; code?: number; resetsAt?: number }

const EVENT_TYPES = new Set(['user', 'session', 'text', 'tool', 'tool_end', 'permission', 'question', 'answered', 'turn_end', 'stopped', 'error'])
/** 디스크 · IPC 에서 읽은 값 — 종류와 그 종류의 글 칸만 본다(화면은 모르는 칸을 쓰지 않는다) */
export function isChatEvent(v: unknown): v is ChatEvent {
  if (!isObj(v) || typeof v['t'] !== 'string' || !EVENT_TYPES.has(v['t'])) return false
  switch (v['t']) {
    case 'user':
    case 'text':
      return typeof v['text'] === 'string'
    case 'tool':
      return typeof v['id'] === 'string' && typeof v['name'] === 'string' && typeof v['summary'] === 'string'
    case 'tool_end':
      return typeof v['id'] === 'string' && typeof v['tail'] === 'string'
    case 'permission':
      return typeof v['id'] === 'string' && typeof v['tool'] === 'string' && typeof v['summary'] === 'string' && typeof v['why'] === 'string'
    case 'question':
      return typeof v['id'] === 'string' && Array.isArray(v['questions'])
    case 'answered':
    case 'session':
      return typeof v['id'] === 'string'
    case 'turn_end':
      return typeof v['ms'] === 'number'
    case 'error':
      return typeof v['kind'] === 'string' && typeof v['message'] === 'string'
    default:
      return true
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s)

function inside(cwd: string, path: string): boolean {
  const root = cwd.replace(/\/+$/, '')
  return path === root || path.startsWith(root + '/')
}
function rel(cwd: string, path: string): string {
  return inside(cwd, path) && path !== cwd.replace(/\/+$/, '') ? path.slice(cwd.replace(/\/+$/, '').length + 1) : path
}

/** 도구 입력을 한 줄로 — Bash 는 명령, 파일 도구는 폴더 기준 경로 */
export function toolSummary(name: string, input: unknown, cwd: string): string {
  const i: Obj = isObj(input) ? input : {}
  if (typeof i['command'] === 'string') return clip(i['command'], 300)
  for (const k of ['file_path', 'notebook_path', 'path']) if (typeof i[k] === 'string') return clip(rel(cwd, i[k] as string), 300)
  for (const k of ['pattern', 'url', 'query', 'description', 'prompt']) if (typeof i[k] === 'string') return clip(i[k] as string, 300)
  return name
}

/** 위험한 허락 — '이 명령만 늘 허락' 을 보이지 않는다: 위험 명령 · 작업 폴더 밖 경로 */
export function isDangerousTool(tool: string, input: unknown, cwd: string, blockedPath?: string): boolean {
  if (blockedPath && !inside(cwd, blockedPath)) return true
  const i: Obj = isObj(input) ? input : {}
  if (typeof i['command'] === 'string' && isDangerous(i['command'])) return true
  for (const k of ['file_path', 'notebook_path']) {
    const p = i[k]
    if (typeof p === 'string' && p.startsWith('/') && !inside(cwd, p)) return true
  }
  void tool
  return false
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((c) => (isObj(c) ? str(c['text']) : '')).join('\n')
  return ''
}
function tailOf(text: string): string {
  const lines = text.replace(/\s+$/, '').split('\n')
  return clip(lines.slice(-3).join('\n'), 400)
}

function ctxPercent(o: Obj): number | undefined {
  const mu = o['modelUsage']
  const usage = o['usage']
  if (!isObj(mu) || !isObj(usage)) return undefined
  const first = Object.values(mu).find(isObj)
  const win = first && typeof first['contextWindow'] === 'number' ? first['contextWindow'] : 0
  if (!win) return undefined
  const its = Array.isArray(usage['iterations']) ? usage['iterations'].filter(isObj) : []
  const last = its.length ? its[its.length - 1]! : usage
  const n = (k: string) => (typeof last[k] === 'number' ? (last[k] as number) : 0)
  const used = n('input_tokens') + n('cache_creation_input_tokens') + n('cache_read_input_tokens') + n('output_tokens')
  return Math.min(100, Math.round((used / win) * 100))
}

/** stream-json 한 줄(JSON 으로 읽은 것) → 공통 이벤트. 모르는 줄 · 모양이 틀린 줄은 빈 배열 */
export function claudeLineToEvents(o: unknown, cwd: string): ChatEvent[] {
  if (!isObj(o)) return []
  const type = o['type']
  if (type === 'system' && o['subtype'] === 'init' && typeof o['session_id'] === 'string') {
    return [{ t: 'session', id: o['session_id'], ...(typeof o['model'] === 'string' ? { model: o['model'] } : {}) }]
  }
  if (type === 'assistant' && isObj(o['message'])) {
    const content = o['message']['content']
    if (!Array.isArray(content)) return []
    if (o['error'] === 'authentication_failed' || (isObj(o['message']) && o['message']['model'] === '<synthetic>' && o['error'])) {
      const msg = content.map((c) => (isObj(c) ? str(c['text']) : '')).join(' ')
      return [{ t: 'error', kind: o['error'] === 'authentication_failed' ? 'login' : 'other', message: clip(msg, 300) }]
    }
    const out: ChatEvent[] = []
    for (const c of content) {
      if (!isObj(c)) continue
      if (c['type'] === 'text' && typeof c['text'] === 'string' && c['text'].trim()) out.push({ t: 'text', text: c['text'] })
      if (c['type'] === 'tool_use' && typeof c['id'] === 'string' && typeof c['name'] === 'string' && c['name'] !== 'AskUserQuestion') {
        out.push({ t: 'tool', id: c['id'], name: c['name'], summary: toolSummary(c['name'], c['input'], cwd) })
      }
    }
    return out
  }
  if (type === 'user' && isObj(o['message']) && Array.isArray(o['message']['content'])) {
    const out: ChatEvent[] = []
    for (const c of o['message']['content']) {
      if (isObj(c) && c['type'] === 'tool_result' && typeof c['tool_use_id'] === 'string') {
        out.push({ t: 'tool_end', id: c['tool_use_id'], ok: c['is_error'] !== true, tail: tailOf(resultText(c['content'])) })
      }
    }
    return out // 사용자 글('[Request interrupted by user]' 등)은 앱이 보낸 것만 user 이벤트로 남긴다
  }
  if (type === 'control_request' && typeof o['request_id'] === 'string' && isObj(o['request'])) {
    const r = o['request']
    if (r['subtype'] !== 'can_use_tool' || typeof r['tool_name'] !== 'string') return []
    const id = o['request_id']
    if (r['tool_name'] === 'AskUserQuestion') {
      const qs = isObj(r['input']) && Array.isArray(r['input']['questions']) ? r['input']['questions'] : []
      const questions: ChatQuestion[] = qs.filter(isObj).map((q) => ({
        question: str(q['question']),
        header: str(q['header']),
        multi: q['multiSelect'] === true,
        options: (Array.isArray(q['options']) ? q['options'] : []).filter(isObj).map((op) => ({ label: str(op['label']), description: str(op['description']) })),
      }))
      return [{ t: 'question', id, questions }]
    }
    const blocked = typeof r['blocked_path'] === 'string' ? r['blocked_path'] : undefined
    return [
      {
        t: 'permission',
        id,
        tool: r['tool_name'],
        summary: toolSummary(r['tool_name'], r['input'], cwd),
        why: clip(str(r['description']), 200),
        danger: isDangerousTool(r['tool_name'], r['input'], cwd, blocked),
      },
    ]
  }
  if (type === 'rate_limit_event' && isObj(o['rate_limit_info'])) {
    const info = o['rate_limit_info']
    // 거절 모양은 재현 못 함(2026-11-11) — 'allowed' 계열이 아니면 한도로 본다
    if (typeof info['status'] !== 'string' || info['status'].startsWith('allowed')) return []
    return [
      {
        t: 'error',
        kind: 'limit',
        message: str(info['rateLimitType']),
        ...(typeof info['resetsAt'] === 'number' ? { resetsAt: info['resetsAt'] * 1000 } : {}),
      },
    ]
  }
  if (type === 'result') {
    const reason = str(o['terminal_reason']) || str(o['subtype'])
    if (reason === 'aborted_streaming') return [{ t: 'stopped' }]
    const ms = typeof o['duration_ms'] === 'number' ? o['duration_ms'] : 0
    const pct = ctxPercent(o)
    return [{ t: 'turn_end', ok: o['is_error'] !== true, ms, reason, ...(pct !== undefined ? { ctxPct: pct } : {}) }]
  }
  return []
}

/** 허락 방식 → CLI 인자. 사용자 Claude 설정 파일은 건드리지 않는다 */
export function chatPermissionArgs(p: ChatPermission): string[] {
  return ['--permission-mode', (CHAT_PERMISSIONS.find((x) => x.id === p) ?? CHAT_PERMISSIONS[0]!).mode]
}
export function permissionMode(p: ChatPermission): string {
  return chatPermissionArgs(p)[1]!
}

export function claudeArgs(p: ChatPermission, sessionId?: string): string[] {
  return [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-prompt-tool',
    'stdio',
    ...chatPermissionArgs(p),
    ...(sessionId ? ['--resume', sessionId] : []),
  ]
}

/** 화면 · 디스크로 가는 사본 — 글 · 명령 · 결과 · 질문의 비밀값을 가린다 */
export function redactEvent(ev: ChatEvent, opts: SecretOptions = {}): ChatEvent {
  const r = (s: string) => redact(s, opts)
  switch (ev.t) {
    case 'user':
    case 'text':
      return { ...ev, text: r(ev.text) }
    case 'tool':
      return { ...ev, summary: r(ev.summary) }
    case 'tool_end':
      return { ...ev, tail: r(ev.tail) }
    case 'permission':
      return { ...ev, summary: r(ev.summary), why: r(ev.why) }
    case 'question':
      return { ...ev, questions: ev.questions.map((q) => ({ ...q, question: r(q.question), header: r(q.header), options: q.options.map((o) => ({ label: r(o.label), description: r(o.description) })) })) }
    case 'error':
      return { ...ev, message: r(ev.message) }
    default:
      return ev
  }
}

// ─── 화면 블록 ─────────────────────────────────────────────

export interface ToolItem {
  id: string
  name: string
  summary: string
  state: 'run' | 'ok' | 'err'
  tail: string
}
export type ChatBlock =
  | { kind: 'user'; key: string; text: string }
  | { kind: 'text'; key: string; text: string }
  | { kind: 'tools'; key: string; items: ToolItem[] }
  | { kind: 'permission'; key: string; id: string; tool: string; summary: string; why: string; danger: boolean; answer: AnswerHow | null }
  | { kind: 'question'; key: string; id: string; questions: ChatQuestion[]; answer: AnswerHow | null }
  | { kind: 'band'; key: string; tone: 'err' | 'warn'; error: ErrorKind | 'fail'; message: string; code?: number; resetsAt?: number; ms?: number }
  | { kind: 'done'; key: string; ms: number }
  | { kind: 'stopped'; key: string }

/** 이벤트 → 화면 블록. 이어진 도구는 한 묶음, 카드는 답으로 굳고, 답 없이 끝나면 'lost' */
export function foldBlocks(events: readonly ChatEvent[]): ChatBlock[] {
  const out: ChatBlock[] = []
  const toolAt = new Map<string, ToolItem>()
  const cards = new Map<string, ChatBlock & { answer: AnswerHow | null }>()
  let turnHadError = false
  const loseOpenCards = () => {
    for (const c of cards.values()) if (c.answer === null) c.answer = 'lost'
  }
  events.forEach((ev, i) => {
    const key = String(i)
    switch (ev.t) {
      case 'user':
        turnHadError = false
        out.push({ kind: 'user', key, text: ev.text })
        break
      case 'text':
        out.push({ kind: 'text', key, text: ev.text })
        break
      case 'tool': {
        const item: ToolItem = { id: ev.id, name: ev.name, summary: ev.summary, state: 'run', tail: '' }
        toolAt.set(ev.id, item)
        const last = out[out.length - 1]
        if (last?.kind === 'tools') last.items.push(item)
        else out.push({ kind: 'tools', key, items: [item] })
        break
      }
      case 'tool_end': {
        const item = toolAt.get(ev.id)
        if (item) {
          item.state = ev.ok ? 'ok' : 'err'
          item.tail = ev.tail
        }
        break
      }
      case 'permission': {
        const b = { kind: 'permission' as const, key, id: ev.id, tool: ev.tool, summary: ev.summary, why: ev.why, danger: ev.danger, answer: null }
        cards.set(ev.id, b)
        out.push(b)
        break
      }
      case 'question': {
        const b = { kind: 'question' as const, key, id: ev.id, questions: ev.questions, answer: null }
        cards.set(ev.id, b)
        out.push(b)
        break
      }
      case 'answered': {
        const c = cards.get(ev.id)
        if (c && c.answer === null) c.answer = ev.how
        break
      }
      case 'error':
        turnHadError = true
        if (ev.kind === 'crash' || ev.kind === 'missing') loseOpenCards()
        out.push({
          kind: 'band',
          key,
          tone: ev.kind === 'crash' || ev.kind === 'limit' || ev.kind === 'other' ? 'err' : 'warn',
          error: ev.kind,
          message: ev.message,
          ...(ev.code !== undefined ? { code: ev.code } : {}),
          ...(ev.resetsAt !== undefined ? { resetsAt: ev.resetsAt } : {}),
        })
        break
      case 'turn_end':
        loseOpenCards()
        if (ev.ok) out.push({ kind: 'done', key, ms: ev.ms })
        else if (!turnHadError) out.push({ kind: 'band', key, tone: 'err', error: 'fail', message: ev.reason, ms: ev.ms })
        break
      case 'stopped':
        loseOpenCards()
        for (const t of toolAt.values()) if (t.state === 'run') t.state = 'err'
        out.push({ kind: 'stopped', key })
        break
      case 'session':
        break
    }
  })
  return out
}

export type ChatState = 'new' | 'run' | 'wait' | 'done' | 'fail' | 'stopped'
export interface ChatStatus {
  state: ChatState
  /** 실행 중이면 마지막으로 보낸 시각 */
  since?: number
  /** 끝났으면 걸린 시간 */
  ms?: number
}

/** 머리 칩 · 사이드바 활동에 쓰는 지금 상태 */
export function chatStatus(events: readonly ChatEvent[]): ChatStatus {
  const open = new Set<string>()
  let last: ChatStatus = { state: 'new' }
  for (const ev of events) {
    switch (ev.t) {
      case 'user':
        last = { state: 'run', since: ev.at }
        break
      case 'permission':
      case 'question':
        open.add(ev.id)
        break
      case 'answered':
        open.delete(ev.id)
        break
      case 'turn_end':
        open.clear()
        last = ev.ok ? { state: 'done', ms: ev.ms } : { state: 'fail', ms: ev.ms }
        break
      case 'error':
        if (ev.kind === 'crash' || ev.kind === 'missing') open.clear()
        last = { state: 'fail' }
        break
      case 'stopped':
        open.clear()
        last = { state: 'stopped' }
        break
    }
  }
  if (open.size > 0) return { state: 'wait', ...(last.since !== undefined ? { since: last.since } : {}) }
  return last
}

/** 가짜 · 진짜 에이전트에 보낼 사용자 글 한 줄 */
export function claudeUserLine(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })
}
export function claudeControlLine(requestId: string, request: Obj): string {
  return JSON.stringify({ type: 'control_request', request_id: requestId, request })
}
export function claudeAnswerLine(requestId: string, response: Obj): string {
  return JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })
}
