import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
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
        this.save(state)
        return { state, readOnly: false, notice: 'corrupt' }
      }
      case 'ok':
        this.writable = true
        return { state: r.state, readOnly: false, notice: null }
    }
  }

  /** 원자적 저장: 임시 파일에 쓰고 fsync 한 뒤 rename — 도중에 꺼져도 옛 파일이나 새 파일 둘 중 하나가 온전히 남는다. */
  save(state: AppState): void {
    if (!this.writable) return
    mkdirSync(this.dir, { recursive: true })
    const tmp = `${this.path}.tmp`
    const fd = openSync(tmp, 'w', 0o600)
    try {
      writeSync(fd, JSON.stringify(state, null, 2))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, this.path)
  }
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')
