// 오류 기록(18단계) — ~/Library/Logs/Taskminal/main-YYYY-MM-DD.log (e2e 는 <userData>/logs).
// 0700 · 0600, 7일 · 폴더 5MB. 쓰기 실패는 앱을 멈추지 않는다(조용히 버림). 글은 비밀값을 가린 뒤에.
import { appendFileSync, chmodSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { expiredLogFiles, groupLog, isLogFileName, LOG_MAX_BYTES, logFileName, logLine, parseLog, type LogLevel, type LogRow } from '../shared/errlog'
import { redact, type SecretOptions } from '../shared/redact'

/** 원문 — 오류면 code + message (stack 은 사용자 폴더 경로가 많아 넣지 않는다) */
export function errorDetail(e: unknown): string | undefined {
  if (e === undefined || e === null) return undefined
  if (e instanceof Error) {
    const code = (e as NodeJS.ErrnoException).code
    return code && !e.message.includes(code) ? `${code}: ${e.message}` : e.message
  }
  return typeof e === 'string' ? e : String(e)
}

export class ErrorLog {
  constructor(
    readonly dir: string,
    private readonly secrets: () => SecretOptions,
    private readonly now: () => number = Date.now,
  ) {}

  write(level: LogLevel, key: string, msg: string, detail?: unknown): void {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      if (this.size() >= LOG_MAX_BYTES) return
      const d = errorDetail(detail)
      const opts = this.secrets()
      const line = logLine({ t: this.now(), level, key, msg: redact(msg, opts), ...(d ? { detail: redact(d, opts) } : {}) })
      const file = join(this.dir, logFileName(this.now()))
      appendFileSync(file, line, { mode: 0o600 })
      chmodSync(file, 0o600) // 이미 있던 파일도
    } catch {
      // 기록 실패로 앱을 멈추지 않는다
    }
  }

  /** 7일 지난 기록 파일을 지운다(시작 때) */
  prune(): void {
    for (const name of expiredLogFiles(this.names(), this.now())) {
      try {
        unlinkSync(join(this.dir, name))
      } catch {
        // 다음에 다시
      }
    }
  }

  rows(level?: LogLevel): LogRow[] {
    const entries = this.names().flatMap((name) => {
      try {
        return parseLog(readFileSync(join(this.dir, name), 'utf8'))
      } catch {
        return []
      }
    })
    return groupLog(entries, this.now(), level)
  }

  private names(): string[] {
    try {
      return readdirSync(this.dir).filter(isLogFileName)
    } catch {
      return []
    }
  }

  private size(): number {
    let total = 0
    for (const name of this.names()) {
      try {
        total += statSync(join(this.dir, name)).size
      } catch {
        // 사라짐
      }
    }
    return total
  }
}
