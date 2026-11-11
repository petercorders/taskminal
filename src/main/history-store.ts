import { appendFile, chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HISTORY_MAX, isHistoryId, parseEntry, prune, type HistoryEntry } from '../shared/history'
import { redact, type SecretOptions } from '../shared/redact'

/** 한 번에 받는 줄 수 — 그보다 많으면 renderer 가 이상하다 */
export const APPEND_MAX = 50
/** 덧붙이다 이만큼 넘으면 그때 잘라 다시 쓴다(줄마다 다시 쓰지 않게) */
const PRUNE_SLACK = 100

/**
 * 명령 기록의 주인 (19단계): <userData>/history/<taskId>.jsonl. 명령 · 출력 꼬리에 비밀값이 섞일 수 있어 폴더 0700 · 파일 0600,
 * 쓰기 전에 가린다(renderer 가 가렸다고 믿지 않는다). 덧붙이기만 하고, 지우기 · 자르기는 임시 파일 → rename.
 * 일은 하나씩(큐) — 덧붙이기와 지우기가 같은 파일에서 엇갈리지 않게.
 */
export class HistoryStore {
  constructor(
    private readonly dir: string,
    /** 가리기 옵션 — 쓸 때마다 새로 읽는다(설정의 '가리지 않기로 한 값' · 내 종류가 바뀌면 바로) */
    private readonly redactOptions: () => SecretOptions = () => ({}),
    private readonly now: () => number = Date.now,
  ) {}

  private queue: Promise<unknown> = Promise.resolve()
  /** 일감마다 파일에 있는 id — 같은 줄을 두 번 쓰지 않게(결과 모름 뒤 다시 보낸 것) */
  private ids = new Map<string, Set<string>>()

  private run<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(job, job)
    this.queue = next.catch(() => {})
    return next
  }

  private file(taskId: string): string {
    return join(this.dir, `${taskId}.jsonl`)
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    await chmod(this.dir, 0o700)
  }

  /** 파일의 줄 — 깨진 줄 · 다른 일감 줄은 버린다. 없으면 [] */
  private async read(taskId: string): Promise<{ entries: HistoryEntry[]; bad: number }> {
    let raw: string
    try {
      raw = await readFile(this.file(taskId), 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], bad: 0 }
      throw e
    }
    const entries: HistoryEntry[] = []
    let bad = 0
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      let v: unknown
      try {
        v = JSON.parse(line)
      } catch {
        bad++
        continue
      }
      const e = parseEntry(v)
      if (e && e.taskId === taskId) entries.push(e)
      else bad++
    }
    return { entries, bad }
  }

  private async rewrite(taskId: string, entries: readonly HistoryEntry[]): Promise<void> {
    const file = this.file(taskId)
    if (entries.length === 0) {
      await rm(file, { force: true })
      this.ids.set(taskId, new Set())
      return
    }
    const tmp = `${file}.tmp`
    await writeFile(tmp, entries.map((e) => JSON.stringify(e) + '\n').join(''), { mode: 0o600 })
    await chmod(tmp, 0o600)
    await rename(tmp, file)
    this.ids.set(taskId, new Set(entries.map((e) => e.id)))
  }

  private async idsOf(taskId: string): Promise<Set<string>> {
    let set = this.ids.get(taskId)
    if (!set) {
      set = new Set((await this.read(taskId)).entries.map((e) => e.id))
      this.ids.set(taskId, set)
    }
    return set
  }

  /** 모든 일감의 기록 — 90일 · 5,000개를 넘은 것 · 깨진 줄은 버리고 그 파일을 다시 쓴다 */
  list(): Promise<HistoryEntry[]> {
    return this.run(async () => {
      let names: string[]
      try {
        names = await readdir(this.dir)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw e
      }
      const out: HistoryEntry[] = []
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue
        const taskId = name.slice(0, -6)
        if (!isHistoryId(taskId)) continue
        const { entries, bad } = await this.read(taskId)
        const kept = prune(entries, this.now())
        if (bad > 0 || kept.length !== entries.length) await this.rewrite(taskId, kept)
        else this.ids.set(taskId, new Set(kept.map((e) => e.id)))
        out.push(...kept)
      }
      return out
    })
  }

  /** 끝난 명령 몇 줄 — 쓴 줄 수를 돌려준다(이미 있는 id 는 건너뜀). 50개 넘는 묶음은 예외 */
  append(raw: unknown): Promise<number> {
    return this.run(async () => {
      if (!Array.isArray(raw)) return 0
      if (raw.length > APPEND_MAX) throw new Error(`기록은 한 번에 ${APPEND_MAX}개까지`)
      const byTask = new Map<string, HistoryEntry[]>()
      for (const v of raw) {
        const e = parseEntry(v)
        if (e) byTask.set(e.taskId, [...(byTask.get(e.taskId) ?? []), e])
      }
      if (byTask.size === 0) return 0
      await this.ensureDir()
      const opts = this.redactOptions()
      let written = 0
      for (const [taskId, list] of byTask) {
        const ids = await this.idsOf(taskId)
        const fresh = list.filter((e, i) => !ids.has(e.id) && list.findIndex((o) => o.id === e.id) === i)
        if (fresh.length === 0) continue
        const masked = fresh.map((e) => ({ ...e, cmd: redact(e.cmd, opts), cwd: redact(e.cwd, opts), tail: e.tail.map((l) => redact(l, opts)) }))
        const file = this.file(taskId)
        await appendFile(file, masked.map((e) => JSON.stringify(e) + '\n').join(''), { mode: 0o600 })
        await chmod(file, 0o600)
        for (const e of masked) ids.add(e.id)
        written += masked.length
        if (ids.size > HISTORY_MAX + PRUNE_SLACK) await this.rewrite(taskId, prune((await this.read(taskId)).entries, this.now()))
      }
      return written
    })
  }

  /** 기록 몇 줄 지우기 (토스트의 되돌리기가 끝난 뒤) — 없는 일감 · id 는 조용히 */
  remove(taskId: unknown, ids: unknown): Promise<void> {
    return this.run(async () => {
      if (!isHistoryId(taskId) || !Array.isArray(ids)) return
      const drop = new Set(ids.filter((v): v is string => typeof v === 'string'))
      const { entries } = await this.read(taskId)
      const kept = entries.filter((e) => !drop.has(e.id))
      if (kept.length !== entries.length) await this.rewrite(taskId, kept)
    })
  }

  /** 일감을 지우면 그 기록도 */
  removeTask(taskId: unknown): Promise<void> {
    return this.run(async () => {
      if (!isHistoryId(taskId)) return
      await rm(this.file(taskId), { force: true })
      this.ids.delete(taskId)
    })
  }

  /** 설정 › 개인정보 › 명령 기록 모두 지우기 */
  clear(): Promise<void> {
    return this.run(async () => {
      let names: string[] = []
      try {
        names = await readdir(this.dir)
      } catch {
        return
      }
      for (const name of names) if (name.endsWith('.jsonl') || name.endsWith('.jsonl.tmp')) await rm(join(this.dir, name), { force: true })
      this.ids.clear()
    })
  }
}
