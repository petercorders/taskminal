// `taskminal` 명령줄 도구의 앱 쪽 (24단계) — <userData>/cli.sock 을 0600 으로 열고, 한 연결 = 한 요청(줄 JSON).
// 화면 상태를 바꾸는 일은 창(renderer)에 묻고, 셸 입출력 · 기다리기 · 대화 보내기는 여기서 지킴이 · ChatManager 로 한다.
import { chmodSync, existsSync, lstatSync, unlinkSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { chatStatus, lastTurnText, type ChatEvent, type ChatState } from '../shared/chat'
import { CLI_PROTOCOL, EXIT, isCliRequest, type CliReply, type CliRequest, type PaneTarget, type UiReply, type UiRequest } from '../shared/cli'
import { formatDuration } from '../shared/activity'
import type { PaneWatch, WaitResult } from '../shared/pane-watch'

/** 한 줄 요청의 상한 (보낼 글 100k + 여유) */
const MAX_LINE = 256 * 1024
/** 셸이 뜨기를 기다리는 시간 — 이름을 풀며 처음 띄운 탭 */
export const SESSION_WAIT_MS = 5000

export interface CliServerDeps {
  sockPath: string
  /** 창에 묻는다 — 창이 없거나 답이 없으면 { ok:false } */
  askUi(req: UiRequest): Promise<UiReply>
  pane: {
    /** 셸이 지킴이에 있을 때까지(최대 ms). 없으면 false */
    ready(paneId: string, ms: number): Promise<boolean>
    write(paneId: string, data: string): boolean
    tail(paneId: string, lines: number): Promise<string>
    info(paneId: string): Promise<{ running: boolean; lastOutputAt: number; exited?: number } | null>
  }
  watch: PaneWatch
  chat: {
    send(target: PaneTarget, text: string): Promise<'ok' | 'busy' | 'missing' | 'no-window'>
    /** 지금까지의 대화 기록(가린 것) — 앱이 턴 도중 끝나 열린 턴은 '멈춤' 으로 닫힌 것 */
    history(paneId: string): Promise<ChatEvent[]>
    /** pane 의 새 이벤트를 듣는다 → 그만 듣기 */
    subscribe(fn: (paneId: string, ev: ChatEvent) => void): () => void
  }
  redact(text: string): string
}

/** 창이 답할 수 없는 · CLI 쪽에서 받는 오류 */
const err = (error: string, exit: number = EXIT.error): CliReply => ({ ok: false, error, exit })

export class CliServer {
  private server: Server | null = null
  private readonly conns = new Set<Socket>()

  constructor(private readonly d: CliServerDeps) {}

  /** 남은 소켓 파일(앱이 죽고 남은 것)은 지우고 연다 — 같은 userData 의 다른 앱은 단일 인스턴스 잠금이 막는다 */
  async listen(): Promise<void> {
    const path = this.d.sockPath
    try {
      if (existsSync(path) && lstatSync(path).isSocket()) unlinkSync(path)
    } catch {
      // 열기에서 알린다
    }
    const server = createServer((sock) => this.accept(sock))
    // 만들어지는 순간부터 같은 사용자만 — chmod 전의 틈을 없앤다
    const old = process.umask(0o077)
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(path, () => {
          server.off('error', reject)
          resolve()
        })
      })
    } finally {
      process.umask(old)
    }
    chmodSync(path, 0o600)
    this.server = server
  }

  close(): void {
    for (const c of this.conns) c.destroy()
    this.conns.clear()
    this.server?.close()
    this.server = null
    try {
      if (existsSync(this.d.sockPath)) unlinkSync(this.d.sockPath)
    } catch {
      // 다음 시작이 지운다
    }
  }

  private accept(sock: Socket): void {
    this.conns.add(sock)
    sock.setEncoding('utf8')
    let buf = ''
    let started = false
    const aborts: Array<() => void> = []
    const closed = () => {
      this.conns.delete(sock)
      for (const a of aborts.splice(0)) a()
    }
    sock.on('close', closed)
    sock.on('error', () => sock.destroy())
    sock.on('data', (chunk: string) => {
      if (started) return
      buf += chunk
      if (buf.length > MAX_LINE) {
        started = true
        return this.reply(sock, err('요청이 너무 길어요'))
      }
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      started = true
      let raw: unknown
      try {
        raw = JSON.parse(buf.slice(0, nl))
      } catch {
        return this.reply(sock, err('요청을 읽지 못했어요', EXIT.usage))
      }
      const v = (raw as { v?: unknown } | null)?.v
      if (v !== CLI_PROTOCOL) return this.reply(sock, err(`앱과 명령의 버전이 달라요 (앱 ${CLI_PROTOCOL} · 명령 ${String(v)}) — 앱 메뉴의 '명령줄 도구 설치…' 로 다시 설치해 주세요`, EXIT.usage))
      if (!isCliRequest(raw)) return this.reply(sock, err('요청의 모양이 맞지 않아요', EXIT.usage))
      void this.handle(raw, (fn) => aborts.push(fn)).then(
        (r) => this.reply(sock, r),
        (e: unknown) => this.reply(sock, err(`앱에서 처리하지 못했어요: ${e instanceof Error ? e.message : String(e)}`)),
      )
    })
  }

  private reply(sock: Socket, r: CliReply): void {
    if (sock.destroyed) return
    sock.end(JSON.stringify(r) + '\n')
  }

  /** 시험이 소켓 없이 부른다 */
  async handle(req: CliRequest, onAbort: (fn: () => void) => void = () => {}): Promise<CliReply> {
    const self = req.self !== undefined ? { self: req.self } : {}
    switch (req.op) {
      case 'pane.send':
      case 'pane.read':
      case 'pane.wait': {
        const t = await this.terminal(req.pane, self)
        if ('error' in t) return t.error
        const { target } = t
        if (req.op === 'pane.send') {
          if (!this.d.pane.write(target.paneId, req.text + (req.enter ? '\r' : ''))) return err('그 터미널에 보내지 못했어요')
          this.d.watch.sent(target.paneId, req.enter)
          return { ok: true }
        }
        if (req.op === 'pane.read') {
          const text = this.d.redact(await this.d.pane.tail(target.paneId, req.lines))
          return { ok: true, text, data: { pane: target.paneId, lines: text === '' ? [] : text.split('\n') } }
        }
        const info = await this.d.pane.info(target.paneId)
        if (info) this.d.watch.seed(target.paneId, info)
        const screen = req.for.kind === 'text' ? await this.d.pane.tail(target.paneId, 50) : undefined
        const w = this.d.watch.wait(target.paneId, req.for, { timeoutMs: req.timeoutMs, quietMs: req.quietMs, pending: target.pending, ...(screen !== undefined ? { screen } : {}) })
        onAbort(w.cancel)
        return this.waitReply(await w.result, req.timeoutMs)
      }
      case 'chat.new': {
        const r = await this.d.askUi(req)
        if (!r.ok) return r
        if (!r.target || r.target.kind !== 'chat') return err('대화 pane 을 만들지 못했어요')
        const sent = await this.d.chat.send(r.target, req.text)
        if (sent !== 'ok') return err(sendError(sent))
        return { ok: true, text: `대화 pane ${r.target.paneId} 를 만들고 보냈어요 (${r.target.label})`, data: { pane: r.target.paneId, label: r.target.label } }
      }
      case 'chat.send': {
        const t = await this.chatTarget(req.pane, self)
        if ('error' in t) return t.error
        const sent = await this.d.chat.send(t.target, req.text)
        return sent === 'ok' ? { ok: true } : err(sendError(sent))
      }
      case 'chat.read': {
        const t = await this.chatTarget(req.pane, self)
        if ('error' in t) return t.error
        const events = await this.d.chat.history(t.target.paneId)
        const st = chatStatus(events).state
        const text = lastTurnText(events)
        return { ok: true, text: text || '(아직 에이전트의 글이 없어요)', data: { pane: t.target.paneId, state: st, text } }
      }
      case 'chat.wait': {
        const r = await this.d.askUi({ op: 'chat.panes', panes: req.panes, all: req.all, ...(req.task !== undefined ? { task: req.task } : {}), ...self })
        if (!r.ok) return r
        const targets = r.targets ?? []
        if (targets.length === 0) return err('기다릴 대화 pane 이 없어요', EXIT.usage)
        const results = await this.waitChats(targets.map((t) => t.paneId), req.timeoutMs, onAbort)
        const rows = targets.map((t, i) => ({ pane: t.paneId, label: t.label, state: results[i]! }))
        const timedOut = rows.some((x) => x.state === 'run' || x.state === 'new')
        const text = rows.map((x) => `${CHAT_LABEL[x.state]}  ${x.label}  ${x.pane}`).join('\n')
        return { ok: true, text: timedOut ? `${text}\n시간이 다 됐어요 (${formatDuration(req.timeoutMs)})` : text, data: rows, exit: timedOut ? EXIT.timeout : EXIT.ok }
      }
      default:
        return this.d.askUi(req)
    }
  }

  private async terminal(pane: string, self: { self?: string }): Promise<{ target: PaneTarget } | { error: CliReply }> {
    const r = await this.d.askUi({ op: 'pane.resolve', pane, ...self })
    if (!r.ok) return { error: r }
    const target = r.target
    if (!target) return { error: err('그 pane 을 찾지 못했어요', EXIT.usage) }
    if (target.kind === 'chat') return { error: err(`${target.label} 은 대화 pane 이에요 — chat send · chat read · chat wait 를 써 주세요`, EXIT.usage) }
    if (target.kind === 'review') return { error: err(`${target.label} 은 변경 pane 이에요`, EXIT.usage) }
    if (!(await this.d.pane.ready(target.paneId, SESSION_WAIT_MS))) return { error: err(`${target.label} 의 셸이 뜨지 않았어요`) }
    return { target }
  }

  private async chatTarget(pane: string, self: { self?: string }): Promise<{ target: PaneTarget } | { error: CliReply }> {
    const r = await this.d.askUi({ op: 'pane.resolve', pane, ...self })
    if (!r.ok) return { error: r }
    if (!r.target || r.target.kind !== 'chat') return { error: err(`${r.target?.label ?? pane} 은 대화 pane 이 아니에요 — pane send · read · wait 를 써 주세요`, EXIT.usage) }
    return { target: r.target }
  }

  /** 대화마다 턴이 끝나거나(끝남 · 실패 · 멈춤) 허락 · 질문을 기다릴 때까지. 시간이 다 되면 그때의 상태 */
  private async waitChats(paneIds: string[], timeoutMs: number, onAbort: (fn: () => void) => void): Promise<ChatState[]> {
    const states: ChatState[] = paneIds.map(() => 'run')
    const settled = paneIds.map(() => false)
    let finish: () => void = () => {}
    const all = new Promise<void>((r) => (finish = r))
    const check = () => settled.every(Boolean) && finish()
    // 듣기를 먼저 단다 — 기록을 읽는 사이 온 끝을 놓치지 않게
    const off = this.d.chat.subscribe((paneId, ev) => {
      const i = paneIds.indexOf(paneId)
      if (i < 0 || settled[i]) return
      const next = stopState(ev)
      if (next) {
        states[i] = next
        settled[i] = true
        check()
      }
    })
    const timer = setTimeout(finish, timeoutMs)
    onAbort(finish)
    try {
      await Promise.all(
        paneIds.map(async (id, i) => {
          const st = chatStatus(await this.d.chat.history(id)).state
          if (settled[i]) return
          if (st !== 'run') {
            states[i] = st
            settled[i] = true
          }
        }),
      )
      check()
      await all
      return states
    } finally {
      off()
      clearTimeout(timer)
    }
  }

  private waitReply(r: WaitResult, timeoutMs: number): CliReply {
    switch (r.kind) {
      case 'exit':
        return { ok: true, text: [r.already ? '이미 끝나 있어요' : '끝남', r.code !== null ? `exit ${r.code}` : null, r.ms !== undefined ? formatDuration(r.ms) : null].filter(Boolean).join(' · '), data: r }
      case 'prompt':
        return { ok: true, text: '입력을 기다려요', data: r }
      case 'idle':
        return { ok: true, text: `조용해짐 · ${formatDuration(r.quietMs)}`, data: r }
      case 'text': {
        const line = this.d.redact(r.line)
        return { ok: true, text: `찾음: ${line}`, data: { kind: 'text', line } }
      }
      case 'shell-exit':
        return { ok: false, error: `셸이 끝났어요 · exit ${r.code}`, exit: EXIT.error }
      case 'timeout':
        return { ok: false, error: `시간이 다 됐어요 (${formatDuration(timeoutMs)})`, exit: EXIT.timeout }
      case 'cancelled':
        return { ok: false, error: '취소됨' }
    }
  }
}

const CHAT_LABEL: Record<ChatState, string> = { new: '새 대화', run: '실행 중', wait: '허락 · 답을 기다려요', done: '끝남', fail: '실패', stopped: '멈춤' }

/** 기다리기를 멈추는 이벤트 → 그때의 상태 */
function stopState(ev: ChatEvent): ChatState | null {
  switch (ev.t) {
    case 'turn_end':
      return ev.ok ? 'done' : 'fail'
    case 'stopped':
      return 'stopped'
    case 'error':
      return 'fail'
    case 'permission':
    case 'question':
      return 'wait'
    default:
      return null
  }
}

function sendError(r: 'busy' | 'missing' | 'no-window'): string {
  return r === 'busy' ? '그 대화는 실행 중이에요 — chat wait 로 끝나길 기다린 뒤 보내 주세요' : r === 'missing' ? '에이전트 명령(claude · codex)을 찾지 못했어요' : '앱 창이 없어요 — 창을 연 뒤 다시 해 주세요'
}
