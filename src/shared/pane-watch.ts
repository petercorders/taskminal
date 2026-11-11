// `taskminal pane wait` 의 판단 (24단계) — 셸 출력에서 OSC 133(A 프롬프트 · C 시작 · D;코드 끝)과 글을 뽑아
// pane 마다 '도는 중 · 마지막 끝 코드 · 마지막 출력 시각' 을 들고, 기다리는 조건이 맞으면 알린다. 순수(시계는 주입).

import { parseOsc133 } from './activity'
import type { WaitFor } from './cli'

export type Mark = { kind: 'prompt' } | { kind: 'start' } | { kind: 'end'; code: number | null }

/** 조각난 출력에서 OSC 133 과 화면 글(제어 문자 · ESC 열을 뺀 것)을 뽑는다 — 잘린 ESC 열은 다음 조각에 붙인다 */
export class OscScanner {
  private carry = ''

  push(data: string): { marks: Mark[]; text: string } {
    const s = this.carry + data
    this.carry = ''
    const marks: Mark[] = []
    let text = ''
    let i = 0
    while (i < s.length) {
      const ch = s.charCodeAt(i)
      if (ch !== 0x1b) {
        // 줄바꿈 · 탭만 남기고 다른 제어 문자는 뺀다
        if (ch >= 0x20 || ch === 0x0a || ch === 0x09) text += s[i]
        i++
        continue
      }
      const next = s[i + 1]
      if (next === undefined) {
        this.carry = s.slice(i)
        break
      }
      if (next === ']') {
        // OSC: BEL 또는 ESC \ 로 끝난다
        let j = i + 2
        let end = -1
        let term = 0
        for (; j < s.length; j++) {
          if (s.charCodeAt(j) === 0x07) {
            end = j
            term = 1
            break
          }
          if (s.charCodeAt(j) === 0x1b && s[j + 1] === '\\') {
            end = j
            term = 2
            break
          }
        }
        if (end < 0) {
          // 끝이 아직 안 왔다 — 너무 길면(망가진 열) 버린다
          if (s.length - i < 8192) this.carry = s.slice(i)
          break
        }
        const body = s.slice(i + 2, end)
        const semi = body.indexOf(';')
        if (semi > 0 && body.slice(0, semi) === '133') {
          const ev = parseOsc133(body.slice(semi + 1))
          if (ev?.type === 'prompt') marks.push({ kind: 'prompt' })
          else if (ev?.type === 'start') marks.push({ kind: 'start' })
          else if (ev?.type === 'end') marks.push({ kind: 'end', code: ev.code })
        }
        i = end + term
        continue
      }
      if (next === '[') {
        // CSI: 마지막 글자가 0x40~0x7e
        let j = i + 2
        while (j < s.length && !(s.charCodeAt(j) >= 0x40 && s.charCodeAt(j) <= 0x7e)) j++
        if (j >= s.length) {
          if (s.length - i < 256) this.carry = s.slice(i)
          break
        }
        i = j + 1
        continue
      }
      // 그 밖의 ESC 열(ESC c · ESC ( B …) — 두세 글자
      i += next === '(' || next === ')' ? 3 : 2
    }
    return { marks, text }
  }
}

export type WaitResult =
  | { kind: 'exit'; code: number | null; ms?: number; already?: boolean }
  | { kind: 'prompt' }
  | { kind: 'idle'; quietMs: number }
  | { kind: 'text'; line: string }
  | { kind: 'shell-exit'; code: number }
  | { kind: 'timeout' }
  | { kind: 'cancelled' }

export interface Clock {
  now(): number
  /** fn 을 ms 뒤에 — 돌려준 함수로 취소 */
  later(fn: () => void, ms: number): () => void
}

interface PaneState {
  scanner: OscScanner
  running: boolean
  startedAt?: number
  lastCode?: number | null
  lastOutputAt: number
  /** 마지막 입력(↩) 시각 — 보낸 명령이 아직 시작 표시(C)를 안 보냈을 수 있다 */
  lastSendAt?: number
  /** 마지막 C 시각 */
  lastStartAt?: number
  exited?: number
}

interface Waiter {
  paneId: string
  cond: WaitFor
  done(r: WaitResult): void
  /** 아직 명령 시작(C)을 보지 못했다 — 보내지 않은 시작 명령 · 막 보낸 입력. 시작을 본 뒤에야 끝 · 프롬프트를 센다 */
  needStart: boolean
  /** text: 기다리기 시작한 뒤의 글 */
  buf: string
  quietMs: number
  timeout: () => void
  /** idle 다음 확인 · 시작을 기다리는 여유 */
  extra: (() => void) | null
}

export interface WaitOptions {
  timeoutMs: number
  quietMs: number
  /** 지금 화면 끝 글 (text 조건) */
  screen?: string
  /** 아직 보내지 않은 시작 명령이 있는 pane — exit · prompt 는 그 명령이 끝난 뒤 */
  pending?: boolean
}

/** 보낸 명령이 시작 표시를 보낼 때까지 기다리는 시간 — 넘으면 시작하지 않은 것(답 입력 등)으로 본다 */
export const START_GRACE_MS = 3000
const BUF_MAX = 64 * 1024

export class PaneWatch {
  private panes = new Map<string, PaneState>()
  private waiters = new Set<Waiter>()

  constructor(private readonly clock: Clock) {}

  private state(paneId: string): PaneState {
    let p = this.panes.get(paneId)
    if (!p) {
      p = { scanner: new OscScanner(), running: false, lastOutputAt: 0 }
      this.panes.set(paneId, p)
    }
    return p
  }

  /** 지킴이가 아는 것으로 처음 값을 채운다 (출력을 아직 못 본 pane) */
  seed(paneId: string, info: { running: boolean; lastOutputAt: number; exited?: number }): void {
    const known = this.panes.has(paneId)
    const p = this.state(paneId)
    if (!known) {
      p.running = info.running
      p.lastOutputAt = info.lastOutputAt
    }
    if (info.exited !== undefined) p.exited = info.exited
  }

  feed(paneId: string, data: string): void {
    const p = this.state(paneId)
    const now = this.clock.now()
    p.lastOutputAt = now
    const { marks, text } = p.scanner.push(data)
    for (const mk of marks) {
      if (mk.kind === 'start') {
        p.running = true
        p.startedAt = now
        p.lastStartAt = now
        for (const w of this.of(paneId)) {
          w.needStart = false
          if (w.cond.kind !== 'idle') this.clearExtra(w)
        }
      } else if (mk.kind === 'end') {
        p.running = false
        p.lastCode = mk.code
        const ms = p.startedAt !== undefined ? { ms: now - p.startedAt } : {}
        for (const w of this.of(paneId)) if (w.cond.kind === 'exit' && !w.needStart) this.finish(w, { kind: 'exit', code: mk.code, ...ms })
      } else {
        p.running = false
        for (const w of this.of(paneId)) if (w.cond.kind === 'prompt' && !w.needStart) this.finish(w, { kind: 'prompt' })
      }
    }
    for (const w of this.of(paneId)) {
      if (w.cond.kind === 'text' && text) {
        w.buf = (w.buf + text).slice(-BUF_MAX)
        const line = findLine(w.buf, w.cond.text)
        if (line !== null) this.finish(w, { kind: 'text', line })
      }
      if (w.cond.kind === 'idle') this.armIdle(w)
    }
  }

  /** 셸이 끝났다 */
  exit(paneId: string, code: number): void {
    const p = this.state(paneId)
    p.exited = code
    p.running = false
    for (const w of this.of(paneId)) this.finish(w, { kind: 'shell-exit', code })
  }

  /** 입력을 보냈다(↩ 포함이면 enter) — idle · exit 판단의 기준 */
  sent(paneId: string, enter: boolean): void {
    const p = this.state(paneId)
    const now = this.clock.now()
    p.lastOutputAt = Math.max(p.lastOutputAt, now)
    if (enter) p.lastSendAt = now
  }

  forget(paneId: string): void {
    this.panes.delete(paneId)
  }

  /** 조건이 맞을 때까지. cancel 로 끊는다(연결이 끊김) */
  wait(paneId: string, cond: WaitFor, o: WaitOptions): { result: Promise<WaitResult>; cancel(): void } {
    let done!: (r: WaitResult) => void
    const result = new Promise<WaitResult>((r) => (done = r))
    const p = this.state(paneId)
    const w: Waiter = { paneId, cond, done, needStart: false, buf: '', quietMs: o.quietMs, timeout: () => {}, extra: null }
    const cancel = () => this.finish(w, { kind: 'cancelled' })
    this.waiters.add(w)
    w.timeout = this.clock.later(() => this.finish(w, { kind: 'timeout' }), o.timeoutMs)
    if (p.exited !== undefined) {
      this.finish(w, { kind: 'shell-exit', code: p.exited })
      return { result, cancel }
    }
    if (cond.kind === 'exit' || cond.kind === 'prompt') {
      const settle = () => this.finish(w, cond.kind === 'exit' ? { kind: 'exit', code: p.lastCode ?? null, already: true } : { kind: 'prompt' })
      if (p.running) return { result, cancel } // 다음 끝 · 프롬프트
      if (o.pending) {
        w.needStart = true // 그 시작 명령이 돌고 끝날 때까지(시간 제한까지)
        return { result, cancel }
      }
      const grace = this.graceLeft(p)
      if (grace <= 0) settle()
      else {
        // 막 보낸 입력이 명령을 시작하면 그 끝까지, 여유 안에 시작하지 않으면 지금 모습
        w.needStart = true
        w.extra = this.clock.later(() => {
          w.extra = null
          if (w.needStart) settle()
        }, grace)
      }
      return { result, cancel }
    }
    if (cond.kind === 'idle') this.armIdle(w)
    else if (cond.kind === 'text') {
      const line = o.screen ? findLine(o.screen, cond.text) : null
      if (line !== null) this.finish(w, { kind: 'text', line })
    }
    return { result, cancel }
  }

  /** 시험 · 상태 확인 */
  snapshot(paneId: string): { running: boolean; lastCode?: number | null; waiters: number } {
    const p = this.panes.get(paneId)
    return { running: p?.running ?? false, ...(p?.lastCode !== undefined ? { lastCode: p.lastCode } : {}), waiters: this.of(paneId).length }
  }

  private graceLeft(p: PaneState): number {
    if (p.lastSendAt === undefined || (p.lastStartAt !== undefined && p.lastStartAt >= p.lastSendAt)) return 0
    return p.lastSendAt + START_GRACE_MS - this.clock.now()
  }

  private clearExtra(w: Waiter): void {
    w.extra?.()
    w.extra = null
  }

  private armIdle(w: Waiter): void {
    const p = this.state(w.paneId)
    const quietFor = this.clock.now() - p.lastOutputAt
    if (quietFor >= w.quietMs) return this.finish(w, { kind: 'idle', quietMs: w.quietMs })
    // 다음 확인 — 출력이 또 오면 앞 확인을 버리고 다시 잡는다
    this.clearExtra(w)
    w.extra = this.clock.later(() => {
      w.extra = null
      this.armIdle(w)
    }, w.quietMs - quietFor)
  }

  private of(paneId: string): Waiter[] {
    return [...this.waiters].filter((w) => w.paneId === paneId)
  }

  private finish(w: Waiter, r: WaitResult): void {
    if (!this.waiters.delete(w)) return
    w.timeout()
    this.clearExtra(w)
    w.done(r)
  }
}

/** 글이 든 줄 (앞뒤 공백 뺌) — 없으면 null */
export function findLine(buf: string, needle: string): string | null {
  const at = buf.indexOf(needle)
  if (at < 0) return null
  const start = buf.lastIndexOf('\n', at) + 1
  const end = buf.indexOf('\n', at + needle.length)
  return buf.slice(start, end < 0 ? undefined : end).replace(/\r/g, '').trim()
}
