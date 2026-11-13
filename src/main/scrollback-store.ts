import { chmodSync, closeSync, fchmodSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, writeSync } from 'node:fs'
import { chmod, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RedactStatus } from '../shared/ipc'
import { isPaneId } from '../shared/pty'
import { findSecrets, redact, type SecretOptions } from '../shared/redact'

/** pane 하나의 스크롤 글 상한 — 넘으면 뒤(최근)만 남긴다(renderer 를 믿지 않는다). 한글은 글자당 3바이트라 바이트로 센다. */
export const MAX_SCROLLBACK_BYTES = 2 * 1024 * 1024

/** 상한을 넘으면 뒤쪽 max 바이트만, 잘린 첫 줄은 버려 줄 처음부터 (글자 · 이스케이프가 반쯤 남지 않게) */
export function trimToBytes(text: string, max: number): string {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= max) return text
  const tail = buf.subarray(buf.length - max).toString('utf8')
  const nl = tail.indexOf('\n')
  return nl >= 0 ? tail.slice(nl + 1) : ''
}

/**
 * renderer 가 보낸 값 — 믿지 않고 여기서 거른다: live 는 맞는 paneId 만, 글은 live 안의 문자열만.
 * 디스크로 가기 전 비밀값을 가린다(17단계) — renderer 가 가렸다고 믿지 않는다.
 */
function parse(live: unknown, panes: unknown, mask: (id: string, text: string) => string): { live: Set<string>; texts: Array<[string, string]> } {
  const ids = new Set(Array.isArray(live) ? live.filter(isPaneId) : [])
  const texts: Array<[string, string]> = []
  if (panes && typeof panes === 'object') {
    for (const [id, text] of Object.entries(panes as Record<string, unknown>)) {
      if (ids.has(id) && typeof text === 'string') texts.push([id, mask(id, trimToBytes(text, MAX_SCROLLBACK_BYTES))])
    }
  }
  return { live: ids, texts }
}

/** 가리기 옵션이 같은지 — 내 종류 · 가리지 않기로 한 값 */
const optsKey = (o: SecretOptions): string => JSON.stringify([o.custom ?? [], [...(o.allow ?? [])].sort(), [...(o.toggles ?? [])].sort()])

const PANE_FILE = /^[A-Za-z0-9_-]{1,128}\.txt$/

const paneOf = (name: string): string | null => (name.endsWith('.txt') ? name.slice(0, -4) : null)
const asError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)))

/**
 * <userData>/scrollback/<paneId>.txt 의 주인 (13단계). 터미널 출력에는 비밀값이 섞일 수 있어 폴더 0700 · 파일 0600.
 * 읽기 · 주기 저장은 비동기(main 스레드에서 pty 출력 전달을 막지 않게), 페이지가 내려갈 때만 동기(saveSync).
 * node fs 만 쓴다 — vitest 에서 실제 임시 폴더로 시험한다.
 */
export class ScrollbackStore {
  constructor(
    private readonly dir: string,
    /** 가리기 옵션 — 저장할 때마다 새로 읽는다(설정의 '가리지 않기로 한 값' · 내 종류가 바뀌면 바로) */
    private readonly redactOptions: () => SecretOptions = () => ({}),
  ) {}
  private status: RedactStatus = { state: 'idle', done: 0, total: 0, masked: 0, failed: [] }

  get redactStatus(): RedactStatus {
    return this.status
  }
  /** pane 마다 지난번 가린 결과 — 주기 저장마다 바뀌지 않은 2MB 를 다시 훑지 않게(같은 글 · 같은 옵션일 때만) */
  private masked = new Map<string, { text: string; key: string; out: string }>()

  private mask(opts: SecretOptions): (id: string, text: string) => string {
    const key = optsKey(opts)
    return (id, text) => {
      const hit = this.masked.get(id)
      if (hit && hit.text === text && hit.key === key) return hit.out
      const out = redact(text, opts)
      this.masked.set(id, { text, key, out })
      return out
    }
  }

  /** saveSync 마다 +1 — 그 사이에 끝나는 옛 주기 저장이 새 글을 덮거나 새 pane 파일을 지우지 않게 */
  private generation = 0

  private file(paneId: string): string {
    return join(this.dir, `${paneId}.txt`)
  }

  async load(paneId: unknown): Promise<{ text: string; savedAt: number } | null> {
    if (!isPaneId(paneId)) return null
    try {
      const path = this.file(paneId)
      const [text, info] = await Promise.all([readFile(path, 'utf8'), stat(path)])
      return { text: redact(text, this.redactOptions()), savedAt: info.mtimeMs }
    } catch {
      return null // 없음 · 읽기 실패 — 되살리지 않고 셸만 띄운다
    }
  }

  /** 주기 저장. 실패(디스크 가득 · 권한)는 던지지 않고 돌려준다 — 스크롤은 덤이라 앱을 멈추지 않는다. */
  async save(live: unknown, panes: unknown): Promise<Error | null> {
    const req = parse(live, panes, this.mask(this.redactOptions()))
    for (const id of this.masked.keys()) if (!req.live.has(id)) this.masked.delete(id)
    const gen = this.generation
    let first: Error | null = null
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 })
      await chmod(this.dir, 0o700)
    } catch (e) {
      return asError(e)
    }
    for (const [id, text] of req.texts) {
      const tmp = `${this.file(id)}.tmp-async`
      try {
        const fh = await open(tmp, 'w', 0o600)
        try {
          await fh.chmod(0o600) // 남아 있던 임시 파일은 생성 권한이 적용되지 않는다
          await fh.writeFile(text, 'utf8')
          await fh.sync()
        } finally {
          await fh.close()
        }
        if (gen !== this.generation) {
          // 페이지가 내려가며(saveSync) 더 새 글을 이미 썼다 — 옛 글로 덮지 않는다
          await rm(tmp, { force: true })
          return first
        }
        await rename(tmp, this.file(id))
      } catch (e) {
        first ??= asError(e)
        await rm(tmp, { force: true }).catch(() => {})
      }
    }
    if (gen !== this.generation) return first
    try {
      for (const name of await readdir(this.dir)) {
        const id = paneOf(name)
        if (id === null || !req.live.has(id)) await rm(join(this.dir, name), { force: true })
      }
    } catch (e) {
      first ??= asError(e)
    }
    return first
  }

  /** 페이지가 내려갈 때(앱 종료 · 창 닫기 · 새로 고침) — 다 쓴 뒤에 돌아와야 해서 동기. 규칙은 save 와 같다. */
  saveSync(live: unknown, panes: unknown): Error | null {
    this.generation++
    const req = parse(live, panes, this.mask(this.redactOptions()))
    let first: Error | null = null
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      chmodSync(this.dir, 0o700)
    } catch (e) {
      return asError(e)
    }
    for (const [id, text] of req.texts) {
      const tmp = `${this.file(id)}.tmp`
      try {
        const fd = openSync(tmp, 'w', 0o600)
        try {
          fchmodSync(fd, 0o600)
          writeSync(fd, text)
          fsyncSync(fd) // rename 뒤 전원이 꺼져도 빈 파일이 남지 않게
        } finally {
          closeSync(fd)
        }
        renameSync(tmp, this.file(id))
      } catch (e) {
        first ??= asError(e)
        try {
          rmSync(tmp, { force: true })
        } catch {
          // 남은 임시 파일은 다음 live 정리가 지운다
        }
      }
    }
    try {
      for (const name of readdirSync(this.dir)) {
        const id = paneOf(name)
        if (id === null || !req.live.has(id)) rmSync(join(this.dir, name), { force: true })
      }
    } catch (e) {
      first ??= asError(e)
    }
    return first
  }

  /**
   * 이미 남은 스크롤 파일을 한 번 가린다(17단계 업데이트 뒤 첫 실행). 파일마다 임시 → rename(0600), 바뀐 것만 쓴다.
   * 모두 읽었을 때만 표시 파일(marker)을 만든다 — 못 읽은 것이 있으면 다음 실행 · 다시 시도에서 또 본다.
   * 그 사이 지워진 파일(live 정리)은 건너뛴다. 부르는 쪽이 저장과 한 줄로 세운다(겹치지 않게).
   */
  async redactExisting(marker: string, onProgress: (s: RedactStatus) => void, only?: string[]): Promise<RedactStatus> {
    if (!only) {
      try {
        await stat(marker)
        this.status = { state: 'done', done: 0, total: 0, masked: 0, failed: [] }
        return this.status
      } catch {
        // 아직 안 함
      }
    }
    let names: string[] = []
    try {
      names = only ?? (await readdir(this.dir)).filter((n) => PANE_FILE.test(n))
    } catch {
      names = [] // 폴더가 없음 — 정리할 것 없음
    }
    const keepFailed = only ? this.status.failed.filter((n) => !only.includes(n)) : []
    const masked0 = only ? this.status.masked : 0
    // 다시 시도 · 지우기(only)는 첫 정리의 전체 수를 그대로 둔다 — '0개를 정리했어요' 로 바뀌지 않게
    const total = only ? Math.max(this.status.total, names.length) : names.length
    this.status = { state: 'running', done: total - names.length, total, masked: masked0, failed: [...keepFailed] }
    onProgress(this.status)
    const opts = this.redactOptions()
    for (const name of names) {
      const path = join(this.dir, name)
      const gen = this.generation
      try {
        const text = await readFile(path, 'utf8')
        const count = findSecrets(text.replace(/\x1b\[[0-9;:?<=>]*[ -/]*[@-~]/g, ''), opts).length
        const out = redact(text, opts)
        if (out !== text) {
          const tmp = `${path}.tmp-redact`
          await writeFile(tmp, out, { mode: 0o600 })
          await chmod(tmp, 0o600)
          if (gen !== this.generation) {
            // 읽은 뒤 페이지가 내려가며(saveSync) 새 글(이미 가린 것)을 쓰거나 파일을 지웠다 — 옛 글로 덮지 않는다
            await rm(tmp, { force: true })
            this.status = { ...this.status, done: this.status.done + 1 }
            onProgress(this.status)
            continue
          }
          await rename(tmp, path)
          this.status = { ...this.status, masked: this.status.masked + count }
        } else {
          await chmod(path, 0o600)
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.status = { ...this.status, failed: [...this.status.failed, name] }
      }
      this.status = { ...this.status, done: this.status.done + 1 }
      onProgress(this.status)
    }
    this.status = { ...this.status, state: 'done', finishedAt: Date.now() }
    if (this.status.failed.length === 0) {
      try {
        await writeFile(marker, new Date().toISOString(), { mode: 0o600 })
      } catch {
        // 다음 실행이 다시 정리한다(가린 글을 다시 가려도 같다)
      }
    }
    onProgress(this.status)
    return this.status
  }

  /** 못 읽은 파일: 다시 시도 · 지우기. 이름은 pane 파일 모양만 */
  async fixRedact(action: 'retry' | 'delete', name: string, marker: string, onProgress: (s: RedactStatus) => void = () => {}): Promise<RedactStatus> {
    if (!PANE_FILE.test(name)) throw new Error('모르는 파일')
    if (action === 'delete') {
      await rm(join(this.dir, name), { force: true })
      this.status = { ...this.status, failed: this.status.failed.filter((n) => n !== name) }
      return this.redactExisting(marker, onProgress, [])
    }
    return this.redactExisting(marker, onProgress, [name])
  }
}
