// 51단계: 터미널에서 띄운 claude · codex 의 훅이 덧붙인 pane 기록 파일(`<userData>/agent-events/<paneId>.log`)을 읽는다.
// 파일마다 읽은 위치를 두고 새 줄만 읽는다. 한 번에 읽은 줄 중 마지막 사건만 알린다(이미 지나간 허락 기다림으로 알리지 않게).
// 읽기는 동기라 한 번에 하나다. 폴더 감시(macOS FSEvents)를 놓쳐도 느린 주기로 한 번 더 본다.
import { chmodSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { claudeHookScript, claudeHookSettings, claudeStatusLineScript, codexNotifyScript, parseAgentLine, splitLines, type AgentSignal } from '../shared/agent-hooks'
import { isObj } from '../shared/guards'
import { isPaneId } from '../shared/pty'

export interface HookFiles {
  claudeHook: string
  claudeSettings: string
  claudeStatusLine: string
  codexNotify: string
}

/** 내용이 다를 때만 tmp → rename 으로 바꾼다(도는 claude 가 반쯤 쓴 파일을 읽지 않게). 모드는 늘 맞춘다. */
function writeIfChanged(file: string, text: string, mode: number): void {
  let same = false
  try {
    same = readFileSync(file, 'utf8') === text
  } catch {
    same = false
  }
  if (same) {
    chmodSync(file, mode)
    return
  }
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text, { mode })
  chmodSync(tmp, mode)
  renameSync(tmp, file)
}

/** 앱이 시작할 때 훅 파일을 쓴다 — 앱 경로 · 판이 바뀌어도 새 셸부터 맞는 파일을 본다. */
export function writeHookFiles(hooksDir: string): HookFiles {
  mkdirSync(hooksDir, { recursive: true, mode: 0o700 })
  chmodSync(hooksDir, 0o700)
  const files: HookFiles = {
    claudeHook: join(hooksDir, 'claude-hook.sh'),
    claudeSettings: join(hooksDir, 'claude-settings.json'),
    claudeStatusLine: join(hooksDir, 'claude-statusline.sh'),
    codexNotify: join(hooksDir, 'codex-notify.sh'),
  }
  writeIfChanged(files.claudeHook, claudeHookScript(), 0o700)
  writeIfChanged(files.claudeStatusLine, claudeStatusLineScript(), 0o700)
  writeIfChanged(files.codexNotify, codexNotifyScript(), 0o700)
  writeIfChanged(files.claudeSettings, claudeHookSettings(files.claudeHook, files.claudeStatusLine), 0o600)
  return files
}

const seenSettings = new Map<string, number>()
/**
 * 52단계: 사용자 Claude 설정(`<claudeDir>/settings.json`)의 statusLine 명령을 `user-statusline.cmd` 로 둔다 — 앱 statusLine 스크립트가 잇는다.
 * --settings 의 statusLine 이 사용자 것을 가리므로. 새 셸마다 불러 수정 시각이 바뀌었을 때만 다시 읽는다(처음 한 번만 읽지 않는다).
 * 사용자 설정 파일은 읽기만 한다. 깨진 JSON(쓰는 도중)이면 앞 값을 그대로 둔다.
 */
export function syncUserStatusLine(hooksDir: string, claudeDir: string): void {
  const settings = join(claudeDir, 'settings.json')
  const cmdFile = join(hooksDir, 'user-statusline.cmd')
  let mtime = -1
  try {
    mtime = statSync(settings).mtimeMs
  } catch {
    mtime = -1
  }
  if (seenSettings.get(cmdFile) === mtime) return
  let command: string | null = null
  if (mtime >= 0) {
    try {
      const raw: unknown = JSON.parse(readFileSync(settings, 'utf8').slice(0, 2_000_000))
      const line = isObj(raw) && isObj(raw['statusLine']) ? raw['statusLine'] : null
      command = line && line['type'] === 'command' && typeof line['command'] === 'string' && line['command'].trim() ? line['command'] : null
    } catch {
      return // 다음 새 셸에서 다시 본다(seen 을 바꾸지 않는다)
    }
  }
  seenSettings.set(cmdFile, mtime)
  if (command === null) rmSync(cmdFile, { force: true })
  else writeIfChanged(cmdFile, command, 0o600)
}

interface FileCursor {
  ino: number
  offset: number
  rest: string
}

export interface AgentEventsOptions {
  dir: string
  onSignal: (paneId: string, signal: AgentSignal) => void
  /** 이보다 크면 마지막 줄만 남기고 줄인다 */
  maxBytes?: number
  /** 감시를 놓쳤을 때를 위한 주기(ms). 0 이면 끔(시험) */
  pollMs?: number
  /** 52단계: pane 상태 파일(statusLine 의 rate_limits)이 바뀌었다 — 250ms 로 묶어 한 번 */
  onStatus?: (paneId: string, text: string) => void
}

const LOG = /^([A-Za-z0-9_-]{1,64})\.log$/
const STATUS = /^([A-Za-z0-9_-]{1,64})\.status$/
const STATUS_BATCH_MS = 250
const MAX_LINE = 256

export class AgentEvents {
  private readonly cursors = new Map<string, FileCursor>()
  private readonly lastSignal = new Map<string, { signal: AgentSignal; line: string }>()
  private watcher: FSWatcher | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly statusTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly maxBytes: number

  constructor(private readonly opts: AgentEventsOptions) {
    this.maxBytes = opts.maxBytes ?? 64 * 1024
  }

  /** 폴더를 만들고(0700) 남은 파일의 마지막 사건을 기억한 뒤(알리지 않음) 감시를 건다. */
  start(): void {
    mkdirSync(this.opts.dir, { recursive: true, mode: 0o700 })
    chmodSync(this.opts.dir, 0o700)
    for (const name of readdirSync(this.opts.dir)) {
      const m = LOG.exec(name)
      if (m) this.read(m[1]!, false)
    }
    try {
      this.watcher = watch(this.opts.dir, (_ev, name) => {
        if (typeof name !== 'string') return
        const m = LOG.exec(name)
        if (m) this.poll(m[1]!)
        const st = STATUS.exec(name)
        if (st) this.statusChanged(st[1]!)
      })
      this.watcher.on('error', () => this.watcher?.close())
    } catch {
      this.watcher = null // 감시를 못 걸면 주기만으로 본다
    }
    const every = this.opts.pollMs ?? 3000
    if (every > 0) {
      this.timer = setInterval(() => {
        for (const p of this.cursors.keys()) this.poll(p)
        for (const name of safeList(this.opts.dir)) {
          const m = LOG.exec(name)
          if (m && !this.cursors.has(m[1]!)) this.poll(m[1]!)
        }
      }, every)
      this.timer.unref?.()
    }
  }

  /** statusLine 은 자주 온다 — pane 마다 250ms 동안 모아 한 번 읽는다 */
  private statusChanged(paneId: string): void {
    if (!this.opts.onStatus || this.statusTimers.has(paneId)) return
    const t = setTimeout(() => {
      this.statusTimers.delete(paneId)
      let text = ''
      try {
        text = readFileSync(join(this.opts.dir, `${paneId}.status`), 'utf8').slice(0, 64 * 1024)
      } catch {
        return
      }
      this.opts.onStatus?.(paneId, text)
    }, STATUS_BATCH_MS)
    t.unref?.()
    this.statusTimers.set(paneId, t)
  }

  stop(): void {
    for (const t of this.statusTimers.values()) clearTimeout(t)
    this.statusTimers.clear()
    this.watcher?.close()
    this.watcher = null
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** 셸 환경 변수에 넣는 이 pane 의 기록 파일. pane id 모양이 아니면 null. */
  fileFor(paneId: string): string | null {
    return isPaneId(paneId) ? join(this.opts.dir, `${paneId}.log`) : null
  }

  /** 새 줄을 읽어 마지막 사건을 알린다. */
  poll(paneId: string): void {
    this.read(paneId, true)
  }

  /** pane 별 마지막 사건 — 창 새로 고침 · 앱 재시작 뒤 렌더러가 지금 상태를 맞출 때 */
  last(): Record<string, AgentSignal> {
    return Object.fromEntries([...this.lastSignal].map(([p, v]) => [p, v.signal]))
  }

  /** 새 셸 · pane 닫힘: 앞 셸의 기록을 지운다(죽은 claude 의 작업 중이 남지 않게). */
  forget(paneId: string): void {
    const file = this.fileFor(paneId)
    this.cursors.delete(paneId)
    this.lastSignal.delete(paneId)
    if (file) rmSync(file, { force: true })
    if (file) rmSync(file.replace(/\.log$/, '.status'), { force: true })
  }

  /** 상태에 없는 pane 의 파일을 지운다. */
  keepOnly(paneIds: ReadonlySet<string>): void {
    for (const name of safeList(this.opts.dir)) {
      const m = LOG.exec(name) ?? STATUS.exec(name)
      if (m && !paneIds.has(m[1]!)) this.forget(m[1]!)
    }
    for (const p of [...this.lastSignal.keys()]) if (!paneIds.has(p)) this.forget(p)
  }

  private read(paneId: string, emit: boolean): void {
    const file = this.fileFor(paneId)
    if (!file) return
    let fd: number
    try {
      fd = openSync(file, 'r')
    } catch {
      this.cursors.delete(paneId)
      return
    }
    let last: { signal: AgentSignal; line: string } | null = null
    let size = 0
    try {
      const st = fstatSync(fd)
      size = st.size
      let cur = this.cursors.get(paneId)
      if (!cur || cur.ino !== st.ino || st.size < cur.offset) cur = { ino: st.ino, offset: 0, rest: '' }
      if (st.size === cur.offset) {
        this.cursors.set(paneId, cur)
        return
      }
      // 너무 많이 쌓였으면 끝 쪽만 — 앞의 반쪽 줄은 버린다
      let from = cur.offset
      let rest = cur.rest
      if (st.size - from > this.maxBytes) {
        from = st.size - this.maxBytes
        rest = ''
      }
      const buf = Buffer.alloc(st.size - from)
      let got = 0
      while (got < buf.length) {
        const n = readSync(fd, buf, got, buf.length - got, from + got)
        if (n <= 0) break
        got += n
      }
      const text = rest + buf.subarray(0, got).toString('utf8')
      const { lines, rest: tail } = splitLines(text)
      const usable = from === cur.offset ? lines : lines.slice(1)
      for (const line of usable) {
        const signal = parseAgentLine(line)
        if (signal) last = { signal, line }
      }
      this.cursors.set(paneId, { ino: st.ino, offset: from + got, rest: tail.length > MAX_LINE ? '' : tail })
    } finally {
      closeSync(fd)
    }
    if (last) {
      this.lastSignal.set(paneId, last)
      if (emit) this.opts.onSignal(paneId, last.signal)
    }
    if (size > this.maxBytes) this.compact(paneId, file)
  }

  /** 마지막 사건 한 줄만 남긴다 — 다시 열 때 지금 상태는 그대로 맞는다. 그 사이 덧붙은 줄은 잃을 수 있다(드묾 · 다음 사건이 바로잡는다). */
  private compact(paneId: string, file: string): void {
    const last = this.lastSignal.get(paneId)
    const tmp = `${file}.${process.pid}.tmp`
    try {
      writeFileSync(tmp, last ? `${last.line}\n` : '', { mode: 0o600 })
      renameSync(tmp, file)
      const st = statSync(file)
      this.cursors.set(paneId, { ino: st.ino, offset: st.size, rest: '' })
    } catch {
      rmSync(tmp, { force: true })
    }
  }
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}
