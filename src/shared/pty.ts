// pty IPC 인자 검사와 출력 묶기. main 이 쓰지만 순수 로직이라 shared 에 두고 단위 시험한다.

export const MAX_WRITE = 1024 * 1024 // 한 번에 받는 입력 상한 (붙여넣기 포함)
const FLUSH_MS = 8 // 출력이 이어지는 동안 IPC 를 프레임보다 자주 보내지 않게
const FLUSH_BYTES = 64 * 1024 // 이만큼 모이면 기다리지 않고 보낸다 (cat 큰 파일 등)

export const isPaneId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v)

const isDim = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 1000

export const validSize = (cols: unknown, rows: unknown): boolean => isDim(cols) && isDim(rows)

export const validWrite = (data: unknown): data is string => typeof data === 'string' && data.length <= MAX_WRITE

/** fn 을 ms 뒤에 부르고, 취소 함수를 돌려준다. main 에서는 setTimeout, 시험에서는 가짜 시계. */
export type Schedule = (fn: () => void, ms: number) => () => void

/** pane 별로 출력 조각을 모아 FLUSH_MS 마다(또는 FLUSH_BYTES 넘으면 바로) 한 번에 보낸다. */
export class OutputBatcher {
  private readonly pending = new Map<string, { chunks: string[]; size: number; cancel: () => void }>()

  constructor(
    private readonly send: (paneId: string, data: string) => void,
    private readonly schedule: Schedule,
  ) {}

  push(paneId: string, data: string): void {
    let entry = this.pending.get(paneId)
    if (!entry) {
      entry = { chunks: [], size: 0, cancel: this.schedule(() => this.flush(paneId), FLUSH_MS) }
      this.pending.set(paneId, entry)
    }
    entry.chunks.push(data)
    entry.size += data.length
    if (entry.size >= FLUSH_BYTES) this.flush(paneId)
  }

  flush(paneId: string): void {
    const entry = this.pending.get(paneId)
    if (!entry) return
    entry.cancel()
    this.pending.delete(paneId)
    this.send(paneId, entry.chunks.join(''))
  }

  drop(paneId: string): void {
    this.pending.get(paneId)?.cancel()
    this.pending.delete(paneId)
  }
}

/** 큰 붙여넣기를 MAX_WRITE 이하 조각으로 나눈다. 서로게이트 쌍(이모지 등)은 가르지 않는다. */
export function splitForWrite(data: string, max = MAX_WRITE): string[] {
  const parts: string[] = []
  let i = 0
  while (i < data.length) {
    let end = Math.min(i + max, data.length)
    const last = data.charCodeAt(end - 1)
    if (end < data.length && last >= 0xd800 && last <= 0xdbff) end -= 1 // 높은 서로게이트에서 끊기면 하나 앞에서
    parts.push(data.slice(i, end))
    i = end
  }
  return parts
}

const isUtf8 = (v: string | undefined): boolean => v !== undefined && /utf-?8/i.test(v)

/** 셸에 넘길 환경. 앱 · Electron 내부 변수는 빼고, 글자 인코딩은 UTF-8 이 되게 바로잡는다. */
export function shellEnv(base: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue
    if (k.startsWith('ELECTRON_') || k.startsWith('TASKMINAL_') || k === 'NODE_OPTIONS') continue
    env[k] = v
  }
  env['TERM'] = 'xterm-256color'
  env['COLORTERM'] = 'truecolor'
  env['TERM_PROGRAM'] = 'Taskminal'
  // 글자 인코딩은 LC_ALL > LC_CTYPE > LANG 순으로 정해진다. UTF-8 이 아니면 한글이 깨진다(Finder 실행 · LC_ALL=C).
  for (const k of ['LC_ALL', 'LC_CTYPE']) if (env[k] !== undefined && !isUtf8(env[k])) delete env[k]
  if (!isUtf8(env['LANG'])) env['LANG'] = 'en_US.UTF-8'
  return env
}

/**
 * 셸이 깨끗하게 끝났나 (exit 0 · 신호 없음). 깨끗하면 pane 을 바로 닫고, 아니면 이유를 보여 주고 키를 누를 때 닫는다
 * (iTerm 의 'Close if the session ends cleanly' 와 같은 규칙 — 시작하자마자 죽는 셸이 말없이 사라지지 않게).
 */
export function cleanExit(exit: { exitCode: number; signal: number | null }): boolean {
  return exit.exitCode === 0 && !exit.signal
}

/**
 * 셸 통합 환경. zsh 이고 통합 폴더가 있으면 ZDOTDIR 을 그 폴더로 바꿔 띄운다 — 그 폴더의 시작 파일이 사용자 설정을
 * 그대로 읽은 뒤 명령 시작/끝 표시(OSC 133)만 더하고, 끝나면 ZDOTDIR 을 원래대로 돌린다(resources/shell/zsh).
 * 원래 ZDOTDIR 이 있었으면 TASKMINAL_USER_ZDOTDIR 로 넘긴다. 아니면 env 를 그대로 돌려준다.
 */
export function integrationEnv(env: Record<string, string>, shellPath: string, dir: string | null): Record<string, string> {
  if (!dir || !/(^|\/)zsh$/.test(shellPath)) return env
  const out: Record<string, string> = { ...env, ZDOTDIR: dir }
  if (env['ZDOTDIR']) out['TASKMINAL_USER_ZDOTDIR'] = env['ZDOTDIR']
  return out
}

/** 설정의 셸 경로 — /etc/shells 에 있는 절대 경로만 받는다(renderer 가 보낸 값을 그대로 실행하지 않게). 아니면 $SHELL → /bin/zsh. */
export function pickShell(requested: string | null | undefined, envShell: string | undefined, allowed: readonly string[]): string {
  if (requested && requested.startsWith('/') && allowed.includes(requested)) return requested
  return envShell || '/bin/zsh'
}
