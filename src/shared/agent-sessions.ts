// 53단계: 밖에서 시작한 에이전트 세션(~/.claude/projects · ~/.codex/sessions) 기록 · 이어 하기.
// 순수 함수만 — 파일 읽기는 main/agent-sessions.ts, 화면은 renderer/AgentSessionsPanel.tsx.
import type { ChatAgent } from './chat'
import { isObj, type Obj } from './guards'

/** 파일마다 앞에서 읽는 양 — 큰 대화도 머리만 본다 */
export const HEAD_BYTES = 256 * 1024
/** 목록에 보이는 첫 글 길이 (가린 뒤) */
export const SUMMARY_MAX = 160
/** 공급자마다 목록에 넣는 최신 세션 수 */
export const PER_AGENT = 300
/** '연결하는 중…' · 목록 읽기 한도 */
export const DEADLINE_MS = 15_000
/** 가리기 전에 남겨 두는 원문 길이 — 여러 줄 비밀값(개인 키)이 잘리지 않을 만큼 */
const RAW_TEXT_MAX = 8192

export interface AgentSession {
  agent: ChatAgent
  /** Claude session_id · Codex thread id (UUID) */
  id: string
  cwd: string
  /** 첫 사용자 글 — 가린 뒤 공백을 접어 160자 */
  summary: string
  startedAt: number
  /** 파일 수정 시각 = 마지막 시각 */
  updatedAt: number
  /** 'default-claude' · 'default-codex' · 추가 계정 id */
  account: string
  accountName?: string
}

export interface AgentSessionList {
  sessions: AgentSession[]
  /** 빈 파일 · 세션이 아닌 파일 · 읽지 못한 파일 */
  skipped: number
  /** 읽은 앞부분에서 해석하지 못한 줄 */
  badLines: number
  /** 목록에서 뺀 Codex 하위 에이전트 기록 */
  subagents: number
  /** 렌더러가 일감 폴더의 '~' 를 펴는 데 쓴다 */
  home: string
  at: number
}

export type ResumeHow = 'chat' | 'terminal'
/** renderer → main: 경로 없이 id 만 — main 이 다시 찾는다 */
export interface AgentSessionRequest {
  agent: ChatAgent
  id: string
  /** renderer 가 만들 pane id — 추가 계정이면 main 이 이 pane 을 그 계정에 묶는다 */
  paneId: string
  how: ResumeHow
}
export interface AgentSessionTarget {
  agent: ChatAgent
  sessionId: string
  cwd: string
  account: string
  /** 같은 세션을 동시에 두 번 부르면 첫 요청의 pane — 다르면 renderer 는 만들지 않는다 */
  paneId: string
  how: ResumeHow
}
export interface AgentSessionOpen extends AgentSessionTarget {
  /** how === 'terminal' 일 때 셸에 칠 명령 */
  command?: string
}
export interface AgentSessionsApi {
  list(): Promise<AgentSessionList>
  open(request: AgentSessionRequest): Promise<AgentSessionOpen>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** 세션 id 는 UUID 모양만 — 터미널 시작 명령에 그대로 들어가므로 셸 글자를 막는다 */
export const isSessionId = (v: unknown): v is string => typeof v === 'string' && UUID.test(v)
export const isResumeHow = (v: unknown): v is ResumeHow => v === 'chat' || v === 'terminal'

/** 터미널로 이어 하기 명령 — bin 은 main 이 정한 실행 파일(추가 계정이면 env 앞붙임) */
export function resumeCommand(agent: ChatAgent, id: string, bin: string): string {
  if (!isSessionId(id)) throw new Error('잘못된 세션이에요')
  return agent === 'codex' ? `${bin} resume ${id}` : `${bin} --resume ${id}`
}

export interface HeadSession {
  id: string
  cwd: string
  /** 첫 사용자 글 원문 조각 (가리기 전) — '' 이면 앞부분에 없음 */
  text: string
  startedAt: number
}
export type HeadResult =
  | { kind: 'session'; session: HeadSession; badLines: number }
  | { kind: 'skip'; badLines: number }
  | { kind: 'subagent'; badLines: number }

type Row = Obj

/** 줄마다 JSON — 손상 줄은 세고 건너뛴다. 앞부분만 읽었으면(truncated) 마지막 반쪽 줄은 버린다.
 *  끝까지 읽었는데 마지막 줄만 안 맞으면 쓰는 중일 수 있어 손상으로 세지 않는다. */
function rows(text: string, truncated: boolean): { rows: Row[]; bad: number } {
  const parts = text.split('\n')
  if (truncated) parts.pop()
  const out: Row[] = []
  let bad = 0
  parts.forEach((part, i) => {
    if (!part.trim()) return
    try {
      const v: unknown = JSON.parse(part)
      if (isObj(v)) out.push(v)
      else bad++
    } catch {
      if (!truncated && i === parts.length - 1) return
      bad++
    }
  })
  return { rows: out, bad }
}

/** 에이전트가 넣은 맥락 글(<command-name> · <environment_context> · AGENTS.md)은 사용자 글이 아니다 */
const injected = (t: string) => /^\s*<[a-z][a-z0-9_-]*>/i.test(t) || /^\s*# AGENTS\.md instructions/.test(t)
const time = (v: unknown): number => {
  const n = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isFinite(n) ? n : 0
}
const absolute = (v: unknown): v is string => typeof v === 'string' && v.startsWith('/') && v.length <= 4096

/** 사용자 글에서 에이전트가 붙인 블록을 걷어 낸다 — 슬래시 명령은 '이름 인자'(인자가 없으면 command 로 따로) */
function userText(t: string): { text: string; command?: string } {
  const name = /<command-name>([^<]{1,200})<\/command-name>/.exec(t)
  if (name) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1]?.trim()
    return args ? { text: `${name[1]!.trim()} ${args}` } : { text: '', command: name[1]!.trim() }
  }
  let rest = t
  for (let m = /^\s*<([a-z][a-z0-9_-]*)>[\s\S]*?<\/\1>/i.exec(rest); m; m = /^\s*<([a-z][a-z0-9_-]*)>[\s\S]*?<\/\1>/i.exec(rest)) rest = rest.slice(m[0].length)
  return { text: injected(rest) ? '' : rest.trim() }
}

/** ~/.claude/projects/<폴더>/<세션 id>.jsonl 의 앞부분 — 첫 사용자 글이 없으면 사용자 제목 > 자동 제목 > 마지막 프롬프트 > 인자 없는 명령 */
export function parseClaudeHead(text: string, fileName: string, truncated: boolean): HeadResult {
  const { rows: list, bad } = rows(text, truncated)
  const id = fileName.replace(/\.jsonl$/, '')
  if (!isSessionId(id)) return { kind: 'skip', badLines: bad }
  let cwd: string | undefined
  let startedAt = 0
  let first: string | undefined
  const fallback: { custom?: string; ai?: string; last?: string; command?: string } = {}
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined)
  for (const row of list) {
    if (!startedAt) startedAt = time(row['timestamp'])
    if (!cwd && absolute(row['cwd'])) cwd = row['cwd']
    if (row['type'] === 'custom-title') fallback.custom ??= str(row['customTitle'])
    else if (row['type'] === 'ai-title') fallback.ai ??= str(row['aiTitle'])
    else if (row['type'] === 'last-prompt') fallback.last = str(row['lastPrompt']) ?? fallback.last
    if (first !== undefined || row['type'] !== 'user' || row['isMeta'] === true || row['isSidechain'] === true) continue
    const message = row['message']
    if (!isObj(message) || message['role'] !== 'user') continue
    const content = message['content']
    const t =
      typeof content === 'string'
        ? content
        : Array.isArray(content) && content.every((c) => isObj(c) && c['type'] !== 'tool_result')
          ? (content as Row[]).filter((c) => c['type'] === 'text' && typeof c['text'] === 'string').map((c) => c['text'] as string).join(' ')
          : ''
    const u = userText(t)
    if (u.text) first = u.text.slice(0, RAW_TEXT_MAX)
    else if (u.command) fallback.command ??= u.command
  }
  if (!cwd) return { kind: 'skip', badLines: bad }
  const shown = first ?? (fallback.custom ?? fallback.ai ?? fallback.last ?? fallback.command ?? '').slice(0, RAW_TEXT_MAX)
  return { kind: 'session', session: { id, cwd, text: shown, startedAt }, badLines: bad }
}

/** ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl 의 앞부분 — 첫 session_meta 가 이 파일의 세션 */
export function parseCodexHead(text: string, _fileName: string, truncated: boolean): HeadResult {
  const { rows: list, bad } = rows(text, truncated)
  let meta: Row | undefined
  let metaAt = 0
  let first: string | undefined
  for (const row of list) {
    const payload = row['payload']
    if (!isObj(payload)) continue
    if (!meta) {
      if (row['type'] !== 'session_meta') continue
      meta = payload
      metaAt = time(row['timestamp'])
      const source = payload['source']
      if (isObj(source) && 'subagent' in source) return { kind: 'subagent', badLines: bad }
      continue
    }
    let t = ''
    if (row['type'] === 'response_item' && payload['type'] === 'message' && payload['role'] === 'user' && Array.isArray(payload['content']))
      t = (payload['content'] as unknown[]).filter((c): c is Row => isObj(c) && c['type'] === 'input_text' && typeof c['text'] === 'string').map((c) => c['text'] as string).join(' ')
    else if (row['type'] === 'event_msg' && payload['type'] === 'user_message' && typeof payload['message'] === 'string') t = payload['message']
    if (t.trim() && !injected(t)) {
      first = t.slice(0, RAW_TEXT_MAX)
      break
    }
  }
  if (!meta || !isSessionId(meta['id']) || !absolute(meta['cwd'])) return { kind: 'skip', badLines: bad }
  return { kind: 'session', session: { id: meta['id'], cwd: meta['cwd'], text: first ?? '', startedAt: time(meta['timestamp']) || metaAt }, badLines: bad }
}

/** 가린 뒤 공백을 접고 160자 — 가리기를 먼저 해야 여러 줄 비밀값이 맞는다 */
export function summarize(text: string, redact: (t: string) => string): string {
  return redact(text).replace(/\s+/g, ' ').trim().slice(0, SUMMARY_MAX)
}

export interface SessionFilter {
  query: string
  agent: 'all' | ChatAgent
  /** task = 이 일감 폴더(와 그 안쪽) */
  scope: 'all' | 'task'
  folder: string | null
}

/** 찾기(요약 · 폴더) · 에이전트 · 범위 → 최신순 */
export function filterSessions(list: readonly AgentSession[], f: SessionFilter): AgentSession[] {
  const folder = f.folder && f.folder.length > 1 ? f.folder.replace(/\/+$/, '') : f.folder
  if (f.scope === 'task' && !folder) return []
  const q = f.query.trim().toLowerCase()
  return list
    .filter(
      (s) =>
        (f.agent === 'all' || s.agent === f.agent) &&
        (f.scope === 'all' || s.cwd === folder || s.cwd.startsWith(folder === '/' ? '/' : `${folder}/`)) &&
        (!q || s.summary.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q)),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
}

export function sessionAgo(at: number, now: number): string {
  const s = Math.max(0, now - at) / 1000
  if (s < 60) return '방금'
  if (s < 3600) return `${Math.floor(s / 60)}분 전`
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`
  if (s < 30 * 86400) return `${Math.floor(s / 86400)}일 전`
  return new Date(at).toLocaleDateString()
}

export type FeedResult<T> = { ok: true; value: T } | { ok: false; error: unknown }

/**
 * 목록 다시 읽기 제어 — 한 번에 하나만 돈다. 도는 중 요청은 하나로 모아 끝난 뒤 한 번 더,
 * 그동안 끝난 옛 응답은 버린다(세대 번호). 안 보일 때 요청은 미뤘다가 다시 보이면 한 번. 닫은 뒤 응답은 버린다.
 */
export class SessionFeed<T> {
  private gen = 0
  private running = false
  private again = false
  private visible = true
  private missed = false
  private disposed = false
  constructor(
    private readonly fetch: () => Promise<T>,
    private readonly deliver: (result: FeedResult<T>) => void,
  ) {}
  get busy(): boolean {
    return this.running
  }
  request(): void {
    if (this.disposed) return
    if (!this.visible) {
      this.missed = true
      return
    }
    this.gen++
    if (this.running) {
      this.again = true
      return
    }
    void this.run()
  }
  setVisible(visible: boolean): void {
    this.visible = visible
    if (visible && this.missed) {
      this.missed = false
      this.request()
    }
  }
  dispose(): void {
    this.disposed = true
    this.gen++
  }
  private async run(): Promise<void> {
    this.running = true
    const gen = this.gen
    let result: FeedResult<T>
    try {
      result = { ok: true, value: await this.fetch() }
    } catch (error) {
      result = { ok: false, error }
    }
    this.running = false
    if (!this.disposed && gen === this.gen) this.deliver(result)
    if (this.again && !this.disposed) {
      this.again = false
      void this.run()
    }
  }
}

/** 한도 안에 답이 없으면 오류 — 늦게 온 답은 버린다(그 뒤 아무것도 만들지 않게) */
export function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      reject(new Error(message))
    }, ms)
    promise.then(
      (value) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        if (done) return
        done = true
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
