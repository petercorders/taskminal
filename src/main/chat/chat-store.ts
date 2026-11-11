import { appendFile, chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isChatEvent, redactEvent, type ChatEvent } from '../../shared/chat'
import type { SecretOptions } from '../../shared/redact'

/** 파일이 이보다 크면 앞쪽을 잘라 뒤 절반만 남긴다 */
export const CHAT_FILE_MAX = 2 * 1024 * 1024

/**
 * 대화 pane 의 화면 기록 (21단계): <userData>/chat/<paneId>.jsonl — `--resume` 은 앞 대화를 다시 내보내지 않으므로(스파이크)
 * 재시작 뒤 보일 대화는 앱이 남긴다. 글 · 명령 · 결과에 비밀값이 섞이므로 쓰기 전에 가린다 · 폴더 0700 · 파일 0600.
 * 일은 하나씩(큐) — 덧붙이기와 지우기 · 자르기가 같은 파일에서 엇갈리지 않게.
 */
export class ChatStore {
  constructor(
    private readonly dir: string,
    private readonly redactOptions: () => SecretOptions = () => ({}),
    private readonly max = CHAT_FILE_MAX,
  ) {}

  private queue: Promise<unknown> = Promise.resolve()
  private run<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(job, job)
    this.queue = next.catch(() => {})
    return next
  }
  private file(paneId: string): string {
    return join(this.dir, `${paneId}.jsonl`)
  }

  append(paneId: string, events: readonly ChatEvent[]): Promise<void> {
    if (events.length === 0) return Promise.resolve()
    return this.run(async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 })
      await chmod(this.dir, 0o700)
      const opts = this.redactOptions()
      const text = events.map((e) => JSON.stringify(redactEvent(e, opts)) + '\n').join('')
      const f = this.file(paneId)
      await appendFile(f, text, { mode: 0o600 })
      await chmod(f, 0o600)
      const size = (await stat(f)).size
      if (size > this.max) await this.trim(f)
    })
  }

  /** 뒤 절반만 남긴다 — 임시 파일 → rename */
  private async trim(f: string): Promise<void> {
    const raw = await readFile(f, 'utf8')
    const lines = raw.split('\n').filter(Boolean)
    let keep: string[] = []
    let bytes = 0
    for (let i = lines.length - 1; i >= 0; i--) {
      bytes += Buffer.byteLength(lines[i]!) + 1
      if (bytes > this.max / 2) break
      keep.unshift(lines[i]!)
    }
    if (keep.length === 0) keep = lines.slice(-1)
    const tmp = `${f}.tmp`
    await writeFile(tmp, keep.join('\n') + '\n', { mode: 0o600 })
    await rename(tmp, f)
  }

  /** 화면에 다시 그릴 이벤트 — 깨진 줄은 버린다. 없으면 [] */
  read(paneId: string): Promise<ChatEvent[]> {
    return this.run(async () => {
      let raw: string
      try {
        raw = await readFile(this.file(paneId), 'utf8')
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw e
      }
      const out: ChatEvent[] = []
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        try {
          const v: unknown = JSON.parse(line)
          if (isChatEvent(v)) out.push(v)
        } catch {
          /* 깨진 줄 */
        }
      }
      return out
    })
  }

  remove(paneId: string): Promise<void> {
    return this.run(() => rm(this.file(paneId), { force: true }))
  }
}
