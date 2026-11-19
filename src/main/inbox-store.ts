// 66단계 알림 받은편지함의 주인 — <userData>/inbox.json(0600). 본문에 명령 · 메시지가 섞일 수 있어 쓰기 전에 가린다(renderer 가 가렸다고 믿지 않는다).
// 늘 전체를 임시 파일 → rename 으로 쓴다(한 번 실패해도 다음 쓰기가 전체를 다시 쓴다). 일은 하나씩(큐) — add · read · 지우기가 엇갈리지 않게.
// 깨진 파일은 `.bak` 으로 옮기고 빈 목록으로 시작한다 — 받은편지함은 지난 알림의 사본이라 앱을 멈출 만큼 중요하지 않다.
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { INBOX_BODY_MAX, INBOX_TITLE_MAX, markInboxRead, mergeInbox, parseInboxEntry, pruneInbox, type InboxEntry, type InboxRead } from '../shared/inbox'
import { redact, type SecretOptions } from '../shared/redact'

export class InboxStore {
  private queue: Promise<unknown> = Promise.resolve()
  /** 파일에서 읽은 목록(첫 일에서 한 번 읽는다) */
  private entries: InboxEntry[] | null = null
  constructor(
    private readonly file: string,
    private readonly redactOptions: () => SecretOptions = () => ({}),
    private readonly now: () => number = Date.now,
  ) {}

  private run<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(job, job)
    this.queue = next.catch(() => {})
    return next
  }

  private async load(): Promise<InboxEntry[]> {
    if (this.entries) return this.entries
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      return (this.entries = [])
    }
    try {
      const v: unknown = JSON.parse(raw)
      if (!Array.isArray(v)) throw new Error('형식')
      // 모양이 다른 줄만 버린다(나머지는 남긴다)
      this.entries = pruneInbox(v.map(parseInboxEntry).filter((e): e is InboxEntry => e !== null), this.now())
    } catch {
      await rename(this.file, `${this.file}.bak`).catch(() => {})
      this.entries = []
    }
    return this.entries
  }

  private async save(next: InboxEntry[]): Promise<void> {
    this.entries = next
    await mkdir(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${randomUUID()}.tmp`
    try {
      await writeFile(tmp, JSON.stringify(next), { mode: 0o600 })
      await chmod(tmp, 0o600)
      await rename(tmp, this.file)
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => {})
      throw e
    }
  }

  list(): Promise<InboxEntry[]> {
    return this.run(async () => structuredClone(await this.load()))
  }

  /** 한 줄 남긴다 — 같은 id 는 한 줄. 제목 · 본문은 가린 뒤 */
  add(input: unknown): Promise<void> {
    const parsed = parseInboxEntry(input)
    if (!parsed) return Promise.reject(new Error('알림 기록 모양을 확인해 주세요'))
    const opts = this.redactOptions()
    // 가린 글이 원래보다 길 수 있어 다시 자른다(다음 읽기에서 모양 검사에 버려지지 않게)
    const entry: InboxEntry = { ...parsed, title: redact(parsed.title, opts).slice(0, INBOX_TITLE_MAX), body: redact(parsed.body, opts).slice(0, INBOX_BODY_MAX) }
    return this.run(async () => {
      // 같은 id 는 mergeInbox 가 앞(파일의 것)을 남긴다 — 다시 보낸 것이 본문을 바꾸지 않는다
      await this.save(mergeInbox(await this.load(), [entry], this.now()))
    })
  }

  read(how: InboxRead): Promise<void> {
    return this.run(async () => {
      const cur = await this.load()
      const next = markInboxRead(cur, how)
      if (next !== cur) await this.save([...next])
    })
  }

  removeTask(taskId: string): Promise<void> {
    return this.run(async () => {
      const cur = await this.load()
      const next = cur.filter((e) => e.taskId !== taskId)
      if (next.length !== cur.length) await this.save(next)
    })
  }

  clear(): Promise<void> {
    return this.run(async () => {
      await this.load()
      await this.save([])
    })
  }
}
