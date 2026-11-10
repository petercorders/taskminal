// 앱(main) 쪽 셸 지킴이 손님 — 연결 · 지킴이 띄우기 · 요청/답 · 끊기면 다시 붙기. electron 을 쓰지 않는다(시험하기 쉽게).

import { spawn } from 'node:child_process'
import { connect, type Socket } from 'node:net'
import { encodeFrame, LineDecoder, PTYHOST_PROTOCOL, RECONNECT_DELAYS, reconnectDelay, type HostRequest } from '../../shared/ptyhost'

export type HostStatus =
  | { state: 'starting' }
  | { state: 'connected'; pid: number; version: number; startedAt: number; fresh: boolean }
  | { state: 'reconnecting'; attempt: number; of: number }
  | { state: 'down'; error: string }

export interface HostClientOptions {
  sockPath: string
  userData: string
  /** out/main/host.js */
  hostScript: string
  /** Electron 실행 파일 (ELECTRON_RUN_AS_NODE 로 node 처럼 돈다) */
  execPath: string
  /** 지킴이 프로세스 환경 (셸 환경이 아니다 — 셸 환경은 spawn 요청에 실린다) */
  env: Record<string, string | undefined>
  /** 다시 연결 간격 비율 — 시험용 (TASKMINAL_PTYHOST_RETRY_MS) */
  retryScale?: number
  onData(paneId: string, data: string): void
  onExit(paneId: string, exit: { exitCode: number; signal: number | null }): void
  onStatus(status: HostStatus): void
  /** 연결이 끊겼다가 같은 지킴이에 다시 붙었다 — 붙어 있던 pane 을 다시 attach 한다 */
  onReconnected(): void
  /** 지킴이 프로세스가 없어졌다(충돌 · kill) — 셸도 끝났다. 새 지킴이는 이미 떠 있다 */
  onHostLost(): void
}

const REQUEST_TIMEOUT_MS = 5000
const LAUNCH_WAIT_MS = 5000

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** 소켓에 한 번 붙어 본다 */
function tryConnect(path: string, timeoutMs = 1000): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = connect(path)
    const t = setTimeout(() => {
      s.destroy()
      reject(new Error('연결 시간 초과'))
    }, timeoutMs)
    s.once('connect', () => {
      clearTimeout(t)
      resolve(s)
    })
    s.once('error', (e) => {
      clearTimeout(t)
      reject(e)
    })
  })
}

export class HostClient {
  private socket: Socket | null = null
  private nextId = 1
  private readonly waiting = new Map<number, { resolve(v: Record<string, unknown>): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }>()
  private disposed = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private status: HostStatus = { state: 'starting' }
  /** 지금(또는 마지막으로) 붙은 지킴이 pid */
  pid = 0

  constructor(private readonly o: HostClientOptions) {}

  get connected(): boolean {
    return this.status.state === 'connected'
  }

  get current(): HostStatus {
    return this.status
  }

  /** 떠 있는 지킴이에 붙거나, 없으면 띄우고 붙는다. 실패하면 다시 연결 순서로 넘어간다. */
  async start(): Promise<void> {
    this.setStatus({ state: 'starting' })
    try {
      await this.connectOrLaunch()
    } catch {
      this.retry(0)
    }
  }

  /** 사용자가 [다시 연결] — 다섯 번을 처음부터 */
  reconnect(): void {
    if (this.connected || this.disposed) return
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.retry(0)
  }

  /** [지킴이 다시 시작] — 지금 지킴이를 끝내고(셸도 끝남) 새로 띄운다 */
  async restart(): Promise<void> {
    const pid = this.pid
    await this.shutdown()
    if (pid && alive(pid)) process.kill(pid, 'SIGTERM') // 연결이 없어 shutdown 을 못 보낸 지킴이
    await this.waitGone(pid)
    await this.start()
  }

  /** 지킴이와 셸을 모두 끝낸다(⌥⌘Q · 다시 시작). 답을 받은 뒤 연결을 먼저 놓아 '끊김' 으로 처리하지 않는다 */
  async shutdown(): Promise<void> {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    const pid = this.pid
    if (this.connected) await this.request({ op: 'shutdown' }).catch(() => undefined)
    this.closeSocket()
    this.status = { state: 'starting' } // 알리지 않는다 — 끝내기 · 다시 시작 중
    await this.waitGone(pid)
  }

  request(req: HostRequest, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Record<string, unknown>> {
    const socket = this.socket
    if (!socket || !this.connected) return Promise.reject(new Error('셸 지킴이에 연결되어 있지 않음'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new Error('셸 지킴이가 답하지 않음'))
      }, timeoutMs)
      this.waiting.set(id, { resolve, reject, timer })
      socket.write(encodeFrame({ ...req, id }))
    })
  }

  /** 답 없는 요청(입력 · 크기 · 끝내기 · 떼기). 연결이 없으면 버린다 — 입력은 연결될 때까지 막는다 */
  send(req: HostRequest): boolean {
    if (!this.socket || !this.connected) return false
    this.socket.write(encodeFrame(req))
    return true
  }

  /** 앱 종료 — 연결만 닫는다(셸은 지킴이에 남는다) */
  dispose(): void {
    this.disposed = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.closeSocket()
  }

  private setStatus(s: HostStatus): void {
    this.status = s
    this.o.onStatus(s)
  }

  private async connectOrLaunch(): Promise<void> {
    let socket: Socket
    let fresh = false
    try {
      socket = await tryConnect(this.o.sockPath)
    } catch {
      await this.launch()
      fresh = true
      socket = await this.waitForSocket()
    }
    await this.adopt(socket, fresh)
  }

  private launch(): Promise<void> {
    return new Promise((resolve, reject) => {
      const env = { ...this.o.env, ELECTRON_RUN_AS_NODE: '1' }
      const child = spawn(this.o.execPath, [this.o.hostScript, this.o.sockPath, this.o.userData], { detached: true, stdio: 'ignore', cwd: '/', env })
      let settled = false
      // 바로 죽으면(스크립트 없음 등) 기다리지 않고 실패
      child.once('exit', (code) => {
        if (settled) return
        settled = true
        reject(new Error(`셸 지킴이가 바로 끝남 (코드 ${code})`))
      })
      child.once('error', (e) => {
        if (settled) return
        settled = true
        reject(e)
      })
      child.unref()
      setTimeout(() => {
        if (settled) return
        settled = true
        resolve()
      }, 150)
    })
  }

  private async waitForSocket(): Promise<Socket> {
    const until = Date.now() + LAUNCH_WAIT_MS
    for (;;) {
      try {
        return await tryConnect(this.o.sockPath, 500)
      } catch (e) {
        if (Date.now() > until) throw e
        await new Promise((r) => setTimeout(r, 50))
      }
    }
  }

  private async adopt(socket: Socket, fresh: boolean): Promise<void> {
    this.closeSocket()
    this.socket = socket
    const decoder = new LineDecoder((v) => this.onFrame(v as Record<string, unknown>))
    socket.on('data', (chunk: Buffer) => decoder.push(chunk))
    socket.on('error', () => {})
    socket.on('close', () => {
      if (this.socket !== socket) return
      this.socket = null
      this.failWaiting()
      if (!this.disposed) this.lost()
    })
    // hello 는 연결 상태 전에 보낸다 (request 는 connected 를 요구)
    const hello = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new Error('셸 지킴이가 답하지 않음'))
      }, REQUEST_TIMEOUT_MS)
      this.waiting.set(id, { resolve, reject, timer })
      socket.write(encodeFrame({ op: 'hello', version: PTYHOST_PROTOCOL, id }))
    })
    this.pid = Number(hello['pid'])
    this.setStatus({ state: 'connected', pid: this.pid, version: Number(hello['version']), startedAt: Number(hello['startedAt']), fresh })
  }

  private onFrame(f: Record<string, unknown>): void {
    if (f['ev'] === 'data' && typeof f['paneId'] === 'string' && typeof f['data'] === 'string') return this.o.onData(f['paneId'], f['data'])
    if (f['ev'] === 'exit' && typeof f['paneId'] === 'string') {
      return this.o.onExit(f['paneId'], { exitCode: Number(f['exitCode']) || 0, signal: typeof f['signal'] === 'number' ? f['signal'] : null })
    }
    const id = f['id']
    if (typeof id !== 'number') return
    const w = this.waiting.get(id)
    if (!w) return
    this.waiting.delete(id)
    clearTimeout(w.timer)
    if (f['ok'] === true) w.resolve(f)
    else w.reject(new Error(typeof f['error'] === 'string' ? f['error'] : '셸 지킴이 요청 실패'))
  }

  /** 연결이 끊겼다 — 지킴이가 죽었으면 새로 띄우고 알리고, 살아 있으면 다시 붙어 본다 */
  private lost(): void {
    const pid = this.pid
    if (pid && !alive(pid)) return void this.replaceLostHost()
    this.retry(0)
  }

  private async replaceLostHost(): Promise<void> {
    this.setStatus({ state: 'reconnecting', attempt: 1, of: RECONNECT_DELAYS.length })
    try {
      await this.connectOrLaunch()
      this.o.onHostLost()
    } catch {
      this.retry(0)
    }
  }

  private retry(attempt: number): void {
    if (this.disposed) return
    const delay = reconnectDelay(attempt, this.o.retryScale)
    if (delay === null) return this.setStatus({ state: 'down', error: '다섯 번 다시 붙어 보았지만 연결하지 못했어요' })
    this.setStatus({ state: 'reconnecting', attempt: attempt + 1, of: RECONNECT_DELAYS.length })
    const prevPid = this.pid
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.connectOrLaunch().then(
        () => {
          // 같은 지킴이면 다시 붙기, 다른(새) 지킴이면 셸을 잃은 것
          if (prevPid && this.pid !== prevPid) this.o.onHostLost()
          else this.o.onReconnected()
        },
        () => this.retry(attempt + 1),
      )
    }, delay)
  }

  private failWaiting(): void {
    for (const [id, w] of this.waiting) {
      clearTimeout(w.timer)
      w.reject(new Error('셸 지킴이와 연결이 끊김'))
      this.waiting.delete(id)
    }
  }

  private closeSocket(): void {
    const s = this.socket
    this.socket = null
    this.failWaiting()
    s?.destroy()
  }

  private async waitGone(pid: number): Promise<void> {
    for (let i = 0; i < 60 && pid && alive(pid); i++) await new Promise((r) => setTimeout(r, 50))
  }
}

/** 다른 지킴이(옛 버전)에 한 번 붙어 요청들을 보내고 답을 모은다. 실패하면 null */
export async function oneShot(path: string, reqs: HostRequest[], timeoutMs = 2000): Promise<Array<Record<string, unknown>> | null> {
  let socket: Socket
  try {
    socket = await tryConnect(path, timeoutMs)
  } catch {
    return null
  }
  return new Promise((resolve) => {
    const replies: Array<Record<string, unknown>> = []
    const done = (v: Array<Record<string, unknown>> | null) => {
      clearTimeout(timer)
      socket.destroy()
      resolve(v)
    }
    const timer = setTimeout(() => done(null), timeoutMs)
    const decoder = new LineDecoder((v) => {
      const f = v as Record<string, unknown>
      if (typeof f['id'] !== 'number') return
      replies[f['id'] - 1] = f
      if (replies.filter(Boolean).length === reqs.length) done(replies)
    })
    socket.on('data', (c: Buffer) => decoder.push(c))
    socket.on('error', () => done(null))
    reqs.forEach((r, i) => socket.write(encodeFrame({ ...r, id: i + 1 })))
  })
}
