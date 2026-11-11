import { createHash } from 'node:crypto'
import { chmodSync, closeSync, fchmodSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { backupName, parseBackupName, pruneBackups, type BackupInfo, type BackupReason } from '../shared/backup'
import type { NewId } from '../shared/model'
import { readStateText } from '../shared/persist'
import type { AppState } from '../shared/types'

const VERSION_FILE = 'last-version'
const asError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)))

/**
 * <userData>/backups/ 의 주인 (17단계). 백업 = 그 순간 디스크의 state.json 사본(바뀌기 전 모습).
 * 폴더 0700 · 파일 0600 · 임시 파일 → rename. 바로 앞 백업과 내용이 같으면 만들지 않는다.
 * node fs 만 쓴다 — vitest 에서 실제 임시 폴더로 시험한다.
 */
export class BackupStore {
  private readonly dir: string
  private readonly statePath: string
  /** 가장 새 백업의 sha256 — 처음 쓸 때 파일에서 읽는다 */
  private lastHash: string | null | undefined

  constructor(
    userData: string,
    private readonly tzOffset: () => number = () => new Date().getTimezoneOffset(),
  ) {
    this.dir = join(userData, 'backups')
    this.statePath = join(userData, 'state.json')
  }

  private entries() {
    let names: string[] = []
    try {
      names = readdirSync(this.dir)
    } catch {
      return []
    }
    return names.map(parseBackupName).filter((e): e is NonNullable<typeof e> => e !== null)
  }

  private newestHash(): string | null {
    if (this.lastHash !== undefined) return this.lastHash
    const newest = this.entries().sort((a, b) => b.at - a.at)[0]
    try {
      this.lastHash = newest ? sha(readFileSync(join(this.dir, newest.name))) : null
    } catch {
      this.lastHash = null
    }
    return this.lastHash
  }

  /**
   * 지금 state.json 을 백업한다. 만든 이름 · 같아서 건너뜀(null) · 실패(Error). state.json 이 없으면 null. force = 같아도 만듦.
   * 실패해도 던지지 않는다 — 상태 저장을 막지 않는다.
   */
  snapshot(reason: BackupReason, now = Date.now(), force = false): string | null | Error {
    let data: Buffer
    try {
      data = readFileSync(this.statePath)
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : asError(e)
    }
    const hash = sha(data)
    // 사용자가 부른 백업(되돌리기 전 · 가져오기 전)은 같은 내용이어도 만든다 — 목록에 그 이름으로 남는다고 알려 주므로
    if (!force && hash === this.newestHash()) return null
    const name = backupName(now, reason)
    const path = join(this.dir, name)
    const tmp = `${path}.tmp`
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      chmodSync(this.dir, 0o700)
      const fd = openSync(tmp, 'w', 0o600)
      try {
        fchmodSync(fd, 0o600)
        writeSync(fd, data)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(tmp, path)
    } catch (e) {
      try {
        rmSync(tmp, { force: true })
      } catch {
        // 다음 백업이 같은 이름을 쓰지 않는다(시각) — 남은 임시 파일은 이름 모양이 달라 목록에 안 나온다
      }
      return asError(e)
    }
    this.lastHash = hash
    this.prune(now)
    return name
  }

  /** 보존 규칙(shared/backup pruneBackups)에 따라 지운다. 지우기 실패는 다음 백업 때 다시 */
  prune(now = Date.now()): void {
    for (const name of pruneBackups(this.entries(), now, this.tzOffset())) {
      try {
        rmSync(join(this.dir, name), { force: true })
      } catch {
        // 다음에
      }
    }
  }

  /** 새 것부터. 일감 수는 파일을 읽어 센다(못 읽으면 null). 비동기 — 백업 수십 개를 main 스레드에서 한 번에 읽지 않게 */
  async list(): Promise<BackupInfo[]> {
    const out: BackupInfo[] = []
    for (const e of this.entries().sort((a, b) => b.at - a.at)) {
      const path = join(this.dir, e.name)
      let bytes = 0
      let tasks: number | null = null
      try {
        bytes = (await stat(path)).size
        const raw = JSON.parse(await readFile(path, 'utf8')) as { tasks?: unknown }
        tasks = Array.isArray(raw.tasks) ? raw.tasks.length : null
      } catch {
        // 깨진 백업 · 그 사이 지워짐 — 목록에는 두고 읽을 때 알린다
      }
      out.push({ ...e, bytes, tasks })
    }
    return out
  }

  /** 이름 모양을 검사한 뒤(경로 탈출 막음) 읽어 검증한 상태 — 못 쓰는 백업이면 Error */
  read(name: unknown, newId: NewId): AppState | Error {
    const entry = typeof name === 'string' ? parseBackupName(name) : null
    if (!entry) return new Error('모르는 백업이에요')
    let text: string
    try {
      text = readFileSync(join(this.dir, entry.name), 'utf8')
    } catch (e) {
      return asError(e)
    }
    const r = readStateText(text, newId)
    return r.kind === 'ok' ? r.state : new Error(r.kind === 'newer' ? '더 새 버전 앱이 만든 백업이에요' : '읽을 수 없는 백업이에요')
  }

  /** 손상 복구 — 새 것부터 읽을 수 있는 첫 백업 */
  latestGood(newId: NewId): { state: AppState; at: number } | null {
    for (const e of this.entries().sort((a, b) => b.at - a.at)) {
      const state = this.read(e.name, newId)
      if (!(state instanceof Error)) return { state, at: e.at }
    }
    return null
  }

  /** 마지막으로 백업을 만든 앱 버전 (처음이면 null) */
  lastVersion(): string | null {
    try {
      return readFileSync(join(this.dir, VERSION_FILE), 'utf8').trim() || null
    } catch {
      return null
    }
  }

  writeVersion(version: string): void {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      writeFileSync(join(this.dir, VERSION_FILE), version, { mode: 0o600 })
    } catch {
      // 다음 시작에 '버전' 백업을 한 번 더 만들 뿐
    }
  }
}

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex')
