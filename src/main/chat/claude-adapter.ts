// Claude CLI 하나(대화 pane 하나)를 감싼다 — 띄우기 · 줄 나누기 · 보내기 · 허락/질문 답 · 멈춤 · 끝내기.
// spawn 을 주입해 단위 시험한다. 이벤트 모양은 src/shared/chat.ts
import type { EventEmitter } from 'node:events'
import {
  claudeAnswerLine,
  claudeArgs,
  claudeControlLine,
  claudeLineToEvents,
  claudeUserLine,
  permissionMode,
  type ChatDecision,
  type ChatEvent,
  type ChatPermission,
} from '../../shared/chat'
import { isObj } from '../../shared/guards'

export interface ChildLike {
  stdin: { write(s: string): boolean; end(): void } | null
  stdout: EventEmitter | null
  stderr: EventEmitter | null
  on(ev: 'exit', fn: (code: number | null, signal: string | null) => void): unknown
  on(ev: 'error', fn: (err: Error) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}
export type SpawnFn = (bin: string, args: string[], opts: { cwd: string; env: Record<string, string> }) => ChildLike

export type Decision = ChatDecision

interface Pending {
  tool: string
  input: unknown
  key: string
}

export interface ClaudeSessionOptions {
  bin: string
  env: Record<string, string>
  cwd: string
  permission: ChatPermission
  sessionId?: string
  spawn: SpawnFn
  /** 원래 모양의 이벤트 — 가리기는 받는 쪽(manager)이 한다 */
  onEvent(ev: ChatEvent): void
  /** 프로세스가 끝났다 (세대가 지난 것은 부르지 않는다) */
  onExit(): void
}

const STDERR_KEEP = 2000

export class ClaudeSession {
  private child: ChildLike | null = null
  /** 띄울 때마다 +1 — 옛 프로세스의 늦은 줄 · exit 를 버린다 */
  private gen = 0
  private buf = ''
  private stderr = ''
  private pending = new Map<string, Pending>()
  /** '이 명령만 늘 허락' 한 것 (이 대화 동안) */
  private always = new Set<string>()
  private seq = 0
  /** 턴이 열려 있다 (보냈고 result · 멈춤을 아직 못 받음) */
  busy = false
  private stopping = false

  constructor(private o: ClaudeSessionOptions) {}

  get running(): boolean {
    return this.child !== null
  }

  private start(): ChildLike {
    const gen = ++this.gen
    this.buf = ''
    this.stderr = ''
    const child = this.o.spawn(this.o.bin, claudeArgs(this.o.permission, this.o.sessionId), { cwd: this.o.cwd, env: this.o.env })
    this.child = child
    child.stdout?.on('data', (d: Buffer | string) => gen === this.gen && this.onData(String(d)))
    child.stderr?.on('data', (d: Buffer | string) => {
      if (gen === this.gen) this.stderr = (this.stderr + String(d)).slice(-STDERR_KEEP)
    })
    child.on('error', (err) => gen === this.gen && this.ended(null, err.message))
    child.on('exit', (code) => gen === this.gen && this.ended(code, null))
    return child
  }

  private ended(code: number | null, err: string | null) {
    if (this.child === null) return
    this.child = null
    this.gen++ // 같은 프로세스의 error + exit 가 두 번 오지 않게
    this.pending.clear()
    if (this.busy && !this.stopping) {
      const msg = (err ?? this.stderr.trim().split('\n').slice(-2).join(' ')) || 'Claude 가 갑자기 끝났어요'
      this.o.onEvent({ t: 'error', kind: 'crash', message: msg.slice(0, 300), ...(code !== null ? { code } : {}) })
    } else if (this.busy) {
      this.o.onEvent({ t: 'stopped' })
    }
    this.busy = false
    this.stopping = false
    this.o.onExit()
  }

  private onData(chunk: string) {
    this.buf += chunk
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (line) this.onLine(line)
    }
  }

  private onLine(line: string) {
    let o: unknown
    try {
      o = JSON.parse(line)
    } catch {
      return
    }
    if (!isObj(o)) return
    if (o['type'] === 'system' && o['subtype'] === 'init' && typeof o['session_id'] === 'string') this.o.sessionId = o['session_id']
    if (o['type'] === 'control_request' && typeof o['request_id'] === 'string' && isObj(o['request']) && o['request']['subtype'] === 'can_use_tool') {
      const r = o['request']
      const tool = typeof r['tool_name'] === 'string' ? r['tool_name'] : ''
      const key = alwaysKey(tool, r['input'])
      if (tool !== 'AskUserQuestion' && this.always.has(key)) {
        this.write(claudeAnswerLine(o['request_id'], { behavior: 'allow', updatedInput: r['input'] ?? {} }))
        return
      }
      this.pending.set(o['request_id'], { tool, input: r['input'] ?? {}, key })
    }
    const events = claudeLineToEvents(o, this.o.cwd)
    for (const ev of events) {
      if (ev.t === 'turn_end' || ev.t === 'stopped') {
        this.busy = false
        this.stopping = false
        this.pending.clear()
      }
      this.o.onEvent(ev)
    }
  }

  private write(line: string): boolean {
    const stdin = this.child?.stdin
    if (!stdin) return false
    try {
      return stdin.write(line + '\n') || true
    } catch {
      return false
    }
  }

  /** 새 턴을 보낸다. 턴이 열려 있으면 false (한 번에 하나) */
  send(text: string): boolean {
    if (this.busy) return false
    if (!this.child) this.start()
    this.busy = true
    this.stopping = false
    if (!this.write(claudeUserLine(text))) {
      this.busy = false
      return false
    }
    return true
  }

  /** 허락 · 질문 답. 같은 요청에 두 번 오거나, 그 사이 프로세스가 끝났으면 false 로 버린다 */
  answer(requestId: string, d: Decision): boolean {
    const p = this.pending.get(requestId)
    if (!p) return false
    this.pending.delete(requestId)
    let response: Record<string, unknown>
    if (d.how === 'answer') {
      response = { behavior: 'allow', updatedInput: { ...(isObj(p.input) ? p.input : {}), answers: d.answers } }
    } else if (d.how === 'deny') {
      response = { behavior: 'deny', message: d.message?.trim() || '사용자가 거절했어요. 다른 방법을 써 주세요.' }
    } else {
      if (d.how === 'always') this.always.add(p.key)
      response = { behavior: 'allow', updatedInput: p.input }
    }
    this.write(claudeAnswerLine(requestId, response))
    this.o.onEvent({ t: 'answered', id: requestId, how: d.how })
    return true
  }

  interrupt(): boolean {
    if (!this.child || !this.busy) return false
    this.stopping = true
    return this.write(claudeControlLine(`int-${++this.seq}`, { subtype: 'interrupt' }))
  }

  /** 허락 방식 — 떠 있으면 지금 바꾸고(스파이크로 확인한 set_permission_mode), 아니면 다음 띄울 때 인자로 */
  setPermission(p: ChatPermission) {
    this.o.permission = p
    if (this.child) this.write(claudeControlLine(`mode-${++this.seq}`, { subtype: 'set_permission_mode', mode: permissionMode(p) }))
  }

  setSessionId(id: string | undefined) {
    if (!this.child) this.o.sessionId = id
  }

  kill() {
    const c = this.child
    if (!c) return
    this.stopping = true
    try {
      c.stdin?.end()
    } catch {
      /* 이미 닫힘 */
    }
    c.kill('SIGTERM')
  }
}

function alwaysKey(tool: string, input: unknown): string {
  const i = isObj(input) ? input : {}
  const what = typeof i['command'] === 'string' ? i['command'] : typeof i['file_path'] === 'string' ? i['file_path'] : JSON.stringify(i)
  return `${tool}\0${what}`
}
