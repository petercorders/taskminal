// Codex app-server 하나(대화 pane 하나)를 감싼다 (22단계) — 줄마다 JSON-RPC(`"jsonrpc"` 칸 없음, 스파이크로 확인).
// 시작: initialize → initialized → account/read(로그인 없으면 막음) → thread/start | thread/resume | thread/fork → turn/start.
// 서버가 묻는 요청(명령 · 파일 승인 · 질문)은 대기 목록에 두고 창의 답으로 돌려준다. 모양: src/shared/chat.ts 의 codex* 함수
import {
  codexCtxPercent,
  codexNoteToEvents,
  codexPolicy,
  codexRequestToEvents,
  type ChatDecision,
  type ChatEvent,
  type ChatImage,
  type ChatPermission,
} from '../../shared/chat'
import { isObj, type Obj } from '../../shared/guards'
import type { ChildLike, SpawnFn } from './claude-adapter'
import type { AgentSession } from './session'

export interface CodexSessionOptions {
  bin: string
  env: Record<string, string>
  cwd: string
  permission: ChatPermission
  /** 이어 할 스레드 id */
  sessionId?: string
  /** 되감기 · 나누기 뒤 — 다음 띄울 때 이 turn 까지 남긴 새 스레드로 갈라진다 */
  forkAt?: string
  spawn: SpawnFn
  /** 그림을 파일로 — codex 는 localImage 경로로 받는다 */
  saveImage(img: ChatImage, n: number): Promise<string>
  onEvent(ev: ChatEvent): void
  onExit(): void
  clientVersion?: string
}

interface Call {
  resolve(v: unknown): void
  reject(e: Error): void
}
interface Pending {
  method: string
  rpcId: number | string
  params: Obj
  key: string
  danger: boolean
}

const STDERR_KEEP = 2000

class RpcError extends Error {}

export class CodexSession implements AgentSession {
  private child: ChildLike | null = null
  /** 띄울 때마다 +1 — 옛 프로세스의 늦은 줄 · exit · 응답을 버린다 */
  private gen = 0
  private buf = ''
  private stderr = ''
  private nextId = 0
  private calls = new Map<number, Call>()
  private pending = new Map<string, Pending>()
  /** '이 명령만 늘 허락' — 같은 명령의 다음 승인 요청은 앱이 바로 accept (이 대화 동안) */
  private always = new Set<string>()
  private threadId: string | undefined
  private turnId: string | undefined
  private ctxPct: number | undefined
  private images = 0
  /** turn/start 답(턴 id)이 오기 전에 누른 멈춤 — 턴 id 를 받으면 바로 보낸다 */
  private interruptWanted = false
  busy = false
  private stopping = false

  constructor(private o: CodexSessionOptions) {}

  get running(): boolean {
    return this.child !== null
  }

  private start(): void {
    const gen = ++this.gen
    this.buf = ''
    this.stderr = ''
    this.threadId = undefined
    const args=this.o.env['TASKMINAL_ACCOUNT_ISOLATED']==='1'?['app-server','-c','cli_auth_credentials_store="file"']:['app-server']
    const child = this.o.spawn(this.o.bin, args, { cwd: this.o.cwd, env: this.o.env })
    this.child = child
    child.stdin?.on?.('error', () => {}) // EPIPE — 끝남은 exit 가 알린다
    child.stdout?.on('data', (d: Buffer | string) => gen === this.gen && this.onData(String(d)))
    child.stderr?.on('data', (d: Buffer | string) => {
      if (gen === this.gen) this.stderr = (this.stderr + String(d)).slice(-STDERR_KEEP)
    })
    child.on('error', (err) => gen === this.gen && this.ended(null, err.message))
    child.on('exit', (code) => gen === this.gen && this.ended(code, null))
  }

  private ended(code: number | null, err: string | null) {
    if (this.child === null) return
    this.child = null
    this.gen++
    this.pending.clear()
    for (const c of this.calls.values()) c.reject(new RpcError('codex 가 끝났어요'))
    this.calls.clear()
    if (this.busy && !this.stopping) {
      // stderr 는 로그 색 코드가 섞인다 — 걷어 내고 마지막 두 줄만
      const tail = this.stderr.replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n').slice(-2).join(' ')
      const msg = (err ?? tail) || 'Codex 가 갑자기 끝났어요'
      this.o.onEvent({ t: 'error', kind: 'crash', message: msg.slice(0, 300), ...(code !== null ? { code } : {}) })
    } else if (this.busy) {
      this.o.onEvent({ t: 'stopped' })
    }
    this.busy = false
    this.stopping = false
    this.turnId = undefined
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

  private write(o: Obj): boolean {
    const stdin = this.child?.stdin
    if (!stdin) return false
    try {
      return stdin.write(JSON.stringify(o) + '\n') || true
    } catch {
      return false
    }
  }

  private call(method: string, params: Obj): Promise<Obj> {
    const id = ++this.nextId
    return new Promise<Obj>((resolve, reject) => {
      this.calls.set(id, { resolve: (v) => resolve(isObj(v) ? v : {}), reject })
      if (!this.write({ id, method, params })) {
        this.calls.delete(id)
        reject(new RpcError('codex 에 보내지 못했어요'))
      }
    })
  }

  private onLine(line: string) {
    let o: unknown
    try {
      o = JSON.parse(line)
    } catch {
      return
    }
    if (!isObj(o)) return
    const method = typeof o['method'] === 'string' ? o['method'] : null
    const id = typeof o['id'] === 'number' || typeof o['id'] === 'string' ? o['id'] : null
    if (!method && typeof id === 'number') {
      const c = this.calls.get(id)
      this.calls.delete(id)
      if (!c) return
      if (isObj(o['error'])) c.reject(new RpcError(String(o['error']['message'] ?? 'codex 오류')))
      else c.resolve(o['result'])
      return
    }
    if (!method) return
    const params: Obj = isObj(o['params']) ? o['params'] : {}
    // 다른 스레드(되감기 전 옛 스레드 · 나눈 스레드)의 늦은 알림 · 요청은 버린다
    const tid = params['threadId']
    if (typeof tid === 'string' && this.threadId && tid !== this.threadId) {
      if (id !== null) this.write({ id, error: { code: -32000, message: 'stale thread' } })
      return
    }
    if (id !== null) return this.onRequest(method, id, params)
    if (method === 'thread/tokenUsage/updated') this.ctxPct = codexCtxPercent(params) ?? this.ctxPct
    const events = codexNoteToEvents(method, params, this.o.cwd, this.ctxPct !== undefined ? { ctxPct: this.ctxPct } : {})
    for (const ev of events) {
      if (ev.t === 'turn_end' || ev.t === 'stopped') {
        this.busy = false
        this.stopping = false
        this.turnId = undefined
        this.pending.clear()
      }
      this.o.onEvent(ev)
    }
  }

  private onRequest(method: string, rpcId: number | string, params: Obj) {
    const events = codexRequestToEvents(method, rpcId, params, this.o.cwd)
    const ev = events[0]
    if (!ev || (ev.t !== 'permission' && ev.t !== 'question')) {
      // 모르는 요청 — 답이 없으면 codex 가 기다리며 멈춘다
      this.write({ id: rpcId, error: { code: -32601, message: `Taskminal 이 모르는 요청: ${method}` } })
      return
    }
    const key = `${ev.t === 'permission' ? ev.tool : 'q'}\0${ev.t === 'permission' ? ev.summary : ''}`
    const danger = ev.t === 'permission' && ev.danger
    if (ev.t === 'permission' && this.always.has(key)) {
      this.write({ id: rpcId, result: { decision: 'accept' } })
      return
    }
    this.pending.set(ev.id, { method, rpcId, params, key, danger })
    this.o.onEvent(ev)
  }

  send(text: string, images: readonly ChatImage[] = []): boolean {
    if (this.busy) return false
    this.busy = true
    this.stopping = false
    this.interruptWanted = false
    void this.run(text, images)
    return true
  }

  private async run(text: string, images: readonly ChatImage[]) {
    const gen = this.child ? this.gen : this.gen + 1
    try {
      if (!this.child) {
        this.start()
        await this.call('initialize', { clientInfo: { name: 'taskminal', title: 'Taskminal', version: this.o.clientVersion ?? '0' }, capabilities: null })
        this.write({ method: 'initialized', params: {} })
        // 로그인이 없으면 turn/start 가 401 을 다시 시도하며 15초쯤 걸린다(스파이크) — 먼저 막는다. 띄울 때마다 다시 본다(로그인한 뒤 다시 시도하면 바로)
        const acc = await this.call('account/read', { refreshToken: false })
        if (acc['account'] == null && acc['requiresOpenaiAuth'] === true) {
          if (gen !== this.gen) return
          this.busy = false
          this.o.onEvent({ t: 'error', kind: 'login', message: 'codex login 이 필요해요' })
          this.kill()
          return
        }
        const pol = codexPolicy(this.o.permission)
        const base = { cwd: this.o.cwd, approvalPolicy: pol.approvalPolicy, sandbox: pol.sandbox }
        let r: Obj
        if (this.o.sessionId && this.o.forkAt) r = await this.call('thread/fork', { threadId: this.o.sessionId, lastTurnId: this.o.forkAt, ...base, excludeTurns: true })
        else if (this.o.sessionId) r = await this.call('thread/resume', { threadId: this.o.sessionId, ...base, excludeTurns: true })
        else r = await this.call('thread/start', base)
        if (gen !== this.gen) return
        const th = isObj(r['thread']) ? r['thread'] : {}
        if (typeof th['id'] !== 'string') throw new RpcError('스레드를 열지 못했어요')
        this.threadId = th['id']
        this.o.sessionId = th['id']
        delete this.o.forkAt
        this.o.onEvent({ t: 'session', id: th['id'], ...(typeof th['model'] === 'string' ? { model: th['model'] } : {}) })
      }
      const input: Obj[] = [{ type: 'text', text, text_elements: [] }]
      for (const im of images) input.push({ type: 'localImage', path: await this.o.saveImage(im, ++this.images) })
      if (gen !== this.gen) return
      const r = await this.call('turn/start', { threadId: this.threadId, input, approvalPolicy: codexPolicy(this.o.permission).approvalPolicy })
      if (gen !== this.gen) return
      const turn = isObj(r['turn']) ? r['turn'] : {}
      if (typeof turn['id'] === 'string' && this.busy) {
        this.turnId = turn['id']
        if (this.interruptWanted) this.interrupt()
      }
    } catch (e) {
      if (gen !== this.gen || !this.busy) return // 프로세스가 끝났다 — ended 가 알렸다
      this.busy = false
      this.interruptWanted = false
      // 스레드를 못 열었으면 프로세스를 떼어 낸다 — 남겨 두면 다음 보내기가 준비를 건너뛰고 스레드 없이 turn/start 를 보낸다(리뷰)
      if (!this.threadId) this.detach()
      this.o.onEvent({ t: 'error', kind: 'other', message: e instanceof Error ? e.message.slice(0, 300) : 'codex 오류' })
    }
  }

  answer(requestId: string, d: ChatDecision): boolean {
    const p = this.pending.get(requestId)
    if (!p) return false
    this.pending.delete(requestId)
    let result: Obj
    if (p.method === 'item/tool/requestUserInput') {
      if (d.how !== 'answer') {
        result = { answers: {} }
      } else {
        // 창은 (가린) 질문 글을 키로 보낸다 — 질문 순서대로 id 에 되돌린다
        const vals = Object.values(d.answers)
        const qs = Array.isArray(p.params['questions']) ? p.params['questions'].filter(isObj) : []
        const answers: Obj = {}
        qs.forEach((q, i) => {
          const k = typeof q['question'] === 'string' ? q['question'] : ''
          const v = d.answers[k] ?? vals[i]
          if (typeof q['id'] === 'string' && v !== undefined) answers[q['id']] = { answers: Array.isArray(v) ? v : [v] }
        })
        result = { answers }
      }
    } else {
      if (d.how === 'always' && !p.danger) this.always.add(p.key) // 위험한 것은 창이 무엇을 보내도 이번 한 번만
      // 거절 이유 글을 실을 칸이 승인 답에 없다 — 입력창의 글은 창이 다음 턴으로 보낸다
      result = { decision: d.how === 'deny' ? 'decline' : 'accept' }
    }
    this.write({ id: p.rpcId, result })
    this.o.onEvent({ t: 'answered', id: requestId, how: d.how })
    return true
  }

  interrupt(): boolean {
    if (!this.busy) return false
    this.stopping = true
    if (!this.child || !this.threadId || !this.turnId) {
      this.interruptWanted = true // 아직 띄우는 중 · 턴 id 를 못 받음 — 받으면 멈춘다(리뷰)
      return true
    }
    this.interruptWanted = false
    void this.call('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }).catch(() => {})
    return true
  }

  setPermission(p: ChatPermission) {
    this.o.permission = p // 턴마다 approvalPolicy 로 보낸다 — 다음 턴부터
  }

  fork(sessionId: string | undefined, at: string | null) {
    this.detach()
    this.o.sessionId = at ? sessionId : undefined
    if (at) this.o.forkAt = at
    else delete this.o.forkAt
  }

  /** 떠 있는 프로세스를 바로 떼어 내고(세대 +1) 끝낸다 */
  private detach() {
    const c = this.child
    this.child = null
    this.gen++
    this.busy = false
    this.stopping = false
    this.interruptWanted = false
    this.turnId = undefined
    this.threadId = undefined
    this.pending.clear()
    for (const x of this.calls.values()) x.reject(new RpcError('끝냄'))
    this.calls.clear()
    if (c) {
      try {
        c.stdin?.end()
      } catch {
        /* 이미 닫힘 */
      }
      c.kill('SIGTERM')
    }
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
