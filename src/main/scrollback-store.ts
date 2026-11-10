import { chmodSync, closeSync, fchmodSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { isPaneId } from '../shared/pty'

/** pane 하나의 스크롤 글 상한 — 넘으면 버린다(renderer 를 믿지 않는다). 한글은 글자당 3바이트라 바이트로 센다. */
export const MAX_SCROLLBACK_BYTES = 2 * 1024 * 1024

export interface ScrollbackSave {
  /** 상태에 있는 모든 pane — 이 밖의 파일은 지운다(닫은 pane · 지운 일감) */
  live: unknown
  /** 이번에 바뀐 pane 의 글 */
  panes: unknown
}

/**
 * <userData>/scrollback/<paneId>.txt 의 주인 (13단계). 터미널 출력에는 비밀값이 섞일 수 있어 폴더 0700 · 파일 0600.
 * node fs 만 쓴다 — vitest 에서 실제 임시 폴더로 시험한다.
 */
export class ScrollbackStore {
  constructor(private readonly dir: string) {}

  private file(paneId: string): string {
    return join(this.dir, `${paneId}.txt`)
  }

  load(paneId: unknown): { text: string; savedAt: number } | null {
    if (!isPaneId(paneId)) return null
    try {
      const path = this.file(paneId)
      const text = readFileSync(path, 'utf8')
      return { text, savedAt: statSync(path).mtimeMs }
    } catch {
      return null // 없음 · 읽기 실패 — 되살리지 않고 셸만 띄운다
    }
  }

  /** 실패(디스크 가득 · 권한)는 던지지 않고 돌려준다 — 스크롤은 덤이라 앱을 멈추지 않는다. */
  save(req: ScrollbackSave): Error | null {
    const live = new Set(Array.isArray(req.live) ? req.live.filter(isPaneId) : [])
    const panes = req.panes && typeof req.panes === 'object' ? (req.panes as Record<string, unknown>) : {}
    let firstError: Error | null = null
    const fail = (e: unknown) => (firstError ??= e instanceof Error ? e : new Error(String(e)))
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      chmodSync(this.dir, 0o700)
    } catch (e) {
      return fail(e)
    }
    for (const [paneId, text] of Object.entries(panes)) {
      if (!live.has(paneId) || typeof text !== 'string') continue
      if (Buffer.byteLength(text) > MAX_SCROLLBACK_BYTES) {
        this.remove(paneId)
        continue
      }
      const error = this.write(paneId, text)
      if (error) fail(error)
    }
    try {
      for (const name of readdirSync(this.dir)) {
        const paneId = name.endsWith('.txt') ? name.slice(0, -4) : null
        if (paneId === null || !live.has(paneId)) rmSync(join(this.dir, name), { force: true })
      }
    } catch (e) {
      fail(e)
    }
    return firstError
  }

  /** 설정에서 끄면 모두 지운다 */
  clear(): void {
    try {
      for (const name of readdirSync(this.dir)) rmSync(join(this.dir, name), { force: true })
    } catch {
      // 폴더가 없으면 지울 것도 없다
    }
  }

  private remove(paneId: string): void {
    try {
      rmSync(this.file(paneId), { force: true })
    } catch {
      // 다음 저장이 live 정리로 다시 본다
    }
  }

  /** 원자적 쓰기: 임시 파일 → rename. 도중에 꺼져도 옛 글이나 새 글 하나가 온전히 남는다. */
  private write(paneId: string, text: string): Error | null {
    const path = this.file(paneId)
    const tmp = `${path}.tmp`
    try {
      const fd = openSync(tmp, 'w', 0o600)
      try {
        fchmodSync(fd, 0o600)
        writeSync(fd, text)
      } finally {
        closeSync(fd)
      }
      renameSync(tmp, path)
      return null
    } catch (e) {
      try {
        rmSync(tmp, { force: true })
      } catch {
        // 남은 임시 파일은 다음 live 정리가 지운다
      }
      return e instanceof Error ? e : new Error(String(e))
    }
  }
}
