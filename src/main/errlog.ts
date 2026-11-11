// 오류 기록(18단계) — ~/Library/Logs/Taskminal/main-YYYY-MM-DD.log (e2e 는 <userData>/logs).
// 0700 · 0600, 7일 · 폴더 5MB. 쓰기 실패는 앱을 멈추지 않는다(조용히 버림). 글은 비밀값을 가린 뒤에.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
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
  /** 폴더 크기 — 처음 쓸 때 한 번 재고 그 뒤로는 쓴 만큼 더한다(쓸 때마다 폴더를 훑지 않게) */
  private bytes: number | null = null
  constructor(
    readonly dir: string,
    private readonly secrets: () => SecretOptions,
    private readonly now: () => number = Date.now,
  ) {}

  write(level: LogLevel, key: string, msg: string, detail?: unknown): void {
    try {
      const d = errorDetail(detail)
      const opts = this.secrets()
      const line = logLine({ t: this.now(), level, key, msg: redact(msg, opts), ...(d ? { detail: redact(d, opts) } : {}) })
      const size = Buffer.byteLength(line)
      if (this.bytes === null) {
        mkdirSync(this.dir, { recursive: true, mode: 0o700 })
        this.bytes = this.size()
      }
      // 넘치면 오래된 날의 파일부터 지워 자리를 만든다 — 오늘 파일만으로 넘치면 오늘은 더 쓰지 않는다
      if (this.bytes + size > LOG_MAX_BYTES) this.makeRoom(size)
      if (this.bytes + size > LOG_MAX_BYTES) return
      const file = join(this.dir, logFileName(this.now()))
      const fresh = !existsSync(file)
      appendFileSync(file, line, { mode: 0o600 })
      if (fresh) chmodSync(file, 0o600) // umask 와 상관없이
      this.bytes += size
    } catch {
      this.bytes = null // 폴더가 지워졌을 수 있다 — 다음에 다시 만들고 잰다
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
    this.bytes = null // 다음 쓰기에서 다시 잰다
  }

  private makeRoom(size: number): void {
    const today = logFileName(this.now())
    for (const name of this.names().sort()) {
      if (name === today || this.bytes! + size <= LOG_MAX_BYTES) break
      try {
        const n = statSync(join(this.dir, name)).size
        unlinkSync(join(this.dir, name))
        this.bytes! -= n
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
