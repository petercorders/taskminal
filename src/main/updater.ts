// 자동 업데이트 진행(18단계) — 엔진(electron-updater)을 감싸 '한 번에 하나' · 건너뛰기 · 받기 설정 · 실패를 정한다.
// 엔진은 시험에서 가짜로 바꾼다(tests/unit/updater.test.ts). 실제 엔진은 index.ts 의 electronUpdaterEngine.
import { compareVersions, noteSummary, UPDATE_CHECK_MS, updateErrorText, type BlockedReason, type UpdateView } from '../shared/update'
import type { LogLevel } from '../shared/errlog'

export interface UpdateProgress {
  percent: number
  transferred: number
  total: number
}
export interface UpdateEngine {
  /** 새 버전 정보(없으면 null) — 실패면 던진다 */
  checkForUpdate(): Promise<{ version: string; notes: unknown } | null>
  downloadUpdate(onProgress: (p: UpdateProgress) => void): Promise<void>
  /** 앱을 끄고 설치 — 실패는 onError 로 온다 */
  install(): void
  onError(fn: (e: unknown) => void): void
}
export interface UpdatePrefs {
  /** 뒤에서 받기 */
  download: boolean
  /** 건너뛴 버전 ('' = 없음) */
  skip: string
}
interface Deps {
  current: string
  blocked?: BlockedReason | null
  /** 설정 — 매번 읽는다(main 이 상태를 받을 때마다 바뀐다) */
  prefs(): UpdatePrefs
  now(): number
  send(view: UpdateView): void
  log(level: LogLevel, key: string, msg: string, detail?: unknown): void
  /** 설치 직전 — main 이 끄기 안내를 건너뛰게 하고 상태를 쓴다 */
  beforeInstall(): void
  /** 설치가 실패했다 — 끄기 안내를 되돌린다 */
  installFailed(): void
}

const BUSY = new Set<UpdateView['state']>(['checking', 'downloading', 'installing'])
/** 설치(Squirrel)가 이 안에 앱을 끄지도 오류를 주지도 않으면 실패로 본다 — 끄기 안내를 막은 채 남지 않게 */
export const INSTALL_TIMEOUT_MS = 60_000

export class Updater {
  private v: UpdateView
  private installTimer: ReturnType<typeof setTimeout> | null = null
  /** 받을(받은) 새 버전 */
  private found: { version: string; notes: unknown } | null = null
  /** 받아 둔 뒤에 건너뛰었다 — 다시 알리기면 받지 않고 downloaded 로 */
  private skippedWhile = false

  constructor(
    private readonly engine: UpdateEngine | null,
    private readonly d: Deps,
  ) {
    this.v = engine === null ? { state: 'disabled', current: d.current } : d.blocked ? { state: 'blocked', current: d.current, blocked: d.blocked } : { state: 'idle', current: d.current }
    engine?.onError((e) => {
      if (this.v.state !== 'installing') return // 확인 · 받기 실패는 약속(reject)으로 이미 받는다
      this.installFail(e)
    })
  }

  view(): UpdateView {
    return this.v
  }

  /** 확인 — 진행 중이면 무시(한 번에 하나). 새 버전이면 설정에 따라 받는다 */
  async check(): Promise<void> {
    if (!this.engine || this.v.state === 'disabled' || this.v.state === 'blocked' || BUSY.has(this.v.state)) return
    // 받아 둔 버전이 있으면(설치 실패 뒤 포함) 다시 확인하지 않는다 — 6시간 주기 · 메뉴가 받은 zip 과 칩을 버리고 다시 받지 않게
    if (this.v.state === 'downloaded' || (this.v.state === 'failed' && this.v.during === 'install')) return
    this.set({ state: 'checking', current: this.d.current })
    let info: { version: string; notes: unknown } | null
    try {
      info = await this.engine.checkForUpdate()
    } catch (e) {
      this.fail('check', e)
      return
    }
    const checkedAt = this.d.now()
    if (!info || compareVersions(info.version, this.d.current) <= 0) {
      this.found = null
      this.set({ state: 'latest', current: this.d.current, checkedAt })
      return
    }
    this.found = info
    this.skippedWhile = false
    const prefs = this.d.prefs() // 결과가 온 지금 다시 읽는다 — 확인이 도는 사이 건너뛰었을 수 있다
    if (prefs.skip === info.version) {
      this.set({ state: 'latest', current: this.d.current, checkedAt, skipped: info.version })
      return
    }
    if (!prefs.download) {
      this.set({ state: 'available', current: this.d.current, checkedAt, version: info.version, ...this.notes() })
      return
    }
    await this.fetch()
  }

  /** 받기 — available 이거나 받기 실패 뒤 (진행 중이면 무시) */
  async download(): Promise<void> {
    if (!this.found || BUSY.has(this.v.state) || this.v.state === 'downloaded') return
    await this.fetch()
  }

  private async fetch(): Promise<void> {
    if (!this.engine || !this.found) return
    const version = this.found.version
    const base = { current: this.d.current, version, ...this.notes(), ...(this.v.checkedAt ? { checkedAt: this.v.checkedAt } : {}) }
    this.set({ ...base, state: 'downloading', percent: 0 })
    try {
      await this.engine.downloadUpdate((p) => {
        if (this.v.state !== 'downloading') return
        this.set({ ...base, state: 'downloading', percent: Math.floor(p.percent), transferred: p.transferred, total: p.total })
      })
    } catch (e) {
      this.fail('download', e)
      return
    }
    // 받는 사이 그 버전을 건너뛰었으면 알리지 않는다
    if (this.d.prefs().skip === version) {
      this.skippedWhile = true
      this.set({ state: 'latest', current: this.d.current, checkedAt: this.d.now(), skipped: version })
    } else this.set({ ...base, state: 'downloaded' })
  }

  /** 다시 시작해서 설치 — 받은 뒤(또는 설치 실패 뒤)에만, 두 번 눌러도 한 번 */
  install(): void {
    const ready = this.v.state === 'downloaded' || (this.v.state === 'failed' && this.v.during === 'install')
    if (!this.engine || !ready) return
    this.set({ ...this.v, state: 'installing' })
    delete this.v.error
    this.d.beforeInstall()
    // 오류가 먼저 오면 installFail 이 이 타이머를 지운다
    this.installTimer = setTimeout(() => this.installFail(new Error('install timed out — no quit or error from Squirrel')), INSTALL_TIMEOUT_MS)
    this.installTimer.unref?.()
    try {
      this.engine.install()
    } catch (e) {
      this.installFail(e)
    }
  }

  private installFail(e: unknown): void {
    if (this.installTimer) clearTimeout(this.installTimer)
    this.installTimer = null
    this.fail('install', e)
    this.d.installFailed()
  }

  /** 설정이 바뀌었다 — 받아 둔(나온) 버전을 건너뛰었으면 최신처럼, 건너뛰기를 풀었으면(다시 알리기) 그 버전을 다시 알린다 */
  prefsChanged(): void {
    const v = this.v
    const prefs = this.d.prefs()
    if ((v.state === 'available' || v.state === 'downloaded' || (v.state === 'failed' && v.version)) && v.version === prefs.skip) {
      this.skippedWhile = v.state === 'downloaded'
      this.set({ state: 'latest', current: this.d.current, checkedAt: v.checkedAt ?? this.d.now(), skipped: v.version })
      return
    }
    if (v.state === 'latest' && v.skipped && v.skipped !== prefs.skip && this.found?.version === v.skipped) {
      const base = { current: this.d.current, version: v.skipped, ...this.notes(), ...(v.checkedAt ? { checkedAt: v.checkedAt } : {}) }
      if (this.skippedWhile) this.set({ ...base, state: 'downloaded' }) // 이미 받아 둔 것
      else if (prefs.download) void this.fetch()
      else this.set({ ...base, state: 'available' })
    }
  }

  private notes(): { notes: string[]; more: number } {
    const s = noteSummary(this.found?.notes)
    return { notes: s.lines, more: s.more }
  }

  private fail(during: 'check' | 'download' | 'install', e: unknown): void {
    const error = updateErrorText(e)
    this.d.log('error', `update-${during}`, during === 'check' ? '업데이트를 확인하지 못했어요' : during === 'download' ? '업데이트를 내려받지 못했어요' : '업데이트를 설치하지 못했어요', e)
    this.set({
      state: 'failed',
      current: this.d.current,
      during,
      error,
      nextAt: this.d.now() + UPDATE_CHECK_MS,
      ...(this.found && during !== 'check' ? { version: this.found.version, ...this.notes() } : {}),
    })
  }

  private set(v: UpdateView): void {
    this.v = v
    this.d.send(v)
  }
}
