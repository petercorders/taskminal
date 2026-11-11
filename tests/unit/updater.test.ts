import { describe, expect, it, vi } from 'vitest'
import { INSTALL_TIMEOUT_MS, Updater, type UpdateEngine, type UpdatePrefs } from '../../src/main/updater'
import { UPDATE_CHECK_MS, type UpdateView } from '../../src/shared/update'

/** 끝을 시험이 정하는 약속 */
function gate<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

class FakeEngine implements UpdateEngine {
  checks = 0
  downloads = 0
  installs = 0
  check = gate<{ version: string; notes: unknown } | null>()
  download = gate<void>()
  progress: ((p: { percent: number; transferred: number; total: number }) => void) | null = null
  errorFn: ((e: unknown) => void) | null = null
  async checkForUpdate() {
    this.checks++
    return this.check.promise
  }
  async downloadUpdate(onProgress: (p: { percent: number; transferred: number; total: number }) => void) {
    this.downloads++
    this.progress = onProgress
    return this.download.promise
  }
  install() {
    this.installs++
  }
  onError(fn: (e: unknown) => void) {
    this.errorFn = fn
  }
}

function setup(prefs: UpdatePrefs = { download: true, skip: '' }) {
  const engine = new FakeEngine()
  const views: UpdateView[] = []
  const logs: string[] = []
  const calls: string[] = []
  const p = { ...prefs }
  const u = new Updater(engine, {
    current: '0.1.0',
    prefs: () => p,
    now: () => 1000,
    send: (v) => views.push(v),
    log: (_level, key) => logs.push(key),
    beforeInstall: () => calls.push('before'),
    installFailed: () => calls.push('failed'),
  })
  const flush = () => new Promise((r) => setTimeout(r, 0))
  return { engine, views, logs, calls, p, u, flush }
}

describe('Updater', () => {
  it('확인 중 · 받는 중에 다시 확인하면 무시한다 (한 번에 하나 — 쌓이지 않음)', async () => {
    const { engine, u, flush } = setup()
    void u.check()
    void u.check()
    expect(engine.checks).toBe(1)
    engine.check.resolve({ version: '0.1.1', notes: '- 고침' })
    await flush()
    expect(u.view().state).toBe('downloading')
    void u.check()
    expect(engine.checks).toBe(1)
    engine.download.resolve()
    await flush()
    expect(u.view()).toMatchObject({ state: 'downloaded', version: '0.1.1', notes: ['고침'], more: 0 })
  })

  it('새 버전이 없으면 latest + 확인 시각', async () => {
    const { engine, u, flush } = setup()
    void u.check()
    engine.check.resolve(null)
    await flush()
    expect(u.view()).toMatchObject({ state: 'latest', checkedAt: 1000 })
  })

  it('받기가 꺼져 있으면 available 에서 멈추고, download() 로 받는다', async () => {
    const { engine, u, flush } = setup({ download: false, skip: '' })
    void u.check()
    engine.check.resolve({ version: '0.1.1', notes: null })
    await flush()
    expect(u.view()).toMatchObject({ state: 'available', version: '0.1.1' })
    expect(engine.downloads).toBe(0)
    void u.download()
    engine.progress!({ percent: 42.4, transferred: 35, total: 84 })
    expect(u.view()).toMatchObject({ state: 'downloading', percent: 42, transferred: 35, total: 84 })
  })

  it('건너뛴 버전이면 받지 않고 latest(skipped) — 설정은 결과가 온 때 다시 읽는다 (처음 한 번만 읽지 않음)', async () => {
    const { engine, u, p, flush } = setup()
    void u.check()
    p.skip = '0.1.1' // 확인이 도는 사이 '이 버전 건너뛰기'
    engine.check.resolve({ version: '0.1.1', notes: null })
    await flush()
    expect(engine.downloads).toBe(0)
    expect(u.view()).toMatchObject({ state: 'latest', skipped: '0.1.1' })
  })

  it('받아 둔 버전을 건너뛰면 prefsChanged 로 latest(skipped) — 다음 버전은 다시 알린다', async () => {
    const { engine, u, p, flush } = setup()
    void u.check()
    engine.check.resolve({ version: '0.1.1', notes: null })
    await flush()
    engine.download.resolve()
    await flush()
    p.skip = '0.1.1'
    u.prefsChanged()
    expect(u.view()).toMatchObject({ state: 'latest', skipped: '0.1.1' })
    engine.check = gate()
    engine.download = gate()
    void u.check()
    engine.check.resolve({ version: '0.1.2', notes: null })
    await flush()
    expect(u.view()).toMatchObject({ state: 'downloading', version: '0.1.2' })
  })

  it('지금 버전보다 높지 않으면 새 버전으로 보지 않는다', async () => {
    const { engine, u, flush } = setup()
    void u.check()
    engine.check.resolve({ version: '0.1.0', notes: null })
    await flush()
    expect(u.view().state).toBe('latest')
  })

  it('확인 · 받기 실패 → failed(이유 · 다음 시각) + 오류 기록, 다시 확인할 수 있다', async () => {
    const { engine, u, logs, flush } = setup()
    void u.check()
    engine.check.reject(Object.assign(new Error('getaddrinfo ENOTFOUND github.com'), { code: 'ENOTFOUND' }))
    await flush()
    expect(u.view()).toMatchObject({ state: 'failed', during: 'check', error: '연결이 끊겼어요', nextAt: 1000 + UPDATE_CHECK_MS })
    expect(logs).toEqual(['update-check'])
    engine.check = gate()
    void u.check()
    expect(engine.checks).toBe(2)
    engine.check.resolve({ version: '0.1.1', notes: null })
    await flush()
    engine.download.reject(new Error('sha512 checksum mismatch'))
    await flush()
    expect(u.view()).toMatchObject({ state: 'failed', during: 'download', error: '받은 파일이 손상됐어요', version: '0.1.1' })
    u.install() // 받기에 실패한 버전은 설치하지 않는다 — 다시 시작해서 설치는 받은 뒤 · 설치 실패 뒤에만
    expect(engine.installs).toBe(0)
    expect(u.view().state).toBe('failed')
  })

  it('설치: 받은 뒤에만 · 두 번 눌러도 한 번 · 엔진 오류면 failed(install) 와 installFailed — 다시 누를 수 있다', async () => {
    const { engine, u, calls, logs, flush } = setup()
    u.install()
    expect(engine.installs).toBe(0) // 받기 전
    void u.check()
    engine.check.resolve({ version: '0.1.1', notes: null })
    await flush()
    engine.download.resolve()
    await flush()
    u.install()
    u.install()
    expect(engine.installs).toBe(1)
    expect(calls).toEqual(['before'])
    expect(u.view().state).toBe('installing')
    engine.errorFn!(new Error('Could not get code signature for running application'))
    expect(u.view()).toMatchObject({ state: 'failed', during: 'install', error: '서명을 확인할 수 없어요', version: '0.1.1' })
    expect(calls).toEqual(['before', 'failed'])
    expect(logs).toEqual(['update-install'])
    u.install()
    expect(engine.installs).toBe(2)
  })

  it('설치 중이 아닐 때 엔진 오류 이벤트는 무시한다 (확인 · 받기 실패는 약속으로 온다 — 두 번 세지 않게)', () => {
    const { engine, u, logs } = setup()
    engine.errorFn!(new Error('x'))
    expect(u.view().state).toBe('idle')
    expect(logs).toEqual([])
  })

  it('엔진이 없으면 disabled · 막힌 위치면 blocked — 확인하지 않는다', () => {
    const off = new Updater(null, { current: '0.1.0', prefs: () => ({ download: true, skip: '' }), now: () => 0, send: () => {}, log: () => {}, beforeInstall: () => {}, installFailed: () => {} })
    void off.check()
    expect(off.view().state).toBe('disabled')
    const engine = new FakeEngine()
    const blocked = new Updater(engine, { current: '0.1.0', blocked: 'dmg', prefs: () => ({ download: true, skip: '' }), now: () => 0, send: () => {}, log: () => {}, beforeInstall: () => {}, installFailed: () => {} })
    void blocked.check()
    expect(blocked.view()).toMatchObject({ state: 'blocked', blocked: 'dmg' })
    expect(engine.checks).toBe(0)
  })

  it('받아 둔 뒤 · 설치 실패 뒤에는 다시 확인하지 않는다 — 6시간 주기 · 메뉴가 받은 것을 버리지 않게 (18단계 리뷰)', async () => {
    const { engine, u, flush } = setup()
    void u.check()
    engine.check.resolve({ version: '0.1.1', notes: null })
    await flush()
    engine.download.resolve()
    await flush()
    void u.check()
    expect(engine.checks).toBe(1)
    expect(u.view()).toMatchObject({ state: 'downloaded', version: '0.1.1' })
    u.install()
    engine.errorFn!(new Error('x'))
    void u.check()
    expect(engine.checks).toBe(1)
    expect(u.view()).toMatchObject({ state: 'failed', during: 'install' })
  })

  it('다시 알리기(건너뛰기 풀기)면 그 버전을 바로 다시 알린다 — 받아 둔 것은 downloaded, 아니면 받는다 (18단계 리뷰)', async () => {
    const { engine, u, p, flush } = setup()
    void u.check()
    engine.check.resolve({ version: '0.1.1', notes: null })
    await flush()
    engine.download.resolve()
    await flush()
    p.skip = '0.1.1'
    u.prefsChanged()
    expect(u.view()).toMatchObject({ state: 'latest', skipped: '0.1.1' })
    p.skip = ''
    u.prefsChanged()
    expect(u.view()).toMatchObject({ state: 'downloaded', version: '0.1.1' })
    expect(engine.downloads).toBe(1)

    // 확인 때 이미 건너뛴 버전(받지 않음) → 다시 알리기면 받는다
    const s = setup({ download: true, skip: '0.1.1' })
    void s.u.check()
    s.engine.check.resolve({ version: '0.1.1', notes: null })
    await s.flush()
    expect(s.engine.downloads).toBe(0)
    s.p.skip = ''
    s.u.prefsChanged()
    expect(s.u.view().state).toBe('downloading')
    expect(s.engine.downloads).toBe(1)
  })

  it('설치가 응답 없이 멈추면 시간이 지나 failed(install) · installFailed — 끄기 안내가 막힌 채 남지 않는다 (18단계 리뷰)', async () => {
    vi.useFakeTimers()
    try {
      const { engine, u, calls } = setup()
      void u.check()
      engine.check.resolve({ version: '0.1.1', notes: null })
      await vi.advanceTimersByTimeAsync(0)
      engine.download.resolve()
      await vi.advanceTimersByTimeAsync(0)
      u.install()
      vi.advanceTimersByTime(INSTALL_TIMEOUT_MS - 1)
      expect(u.view().state).toBe('installing')
      vi.advanceTimersByTime(1)
      expect(u.view()).toMatchObject({ state: 'failed', during: 'install' })
      expect(calls).toEqual(['before', 'failed'])
      // 오류가 먼저 오면 시간 초과는 다시 실패시키지 않는다
      u.install()
      engine.errorFn!(new Error('x'))
      vi.advanceTimersByTime(INSTALL_TIMEOUT_MS)
      expect(calls).toEqual(['before', 'failed', 'before', 'failed'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('바뀔 때마다 창에 보낸다', async () => {
    const { engine, u, views, flush } = setup()
    void u.check()
    engine.check.resolve(null)
    await flush()
    expect(views.map((v) => v.state)).toEqual(['checking', 'latest'])
  })
})
