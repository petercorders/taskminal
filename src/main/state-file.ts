import { closeSync, copyFileSync, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { emptyState, type NewId } from '../shared/model'
import { readStateText } from '../shared/persist'
import type { LoadedState } from '../shared/ipc'
import type { AppState } from '../shared/types'

/** userData/state.json 의 주인. node fs 만 쓴다(vitest 에서 실제 임시 폴더로 시험). */
export class StateFile {
  private readonly path: string
  /** load 전 · 읽기 전용이면 쓰지 않는다 */
  private writable = false

  constructor(
    private readonly dir: string,
    private readonly newId: NewId,
  ) {
    this.path = join(dir, 'state.json')
  }

  load(): LoadedState {
    let text: string | null = null
    try {
      text = readFileSync(this.path, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
    const r = readStateText(text, this.newId)
    switch (r.kind) {
      case 'missing':
        this.writable = true
        return { state: emptyState(), readOnly: false, notice: null }
      case 'newer':
        this.writable = false
        return { state: emptyState(), readOnly: true, notice: 'newer' }
      case 'corrupt': {
        // 원본은 지우지 않고 옆으로 옮긴다. 기본값을 바로 써서 다음 실행이 또 백업하지 않게.
        renameSync(this.path, `${this.path}.${stamp()}.bak`)
        this.writable = true
        const state = emptyState()
        this.trySave(state) // 실패해도 다음 저장이 다시 쓴다
        return { state, readOnly: false, notice: 'corrupt' }
      }
      case 'ok':
        // 검증이 무언가를 버렸으면 다음 저장이 그것을 지우므로, 원본을 먼저 복사해 둔다.
        if (r.lossy) copyFileSync(this.path, `${this.path}.${stamp()}.bak`)
        this.writable = true
        return { state: r.state, readOnly: false, notice: r.lossy ? 'repaired' : null }
    }
  }

  /**
   * 원자적 저장: 임시 파일에 쓰고 fsync 한 뒤 rename, 폴더도 fsync — 도중에 꺼져도 옛 파일이나 새 파일 둘 중
   * 하나가 온전히 남는다. 실패(디스크 가득 · 권한)는 예외 대신 돌려주고 임시 파일을 지운다.
   */
  trySave(state: AppState): Error | null {
    if (!this.writable) return null
    const tmp = `${this.path}.tmp`
    try {
      mkdirSync(this.dir, { recursive: true })
      const fd = openSync(tmp, 'w', 0o600)
      try {
        fchmodSync(fd, 0o600) // 남아 있던 임시 파일은 생성 권한이 적용되지 않는다
        writeSync(fd, JSON.stringify(state, null, 2))
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(tmp, this.path)
      const dirFd = openSync(this.dir, 'r')
      try {
        fsyncSync(dirFd)
      } finally {
        closeSync(dirFd)
      }
      return null
    } catch (e) {
      try {
        rmSync(tmp, { force: true })
      } catch {
        // 지우지도 못하면 다음 저장이 같은 이름으로 덮는다
      }
      return e instanceof Error ? e : new Error(String(e))
    }
  }
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')
