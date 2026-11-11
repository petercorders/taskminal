// 대화 pane 들의 주인 (main) — paneId 마다 Claude 프로세스 하나. 이벤트를 가려서 창 · 디스크로 보낸다.
import { homedir } from 'node:os'
import { redactEvent, type ChatEvent, type ChatPermission } from '../../shared/chat'
import { shellEnv } from '../../shared/pty'
import type { SecretOptions } from '../../shared/redact'
import type { AgentBin } from './find-bin'
import { ClaudeSession, type Decision, type SpawnFn } from './claude-adapter'
import type { ChatStore } from './chat-store'

export interface Sink {
  send(channel: string, ...args: unknown[]): void
  isDestroyed(): boolean
}

export interface ChatManagerDeps {
  store: Pick<ChatStore, 'append' | 'read' | 'remove'>
  redactOptions(): SecretOptions
  spawn: SpawnFn
  findBin(): Promise<AgentBin | null>
  permission(): ChatPermission
  channel: string
  now?: () => number
}

export type SendResult = 'ok' | 'busy' | 'missing'

interface Entry {
  s: ClaudeSession
  sink: Sink
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
  /** pane 마다 보낸 이벤트 수 — 화면이 기록(history)과 실시간 이벤트를 겹치지도 빠뜨리지도 않게 맞춘다 */
  private counts = new Map<string, number>()
  constructor(private readonly d: ChatManagerDeps) {}

  private emit(paneId: string, sink: Sink, ev: ChatEvent) {
    const n = (this.counts.get(paneId) ?? 0) + 1
    this.counts.set(paneId, n)
    void this.d.store.append(paneId, [ev]).catch(() => {})
    if (!sink.isDestroyed()) sink.send(this.d.channel, paneId, redactEvent(ev, this.d.redactOptions()), n)
  }

  async send(sink: Sink, paneId: string, text: string, cwd: string, sessionId: string | undefined): Promise<SendResult> {
    const have = this.panes.get(paneId)
    if (this.starting.has(paneId) || have?.s.busy) return 'busy'
    const now = this.d.now ?? Date.now
    if (have) {
      have.sink = sink
      this.emit(paneId, sink, { t: 'user', text, at: now() })
      return have.s.send(text) ? 'ok' : 'busy'
    }
    this.starting.add(paneId)
    try {
      const found = await this.d.findBin()
      this.emit(paneId, sink, { t: 'user', text, at: now() })
      if (!found) {
        this.emit(paneId, sink, { t: 'error', kind: 'missing', message: 'claude 명령을 찾지 못했어요' })
        return 'missing'
      }
      const entry: Entry = { sink, s: null as unknown as ClaudeSession }
      entry.s = new ClaudeSession({
        bin: found.bin,
        env: agentEnv(process.env, found.path),
        cwd: expandHome(cwd),
        permission: this.d.permission(),
        ...(sessionId ? { sessionId } : {}),
        spawn: this.d.spawn,
        onEvent: (ev) => this.emit(paneId, entry.sink, ev),
        onExit: () => {},
      })
      this.panes.set(paneId, entry)
      return entry.s.send(text) ? 'ok' : 'busy'
    } finally {
      this.starting.delete(paneId)
    }
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
    const upTo = this.counts.get(paneId) ?? 0
    return { events: await this.d.store.read(paneId), upTo }
  }

  /** pane 을 닫았다 — 프로세스를 끝낸다. forget 이면 화면 기록도 지운다(되돌리기 기회가 지난 뒤) */
  close(paneId: string, forget = false) {
    this.panes.get(paneId)?.s.kill()
    this.panes.delete(paneId)
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
