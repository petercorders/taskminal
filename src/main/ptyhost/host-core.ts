// 셸 지킴이의 핵심 — 세션(pty + headless 화면 + 활동 기록)과 요청 처리. 소켓 · node-pty 는 host-entry 가 주입한다(시험은 가짜 pty).
// 이 파일은 지킴이 프로세스(ELECTRON_RUN_AS_NODE)에서 돈다 — electron 을 import 하지 않는다.

import { SerializeAddon } from '@xterm/addon-serialize'
import { Terminal } from '@xterm/headless'
import { parseCommandOsc, parseNotifyOsc, parseOsc133 } from '../../shared/activity'
import { HEADLESS_SCROLLBACK, replayOsc, type AttachReply, type HostFrame, type SessionInfo } from '../../shared/ptyhost'

export interface PtyLike {
  readonly pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  onData(cb: (data: string) => void): unknown
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): unknown
}

export type SpawnPty = (file: string, args: string[], opts: { name: string; cwd: string; env: Record<string, string>; cols: number; rows: number }) => PtyLike

/** 지킴이와 이어진 손님 하나 (앱의 main) */
export interface HostConn {
  send(frame: object): void
}

export interface HostCoreOptions {
  spawnPty: SpawnPty
  now(): number
  schedule(fn: () => void, ms: number): () => void
  version: number
  pid: number
  rss(): number
  /** shutdown 요청 뒤 셸이 다 끝났거나 2초가 지났다 — 지킴이 프로세스를 끝낸다 */
  onShutdown(): void
}

const KILL_ESCALATE_MS = 2000

interface Session {
  paneId: string
  pty: PtyLike
  term: Terminal
  serializer: SerializeAddon
  startedAt: number
  lastOutputAt: number
  clients: Set<HostConn>
  /** attach 답을 기다리는 손님 — 그 사이 온 출력을 모아 답 뒤에 보낸다 */
  pending: Map<HostConn, string[]>
  /** 붙은 손님이 없어진 시각 (붙어 있으면 null) */
  detachedAt: number | null
  exited: { exitCode: number; signal: number | null } | null
  killTimer: (() => void) | null
  /** 손님이 끝내라고 했다 — 끝나면 기록을 남기지 않는다 */
  killed: boolean
  commandOsc?: string
  command?: string
  running: boolean
  unseen: { waiting: boolean; message?: string; failed?: number }
}

export class HostCore {
  private readonly sessions = new Map<string, Session>()
  private readonly conns = new Set<HostConn>()
  private readonly startedAt: number
  private shuttingDown = false

  constructor(private readonly o: HostCoreOptions) {
    this.startedAt = o.now()
  }

  get liveCount(): number {
    let n = 0
    for (const s of this.sessions.values()) if (!s.exited) n++
    return n
  }

  get clientCount(): number {
    return this.conns.size
  }

  open(conn: HostConn): void {
    this.conns.add(conn)
  }

  close(conn: HostConn): void {
    this.conns.delete(conn)
    for (const s of this.sessions.values()) {
      s.pending.delete(conn)
      this.removeClient(s, conn)
    }
  }

  /** 모든 headless 화면이 받은 출력을 다 읽은 뒤 (시험 · tail 전에) */
  settled(): Promise<void> {
    return Promise.all([...this.sessions.values()].map((s) => new Promise<void>((r) => s.term.write('', r)))).then(() => {})
  }

  handle(conn: HostConn, f: HostFrame): void {
    const reply = (body: object) => f.id !== undefined && conn.send({ id: f.id, ok: true, ...body })
    switch (f.op) {
      case 'hello':
        return void reply({ version: this.o.version, pid: this.o.pid, startedAt: this.startedAt })
      case 'spawn': {
        const old = this.sessions.get(f.paneId)
        if (old && !old.exited) {
          old.clients.add(conn)
          old.detachedAt = null
          return void reply({ pid: old.pty.pid, existing: true })
        }
        if (old) this.drop(old)
        try {
          const s = this.create(f)
          s.clients.add(conn)
          return void reply({ pid: s.pty.pid, existing: false })
        } catch (error) {
          if (f.id !== undefined) conn.send({ id: f.id, ok: false, error: error instanceof Error ? error.message : String(error) })
          return
        }
      }
      case 'attach':
        return this.attach(conn, f.id, f.paneId)
      case 'detach': {
        const s = this.sessions.get(f.paneId)
        if (s) this.removeClient(s, conn)
        return
      }
      case 'write': {
        const s = this.sessions.get(f.paneId)
        if (s && !s.exited) s.pty.write(f.data)
        return
      }
      case 'resize': {
        const s = this.sessions.get(f.paneId)
        if (!s || s.exited) return
        s.pty.resize(f.cols, f.rows)
        s.term.resize(f.cols, f.rows)
        return
      }
      case 'kill': {
        const s = this.sessions.get(f.paneId)
        if (s) this.end(s)
        return
      }
      case 'list': {
        const sessions = [...this.sessions.values()].map((s) => this.info(s))
        if (f.clearUnseen) for (const s of this.sessions.values()) s.unseen = { waiting: false }
        return void reply({ sessions })
      }
      case 'tail': {
        const s = this.sessions.get(f.paneId)
        if (!s) return void reply({ text: '' })
        const lines = f.lines
        s.term.write('', () => reply({ text: tailText(s.term, lines) }))
        return
      }
      case 'stats':
        return void reply({ version: this.o.version, pid: this.o.pid, startedAt: this.startedAt, rss: this.o.rss(), sessions: this.liveCount })
      case 'shutdown':
        reply({})
        return this.shutdown()
    }
  }

  private create(f: Extract<HostFrame, { op: 'spawn' }>): Session {
    const pty = this.o.spawnPty(f.file, f.args, { name: 'xterm-256color', cwd: f.cwd, env: f.env, cols: f.cols, rows: f.rows })
    const term = new Terminal({ cols: f.cols, rows: f.rows, scrollback: HEADLESS_SCROLLBACK, allowProposedApi: true })
    const serializer = new SerializeAddon()
    term.loadAddon(serializer as unknown as Parameters<Terminal['loadAddon']>[0])
    const now = this.o.now()
    const s: Session = {
      paneId: f.paneId,
      pty,
      term,
      serializer,
      startedAt: now,
      lastOutputAt: now,
      clients: new Set(),
      pending: new Map(),
      detachedAt: null,
      exited: null,
      killTimer: null,
      killed: false,
      running: false,
      unseen: { waiting: false },
    }
    this.watchActivity(s)
    pty.onData((data) => {
      s.lastOutputAt = this.o.now()
      s.term.write(data)
      for (const c of s.clients) c.send({ ev: 'data', paneId: s.paneId, data })
      for (const buf of s.pending.values()) buf.push(data)
    })
    pty.onExit((e) => this.exited(s, { exitCode: e.exitCode, signal: e.signal ?? null }))
    this.sessions.set(f.paneId, s)
    return s
  }

  /** 손님이 없을 때 온 알림 · 실패를 기억한다 (앱이 꺼져 있던 동안의 '확인 필요'). 명령 상태는 늘 따라간다. */
  private watchActivity(s: Session): void {
    const away = () => s.clients.size === 0
    const t = s.term
    t.parser.registerOscHandler(133, (data) => {
      const ev = parseOsc133(data)
      if (ev?.type === 'start') s.running = true
      if (ev?.type === 'end') {
        s.running = false
        if (away() && ev.code !== null && ev.code !== 0) s.unseen.failed = ev.code
      }
      if (ev?.type === 'prompt') s.running = false
      return false // headless 화면에는 영향 없음 — 다른 처리기에 넘긴다
    })
    t.parser.registerOscHandler(6973, (data) => {
      const ev = parseCommandOsc(data)
      if (ev?.type === 'command') {
        s.commandOsc = data
        s.command = ev.text
      }
      return false
    })
    const notify = (ident: 9 | 777) => (data: string) => {
      const ev = parseNotifyOsc(ident, data)
      if (ev?.type === 'notify' && away()) s.unseen = { ...s.unseen, waiting: true, message: ev.text }
      return false
    }
    t.parser.registerOscHandler(9, notify(9))
    t.parser.registerOscHandler(777, notify(777))
    t.onBell(() => {
      if (away()) s.unseen = { ...s.unseen, waiting: true }
    })
  }

  private attach(conn: HostConn, id: number | undefined, paneId: string): void {
    const s = this.sessions.get(paneId)
    if (!s) {
      if (id !== undefined) conn.send({ id, ok: true, found: false })
      return
    }
    const buf: string[] = []
    s.pending.set(conn, buf)
    // headless 쓰기는 비동기 — 이미 받은 출력을 다 그린 뒤에 화면을 만든다. 그 사이 온 출력은 buf 로 받아 답 뒤에 보낸다.
    s.term.write('', () => {
      if (s.pending.get(conn) !== buf) return // 그 사이 손님이 떠났다
      s.pending.delete(conn)
      const body: AttachReply = {
        found: true,
        pid: s.pty.pid,
        screen: s.serializer.serialize({ scrollback: HEADLESS_SCROLLBACK }),
        replay: replayOsc(s),
        detachedMs: s.clients.size > 0 || s.detachedAt === null ? 0 : this.o.now() - s.detachedAt,
      }
      if (s.exited) body.exited = s.exited
      if (id !== undefined) conn.send({ id, ok: true, ...body })
      if (s.exited) return this.drop(s)
      for (const data of buf) conn.send({ ev: 'data', paneId, data })
      s.clients.add(conn)
      s.detachedAt = null
    })
  }

  private removeClient(s: Session, conn: HostConn): void {
    if (!s.clients.delete(conn)) return
    if (s.clients.size === 0) s.detachedAt = this.o.now()
  }

  private info(s: Session): SessionInfo {
    const out: SessionInfo = {
      paneId: s.paneId,
      pid: s.pty.pid,
      startedAt: s.startedAt,
      lastOutputAt: s.lastOutputAt,
      attached: s.clients.size > 0,
      running: s.running,
      unseen: { ...s.unseen },
      detachedMs: s.clients.size > 0 || s.detachedAt === null ? 0 : this.o.now() - s.detachedAt,
    }
    if (s.exited) out.exited = s.exited
    if (s.command !== undefined) out.command = s.command
    return out
  }

  /** SIGHUP, 2초 안에 안 끝나면 SIGKILL. 이미 끝난 셸(기록만 남음)은 기록을 지운다. */
  private end(s: Session): void {
    if (s.exited) return this.drop(s)
    if (s.killTimer) return
    s.killed = true
    signal(s.pty, 'SIGHUP')
    s.killTimer = this.o.schedule(() => {
      s.killTimer = null
      signal(s.pty, 'SIGKILL') // 끝나면 exited() 가 이 타이머를 먼저 지운다
    }, KILL_ESCALATE_MS)
  }

  private exited(s: Session, exit: { exitCode: number; signal: number | null }): void {
    s.killTimer?.()
    s.killTimer = null
    s.exited = exit
    if (s.clients.size > 0 || this.shuttingDown || s.killed) {
      for (const c of s.clients) c.send({ ev: 'exit', paneId: s.paneId, ...exit })
      this.drop(s)
    }
    if (this.shuttingDown && this.liveCount === 0) this.finishShutdown()
  }

  private drop(s: Session): void {
    if (this.sessions.get(s.paneId) === s) this.sessions.delete(s.paneId)
    s.term.dispose()
  }

  private shutdownTimer: (() => void) | null = null

  private shutdown(): void {
    if (this.shuttingDown) return
    this.shuttingDown = true
    for (const s of [...this.sessions.values()]) {
      if (s.exited) this.drop(s)
      else this.end(s)
    }
    if (this.liveCount === 0) return this.finishShutdown()
    this.shutdownTimer = this.o.schedule(() => this.finishShutdown(), KILL_ESCALATE_MS)
  }

  private finished = false
  private finishShutdown(): void {
    if (this.finished) return
    this.finished = true
    this.shutdownTimer?.()
    this.o.onShutdown()
  }
}

function signal(pty: PtyLike, sig: string): void {
  try {
    pty.kill(sig)
  } catch {
    // 이미 끝난 프로세스
  }
}

/** headless 화면의 마지막 n 줄 (끝의 빈 줄은 뺀다) */
function tailText(term: Terminal, n: number): string {
  const buf = term.buffer.active
  const lines: string[] = []
  for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '')
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.slice(-n).join('\n')
}
