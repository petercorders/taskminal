// 셸 지킴이(ptyhost) 프로토콜 — 앱(main) 과 지킴이가 함께 쓰는 순수 로직. 16단계.
// 지킴이는 앱 밖의 node 프로세스(Electron 실행 파일 + ELECTRON_RUN_AS_NODE)라 앱이 꺼져도 셸이 산다.
// 둘은 유닉스 소켓 위에서 줄마다 JSON 하나를 주고받는다.

import { isPaneId, validSize, validWrite } from './pty'

/** 프로토콜 버전 — 요청 · 답의 모양이 바뀌면 올린다. 소켓 이름에 들어가 옛 버전 지킴이와 섞이지 않는다. */
export const PTYHOST_PROTOCOL = 1
/** 지킴이가 pane 마다 기억하는 화면 줄 수 — 줄당 약 2.2KB(120칸), 100 pane ≈ 450MB (2026-11-11 측정) */
export const HEADLESS_SCROLLBACK = 2000
/** 연결이 끊긴 뒤 다시 붙는 간격 — 다섯 번 */
export const RECONNECT_DELAYS: readonly number[] = [1000, 2000, 4000, 8000, 16000]
/** 한 줄(프레임) 상한 — 넘는 줄은 버린다 (입력 상한 1MB 가 JSON 이스케이프로 커져도 들어가게) */
export const MAX_FRAME = 8 * 1024 * 1024
/** 메모리 경고 기준 */
export const WARN_RSS_MB = 1024
export const WARN_SESSIONS = 100
/** macOS 유닉스 소켓 경로 한도(sun_path 104) 보다 조금 짧게 */
const MAX_SOCKET_PATH = 100

/** 프레임 하나를 줄로 */
export const encodeFrame = (v: unknown): string => JSON.stringify(v) + '\n'

/**
 * 소켓에서 온 바이트를 줄 단위 JSON 으로. 조각이 줄 가운데 · 한글 바이트 가운데서 끊겨도 이어 붙인다.
 * JSON 이 아닌 줄 · 상한을 넘는 줄은 버린다(그 줄 끝까지 건너뜀).
 */
export class LineDecoder {
  private readonly text = new TextDecoder('utf-8')
  private buf = ''
  private skipping = false

  constructor(
    private readonly onFrame: (v: unknown) => void,
    private readonly max = MAX_FRAME,
  ) {}

  /** 줄바꿈을 기다리며 쥐고 있는 글자 수 — 끝없는 줄이 메모리를 채우지 않는지 시험에서 본다 */
  get buffered(): number {
    return this.buf.length
  }

  push(chunk: Uint8Array): void {
    let s = this.text.decode(chunk, { stream: true })
    for (;;) {
      const nl = s.indexOf('\n')
      if (nl < 0) {
        if (!this.skipping) this.buf += s
        if (this.buf.length > this.max) {
          this.buf = ''
          this.skipping = true
        }
        return
      }
      const line = this.skipping ? '' : this.buf + s.slice(0, nl)
      const skipped = this.skipping
      this.buf = ''
      this.skipping = false
      s = s.slice(nl + 1)
      if (skipped || line.length > this.max || line.trim() === '') continue
      let v: unknown
      try {
        v = JSON.parse(line)
      } catch {
        continue
      }
      this.onFrame(v)
    }
  }
}

export type HostRequest =
  | { op: 'hello'; version: number }
  | { op: 'spawn'; paneId: string; file: string; args: string[]; cwd: string; env: Record<string, string>; cols: number; rows: number }
  | { op: 'attach'; paneId: string }
  | { op: 'detach'; paneId: string }
  | { op: 'write'; paneId: string; data: string }
  | { op: 'resize'; paneId: string; cols: number; rows: number }
  | { op: 'kill'; paneId: string }
  /** clearUnseen: 돌려준 '손님이 못 본 것' 을 지운다(앱이 처음 읽힐 때 한 번) */
  | { op: 'list'; clearUnseen?: boolean }
  | { op: 'tail'; paneId: string; lines: number }
  | { op: 'stats' }
  | { op: 'shutdown' }

/** 답을 기다리는 요청에는 id 가 붙는다 */
export type HostFrame = HostRequest & { id?: number }

export interface SessionInfo {
  paneId: string
  pid: number
  startedAt: number
  /** 마지막 출력 시각 */
  lastOutputAt: number
  /** 지금 붙은 손님이 있나 */
  attached: boolean
  /** 손님 없이 끝난 셸 — 다음 attach 에서 이유를 준다 */
  exited?: { exitCode: number; signal: number | null }
  /** 셸 통합이 알려 준 마지막 명령 */
  command?: string
  running: boolean
  /** 손님이 없던 동안 생긴 것 — 입력 기다림(벨 · OSC 9 · 777) · 실패(133;D 0 아님) */
  unseen: { waiting: boolean; message?: string; failed?: number }
  /** 손님이 떨어진 뒤 지난 시간 (붙어 있으면 0) */
  detachedMs: number
}

export interface AttachReply {
  found: boolean
  pid?: number
  /** serialize 한 화면 (대체 화면 · 모드 포함) */
  screen?: string
  /** 명령 상태를 되살리는 OSC (마지막 명령 글자 · 실행 중이면 133;C) */
  replay?: string
  detachedMs?: number
  exited?: { exitCode: number; signal: number | null }
}

export interface HostStats {
  version: number
  pid: number
  startedAt: number
  rss: number
  sessions: number
}

const isStr = (v: unknown, max = 4096): v is string => typeof v === 'string' && v.length <= max
const isAbs = (v: unknown): v is string => isStr(v) && v.startsWith('/') && !v.includes('\0')

function validEnv(v: unknown): v is Record<string, string> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const entries = Object.entries(v)
  return entries.length <= 1000 && entries.every(([k, x]) => k.length > 0 && k.length <= 256 && !k.includes('=') && isStr(x, 64 * 1024) && !x.includes('\0'))
}

/** 소켓으로 온 값을 요청으로. 모양이 틀리면 null — 지킴이는 main 이 이미 검사한 값도 다시 본다(같은 사용자의 다른 프로세스도 소켓을 열 수 있다). */
export function parseRequest(v: unknown): HostFrame | null {
  if (typeof v !== 'object' || v === null) return null
  const r = v as Record<string, unknown>
  const id = r['id']
  if (id !== undefined && !(Number.isInteger(id) && (id as number) >= 0)) return null
  const withId = <T extends HostRequest>(req: T): HostFrame => (id === undefined ? req : { ...req, id: id as number })
  const paneId = r['paneId']
  switch (r['op']) {
    case 'hello':
      return Number.isInteger(r['version']) ? withId({ op: 'hello', version: r['version'] as number }) : null
    case 'spawn': {
      const args = r['args']
      if (!isPaneId(paneId) || !isAbs(r['file']) || !isAbs(r['cwd']) || !validSize(r['cols'], r['rows']) || !validEnv(r['env'])) return null
      if (!Array.isArray(args) || args.length > 64 || !args.every((a) => isStr(a) && !a.includes('\0'))) return null
      return withId({ op: 'spawn', paneId, file: r['file'], args: args as string[], cwd: r['cwd'], env: r['env'], cols: r['cols'] as number, rows: r['rows'] as number })
    }
    case 'attach':
    case 'detach':
    case 'kill':
      return isPaneId(paneId) ? withId({ op: r['op'], paneId }) : null
    case 'write':
      return isPaneId(paneId) && validWrite(r['data']) ? withId({ op: 'write', paneId, data: r['data'] }) : null
    case 'resize':
      return isPaneId(paneId) && validSize(r['cols'], r['rows']) ? withId({ op: 'resize', paneId, cols: r['cols'] as number, rows: r['rows'] as number }) : null
    case 'list':
      return withId({ op: 'list', clearUnseen: r['clearUnseen'] === true })
    case 'tail': {
      const lines = r['lines']
      return isPaneId(paneId) && Number.isInteger(lines) && (lines as number) >= 1 && (lines as number) <= 1000 ? withId({ op: 'tail', paneId, lines: lines as number }) : null
    }
    case 'stats':
      return withId({ op: 'stats' })
    case 'shutdown':
      return withId({ op: 'shutdown' })
    default:
      return null
  }
}

/**
 * 지킴이 소켓 경로. 기본은 `<userData>/ptyhost-v<버전>.sock`. 경로가 너무 길면(맥 한도 104바이트)
 * `<tmp>/taskminal-<userData 해시>-v<버전>.sock`. hash 는 부르는 쪽(node crypto)이 준다.
 */
export function socketPath(userData: string, version: number, tmp: string, hash: (s: string) => string): string {
  const inside = `${userData.replace(/\/+$/, '')}/ptyhost-v${version}.sock`
  if (new TextEncoder().encode(inside).length <= MAX_SOCKET_PATH) return inside
  return `${tmp.replace(/\/+$/, '')}/taskminal-${hash(userData).slice(0, 12)}-v${version}.sock`
}

/** 소켓 파일 이름에서 버전 — 다른 버전 지킴이를 찾을 때. prefix 는 지금 소켓 이름의 '-v<n>.sock' 앞 부분 */
export function socketVersion(name: string, prefix = 'ptyhost'): number | null {
  if (!name.startsWith(prefix + '-v')) return null
  const m = /^-v(\d{1,4})\.sock$/.exec(name.slice(prefix.length))
  return m ? Number(m[1]) : null
}

/** 저장된 일감에 없는 셸 */
export function orphanSessions<T extends { paneId: string }>(sessions: readonly T[], statePaneIds: Iterable<string>): T[] {
  const known = new Set(statePaneIds)
  return sessions.filter((s) => !known.has(s.paneId))
}

/** 메모리 경고를 띄울까 — 지킴이 메모리(MB) 또는 셸 수 */
export function memoryWarning(stats: Pick<HostStats, 'rss' | 'sessions'>, warnMb = WARN_RSS_MB, warnSessions = WARN_SESSIONS): boolean {
  return stats.rss >= warnMb * 1024 * 1024 || stats.sessions >= warnSessions
}

/** 다시 붙을 때 renderer 의 활동 상태를 맞추는 OSC — 마지막 명령 글자, 실행 중이면 시작 표시 */
export function replayOsc(state: { commandOsc?: string; running: boolean }): string {
  return (state.commandOsc !== undefined ? `\x1b]6973;${state.commandOsc}\x07` : '') + (state.running ? '\x1b]133;C\x07' : '')
}

/** 다시 연결 n 번째(0부터) 까지 기다릴 시간. 다 썼으면 null. scale 은 시험용(TASKMINAL_PTYHOST_RETRY_MS) */
export function reconnectDelay(attempt: number, scale?: number): number | null {
  const d = RECONNECT_DELAYS[attempt]
  if (d === undefined) return null
  return scale === undefined ? d : scale * (d / 1000)
}

export interface ResumeSummary {
  /** 상태에 있고 지킴이에 살아 있는 셸 — 다시 붙는다 */
  resumed: number
  /** 그중 가장 오래 떨어져 있던 시간 */
  awayMs: number
  /** 꺼져 있던 동안 입력을 기다리게 된 셸 */
  waiting: Array<{ paneId: string; message?: string }>
  /** 꺼져 있던 동안 실패로 끝난 명령 */
  failed: Array<{ paneId: string; code: number }>
}

/** 앱이 처음 읽힐 때 지킴이의 셸 목록을 '이어진 것 · 기다리는 것' 으로 (위 줄 · 사이드바 확인 필요) */
export function summarizeResume(sessions: readonly SessionInfo[], statePaneIds: Iterable<string>): ResumeSummary {
  const known = new Set(statePaneIds)
  const out: ResumeSummary = { resumed: 0, awayMs: 0, waiting: [], failed: [] }
  for (const s of sessions) {
    if (!known.has(s.paneId)) continue
    if (!s.exited) {
      out.resumed++
      out.awayMs = Math.max(out.awayMs, s.detachedMs)
    }
    if (s.unseen.waiting) out.waiting.push(s.unseen.message !== undefined ? { paneId: s.paneId, message: s.unseen.message } : { paneId: s.paneId })
    if (s.unseen.failed !== undefined) out.failed.push({ paneId: s.paneId, code: s.unseen.failed })
  }
  return out
}
