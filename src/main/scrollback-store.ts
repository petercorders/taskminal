import { chmodSync, closeSync, fchmodSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, writeSync } from 'node:fs'
import { chmod, mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isPaneId } from '../shared/pty'

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

/** renderer 가 보낸 값 — 믿지 않고 여기서 거른다: live 는 맞는 paneId 만, 글은 live 안의 문자열만 */
function parse(live: unknown, panes: unknown): { live: Set<string>; texts: Array<[string, string]> } {
  const ids = new Set(Array.isArray(live) ? live.filter(isPaneId) : [])
  const texts: Array<[string, string]> = []
  if (panes && typeof panes === 'object') {
    for (const [id, text] of Object.entries(panes as Record<string, unknown>)) {
      if (ids.has(id) && typeof text === 'string') texts.push([id, trimToBytes(text, MAX_SCROLLBACK_BYTES)])
    }
  }
  return { live: ids, texts }
}

const paneOf = (name: string): string | null => (name.endsWith('.txt') ? name.slice(0, -4) : null)
const asError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)))

/**
 * <userData>/scrollback/<paneId>.txt 의 주인 (13단계). 터미널 출력에는 비밀값이 섞일 수 있어 폴더 0700 · 파일 0600.
 * 읽기 · 주기 저장은 비동기(main 스레드에서 pty 출력 전달을 막지 않게), 페이지가 내려갈 때만 동기(saveSync).
 * node fs 만 쓴다 — vitest 에서 실제 임시 폴더로 시험한다.
 */
export class ScrollbackStore {
  constructor(private readonly dir: string) {}
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
      return { text, savedAt: info.mtimeMs }
    } catch {
      return null // 없음 · 읽기 실패 — 되살리지 않고 셸만 띄운다
    }
  }

  /** 주기 저장. 실패(디스크 가득 · 권한)는 던지지 않고 돌려준다 — 스크롤은 덤이라 앱을 멈추지 않는다. */
  async save(live: unknown, panes: unknown): Promise<Error | null> {
    const req = parse(live, panes)
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
    const req = parse(live, panes)
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
}
