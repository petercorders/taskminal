// 대화 pane 들의 주인 (main) — paneId 마다 Claude 프로세스 하나. 이벤트를 가려서 창 · 디스크로 보낸다.
import { homedir } from 'node:os'
import { chatStatus, redactEvent, rewindPlan, type ChatAgent, type ChatEvent, type ChatImage, type ChatPermission } from '../../shared/chat'
import { shellEnv } from '../../shared/pty'
import type { SecretOptions } from '../../shared/redact'
import type { AgentBin } from './find-bin'
import { ClaudeSession, type Decision, type SpawnFn } from './claude-adapter'
import { CodexSession } from './codex-adapter'
import type { AgentSession } from './session'
import type { ChatStore } from './chat-store'

export interface Sink {
  send(channel: string, ...args: unknown[]): void
  isDestroyed(): boolean
}

export interface ChatManagerDeps {
  store: Pick<ChatStore, 'append' | 'read' | 'remove' | 'replace' | 'saveImage'>
  redactOptions(): SecretOptions
  spawn: SpawnFn
  findBin(agent: ChatAgent): Promise<AgentBin | null>
  permission(): ChatPermission
  channel: string
  now?: () => number
  appVersion?: string
}

/** pane 의 대화 정보 (상태 파일의 Pane.chat) */
export interface ChatRef {
  agent: ChatAgent
  sessionId?: string
  /** 되감기 · 나누기 뒤 아직 보내지 않았다 — 다음 띄울 때 여기서 가른다 */
  forkAt?: string
}

export interface RewindResult {
  events: ChatEvent[]
  upTo: number
  forkAt: string | null
  /** 갈라질 세션 (forkAt 이 난 세션) */
  sessionId?: string
  refill: string | null
  masked: boolean
}

export type SendResult = 'ok' | 'busy' | 'missing'

interface Entry {
  s: AgentSession
  agent: ChatAgent
  sink: Sink
  /** close 뒤 — 늦게 오는 exit 의 '멈춤' 등을 기록하지 않는다(지운 대화 파일을 다시 만들지 않게) */
  closed?: boolean
}

/** claude 안에서 띄운 앱(개발 중)이면 중첩 실행 표시를 지운다 — 그대로 두면 claude 가 다른 동작을 할 수 있다 */
function agentEnv(base: NodeJS.ProcessEnv, path: string): Record<string, string> {
  const env = shellEnv(base)
  delete env['CLAUDECODE']
  delete env['CLAUDE_CODE_ENTRYPOINT']
  if (path) env['PATH'] = path
  return env
}

const expandHome = (p: string) => (p === '~' ? homedir() : p.startsWith('~/') ? homedir() + p.slice(1) : p)

export class ChatManager {
  private panes = new Map<string, Entry>()
  /** 보내는 중(실행 파일을 찾는 사이) — 그 사이 두 번째 보내기를 막는다 */
  private starting = new Set<string>()
  /** 실행 파일을 찾는 사이 닫힌 pane — 찾은 뒤 띄우지 않는다 */
  private cancelled = new Set<string>()
  /** pane 마다 보낸 이벤트 수 — 화면이 기록(history)과 실시간 이벤트를 겹치지도 빠뜨리지도 않게 맞춘다 */
  private counts = new Map<string, number>()
  constructor(private readonly d: ChatManagerDeps) {}

  /** 번호를 매겨 디스크에 덧붙인다 (가리기는 ChatStore) */
  private record(paneId: string, ev: ChatEvent): number {
    const n = (this.counts.get(paneId) ?? 0) + 1
    this.counts.set(paneId, n)
    void this.d.store.append(paneId, [ev]).catch(() => {})
    return n
  }

  private emit(paneId: string, sink: Sink, ev: ChatEvent) {
    const n = this.record(paneId, ev)
    if (!sink.isDestroyed()) sink.send(this.d.channel, paneId, redactEvent(ev, this.d.redactOptions()), n)
  }

  async send(sink: Sink, paneId: string, text: string, cwd: string, chat: ChatRef, images: readonly ChatImage[] = []): Promise<SendResult> {
    const have = this.panes.get(paneId)
    if (this.starting.has(paneId) || have?.s.busy) return 'busy'
    const now = this.d.now ?? Date.now
    const user: ChatEvent = { t: 'user', text, at: now(), ...(images.length ? { images: images.map((i) => i.name) } : {}) }
    // 사용자 글은 실제로 보낸 뒤 기록한다 — 못 보냈는데 기록하면 턴이 열린 채 남아 다시 보낼 수 없다.
    // 에이전트의 응답은 stdout 으로 늦게 오므로 이 순서여도 사용자 글이 먼저 기록된다.
    if (have) {
      have.sink = sink
      if (!have.s.send(text, images)) return 'busy'
      this.emit(paneId, sink, user)
      return 'ok'
    }
    this.starting.add(paneId)
    this.cancelled.delete(paneId)
    try {
      const found = await this.d.findBin(chat.agent)
      if (this.cancelled.delete(paneId)) return 'busy' // 찾는 사이 pane 이 닫혔다
      if (!found) {
        this.emit(paneId, sink, user)
        this.emit(paneId, sink, { t: 'error', kind: 'missing', message: `${chat.agent} 명령을 찾지 못했어요` })
        return 'missing'
      }
      const entry: Entry = { sink, agent: chat.agent, s: null as unknown as AgentSession }
      const common = {
        bin: found.bin,
        env: agentEnv(process.env, found.path),
        cwd: expandHome(cwd),
        permission: this.d.permission(),
        ...(chat.sessionId ? { sessionId: chat.sessionId } : {}),
        ...(chat.sessionId && chat.forkAt ? { forkAt: chat.forkAt } : {}),
        spawn: this.d.spawn,
        onEvent: (ev: ChatEvent) => {
          if (!entry.closed) this.emit(paneId, entry.sink, ev)
        },
        onExit: () => {},
      }
      entry.s =
        chat.agent === 'codex'
          ? new CodexSession({ ...common, saveImage: (img, n) => this.d.store.saveImage(paneId, img, n), ...(this.d.appVersion ? { clientVersion: this.d.appVersion } : {}) })
          : new ClaudeSession(common)
      this.panes.set(paneId, entry)
      if (!entry.s.send(text, images)) return 'busy'
      this.emit(paneId, sink, user)
      return 'ok'
    } finally {
      this.starting.delete(paneId)
    }
  }

  /**
   * 되감기 (22단계): 그 메시지 앞까지 기록을 잘라 쓰고, 다음 보내기가 앞 턴 끝에서 갈라진 세션으로 가게 한다.
   * index · at 으로 같은 메시지인지 다시 본다 — 확인 띠가 열린 사이 기록이 바뀌었으면 null(버림). 도는 중이면 null.
   */
  async rewind(paneId: string, index: number, at: number, chat: ChatRef): Promise<RewindResult | null> {
    const busy = () => this.starting.has(paneId) || this.panes.get(paneId)?.s.busy === true
    if (busy()) return null
    const events = await this.d.store.read(paneId)
    // 읽는 사이 보내기가 시작됐으면 그 턴을 잘라 내지 않게 다시 본다
    if (busy()) return null
    const i = userIndex(events, index, at)
    if (i < 0) return null
    const plan = rewindPlan(events, i, 'rewind')
    if (!plan) return null
    const kept = events.slice(0, plan.keep)
    await this.d.store.replace(paneId, kept)
    const sessionId = plan.forkAt ? (plan.sessionId ?? chat.sessionId) : undefined
    this.panes.get(paneId)?.s.fork(sessionId, plan.forkAt)
    return { events: kept, upTo: this.counts.get(paneId) ?? 0, forkAt: plan.forkAt, ...(sessionId ? { sessionId } : {}), refill: plan.refill, masked: plan.masked === true }
  }

  /** 나누기 (22단계): 그 메시지의 턴 끝까지를 새 pane 의 기록으로. 갈라질 자리(anchor)를 돌려준다 · 자리가 맞지 않으면 null */
  async branch(from: string, to: string, index: number, at: number): Promise<{ forkAt: string; sessionId?: string } | null> {
    const events = await this.d.store.read(from)
    const i = userIndex(events, index, at)
    if (i < 0) return null
    const plan = rewindPlan(events, i, 'branch')
    if (!plan || !plan.forkAt) return null
    await this.d.store.replace(to, events.slice(0, plan.keep))
    return { forkAt: plan.forkAt, ...(plan.sessionId ? { sessionId: plan.sessionId } : {}) }
  }

  answer(paneId: string, requestId: string, d: Decision): boolean {
    return this.panes.get(paneId)?.s.answer(requestId, d) ?? false
  }

  interrupt(paneId: string): boolean {
    return this.panes.get(paneId)?.s.interrupt() ?? false
  }

  setPermission(p: ChatPermission) {
    for (const e of this.panes.values()) e.s.setPermission(p)
  }

  /**
   * 화면 다시 그리기. 읽기는 저장 큐에서 그 앞의 덧붙이기 뒤에 돈다 → 지금까지 보낸 이벤트(upTo 번)가 모두 들어 있다.
   * 화면은 실시간 이벤트 중 번호가 upTo 보다 큰 것만 붙인다.
   */
  async history(paneId: string): Promise<{ events: ChatEvent[]; upTo: number }> {
    const upTo = this.counts.get(paneId) ?? 0 // 읽기 전에 — 읽는 사이 온 실시간 이벤트(번호 > upTo)를 화면이 붙인다
    const events = await this.d.store.read(paneId)
    // 떠 있는 프로세스가 없는데 턴이 열려 있다 = 앱이 턴 도중 끝났거나 죽었다(멈춤을 쓰기 전에) → 멈춤으로 닫는다.
    // 그대로 두면 화면이 '실행 중' 에 굳어 다시 보낼 수 없다.
    const st = chatStatus(events).state
    if (!this.panes.has(paneId) && !this.starting.has(paneId) && (st === 'run' || st === 'wait')) {
      const ev: ChatEvent = { t: 'stopped' }
      events.push(ev)
      return { events, upTo: this.record(paneId, ev) } // 프로세스가 없어 그 사이 다른 이벤트는 없다
    }
    return { events, upTo }
  }

  /** pane 을 닫았다 — 프로세스를 끝낸다. forget 이면 화면 기록도 지운다(되돌리기 기회가 지난 뒤) */
  close(paneId: string, forget = false) {
    const e = this.panes.get(paneId)
    if (e) {
      e.closed = true
      e.s.kill()
    }
    this.panes.delete(paneId)
    if (this.starting.has(paneId)) this.cancelled.add(paneId)
    if (forget) void this.d.store.remove(paneId).catch(() => {})
  }

  /** 창이 닫혔다 — 그 창의 대화를 모두 끝낸다(다음에 열면 --resume 으로 잇는다) */
  closeSink(sink: Sink) {
    for (const [id, e] of this.panes) if (e.sink === sink) this.close(id)
  }

  killAll() {
    for (const id of [...this.panes.keys()]) this.close(id)
  }

  get size(): number {
    return this.panes.size
  }
}

/**
 * 창이 고른 사용자 메시지의 저장 파일 속 자리. 창의 번호를 먼저 보고, 다르면 보낸 시각으로 찾는다 —
 * 저장 파일은 커지면 앞을 잘라 내 창이 가진 번호와 어긋난다(리뷰).
 */
function userIndex(events: readonly ChatEvent[], index: number, at: number): number {
  const hit = (e: ChatEvent | undefined) => e !== undefined && e.t === 'user' && e.at === at
  if (hit(events[index])) return index
  return events.findIndex(hit)
}
