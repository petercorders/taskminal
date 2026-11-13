// 셸 지킴이 프로세스의 입구 — out/main/host.js. 앱(main)이 Electron 실행 파일을 ELECTRON_RUN_AS_NODE=1 로 떼어 띄운다.
// 인자: <소켓 경로> <userData>. electron 을 import 하지 않는다(node 모드라 없다 — 단위 시험이 소스를 읽어 막는다).
// 끝나는 때: shutdown 요청 · 살아 있는 셸도 손님도 없이 60초 · userData 폴더 · 소켓 파일이 사라짐(앱 지우기 · e2e 정리).

import { appendFileSync, chmodSync, existsSync, statSync, truncateSync, unlinkSync } from 'node:fs'
import { connect, createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { spawn } from 'node-pty'
import { encodeFrame, LineDecoder, parseRequest, PTYHOST_PROTOCOL } from '../../shared/ptyhost'
import { HostCore, type HostConn } from './host-core'

const [sockPath, userData] = process.argv.slice(2)
if (!sockPath || !userData) process.exit(2)
const pipe = process.platform === 'win32'

const logFile = join(userData, 'ptyhost.log')
const LOG_MAX = 1024 * 1024
function log(...parts: unknown[]): void {
  try {
    if (existsSync(logFile) && statSync(logFile).size > LOG_MAX) truncateSync(logFile, 0)
    appendFileSync(logFile, `${new Date().toISOString()} [${process.pid}] ${parts.map(String).join(' ')}\n`, { mode: 0o600 })
  } catch {
    // 기록은 덤
  }
}

const envInt = (name: string, fallback: number): number => {
  const v = Number(process.env[name])
  return Number.isInteger(v) && v >= 0 ? v : fallback
}
// 시험: 옛 버전 지킴이를 흉내 · 유휴 시간 줄이기
const version = envInt('TASKMINAL_PTYHOST_PROTOCOL', PTYHOST_PROTOCOL)
const IDLE_MS = envInt('TASKMINAL_PTYHOST_IDLE_MS', 60_000)
const WATCH_MS = 2000

if (!pipe) process.umask(0o077) // Windows named pipe는 기본 DACL을 유지 (readableAll/writableAll 금지)
process.on('SIGHUP', () => {}) // 띄운 쪽 터미널이 닫혀도
process.on('SIGPIPE', () => {})
process.on('uncaughtException', (e) => log('uncaught', e.stack ?? e)) // 한 요청의 버그로 모든 셸을 잃지 않게

let server: ReturnType<typeof createServer> | null = null
let sockIno = 0

function exitNow(code: number): void {
  try {
    if (!pipe && sockIno && statSync(sockPath!).ino === sockIno) unlinkSync(sockPath!)
  } catch {
    // 이미 없음
  }
  log('끝남', code)
  process.exit(code)
}

const core = new HostCore({
  spawnPty: (file, args, opts) => spawn(file, args, opts),
  now: () => Date.now(),
  schedule: (fn, ms) => {
    const t = setTimeout(fn, ms)
    return () => clearTimeout(t)
  },
  version,
  pid: process.pid,
  rss: () => process.memoryUsage().rss,
  onShutdown: () => {
    server?.close()
    exitNow(0)
  },
})

function serve(socket: Socket): void {
  const conn: HostConn = {
    send: (frame) => {
      if (!socket.destroyed) socket.write(encodeFrame(frame))
    },
  }
  core.open(conn)
  const decoder = new LineDecoder((v) => {
    const f = parseRequest(v)
    if (f) core.handle(conn, f)
    else if (typeof v === 'object' && v !== null && Number.isInteger((v as { id?: unknown }).id)) conn.send({ id: (v as { id: number }).id, ok: false, error: '잘못된 요청' })
  })
  socket.on('data', (chunk: Buffer) => decoder.push(chunk))
  socket.on('error', () => {})
  socket.on('close', () => core.close(conn))
}

function listen(): void {
  try {
    if (!pipe) unlinkSync(sockPath!) // Windows named pipe는 파일이 아니다
  } catch {
    // 없음
  }
  server = createServer(serve)
  server.on('error', (e) => {
    log('소켓을 열지 못함', e)
    process.exit(1)
  })
  server.listen(sockPath!, () => {
    try {
      if (!pipe) {
        chmodSync(sockPath!, 0o600)
        sockIno = statSync(sockPath!).ino
      }
    } catch (e) {
      log('소켓 권한', e)
    }
    log('시작', `v${version}`, sockPath)
    watch()
  })
}

function watch(): void {
  let idleSince: number | null = null
  setInterval(() => {
    // 데이터 폴더나 소켓이 사라지면 아무도 다시 붙을 수 없다 — 셸을 끝내고 나간다
    let gone = !existsSync(userData!)
    try {
      if (!pipe && statSync(sockPath!).ino !== sockIno) gone = true
    } catch {
      gone = true
    }
    if (gone) {
      log('데이터 폴더 · 소켓이 사라짐 — 셸을 끝냄')
      core.handle({ send: () => {} }, { op: 'shutdown' })
      return
    }
    // 끝난 셸의 기록(exit · 못 본 실패)도 다음에 열 때 보여 줄 것이라 남아 있으면 기다린다
    if (core.sessionCount === 0 && core.clientCount === 0) {
      idleSince ??= Date.now()
      if (Date.now() - idleSince >= IDLE_MS) exitNow(0)
    } else {
      idleSince = null
    }
  }, Math.min(WATCH_MS, Math.max(100, IDLE_MS))).unref?.()
}

// 이미 떠 있는 지킴이가 있으면(소켓이 받음) 둘이 되지 않게 그냥 나간다
const probe = connect(sockPath)
probe.once('connect', () => {
  probe.destroy()
  process.exit(0)
})
probe.once('error', () => listen())
