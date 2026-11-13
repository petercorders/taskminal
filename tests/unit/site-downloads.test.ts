import { afterEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error — 정적 홈페이지 모듈
import { detectPlatform, releaseAssets, wireDownloads } from '../../site/assets/downloads.mjs'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

function page(lang = 'ko') {
  const label = { textContent: '' }
  const primary = { href: '', querySelector: () => label }
  const note = { textContent: '' }, status = { textContent: '' }
  const cards = ['macArm', 'macIntel', 'windows', 'linux', 'linuxDeb'].map((platform) => {
    const attrs = new Map<string, string>()
    const link = { textContent: '', href: '', setAttribute: (k: string, v: string) => attrs.set(k, v), removeAttribute: (k: string) => { attrs.delete(k); if (k === 'href') link.href = '' } }
    const state = { textContent: '' }
    return { dataset: { platformDownload: platform }, attrs, link, state, classList: { add: vi.fn() }, querySelector: (s: string) => s === '[data-platform-link]' ? link : state }
  })
  const document = {
    documentElement: { lang, dataset: {} },
    querySelector: () => status,
    querySelectorAll: (s: string) => s === 'a[data-dl]' ? [primary] : s === '[data-platform-download]' ? cards : [note],
  }
  vi.stubGlobal('document', document)
  return { primary, label, note, status, cards }
}

describe('홈페이지 OS별 다운로드', () => {
  it('데스크톱과 모바일을 구분하고 모르는 Mac 칩을 추측하지 않는다', async () => {
    expect(await detectPlatform({ platform: 'MacIntel', userAgent: 'Macintosh', maxTouchPoints: 0 })).toBe('mac')
    expect(await detectPlatform({ platform: 'MacIntel', userAgent: 'iPad', maxTouchPoints: 5 })).toBe('mobile')
    expect(await detectPlatform({ platform: 'Win32', userAgent: 'Windows NT' })).toBe('windows')
    expect(await detectPlatform({ platform: 'Linux x86_64', userAgent: 'Linux' })).toBe('linux')
    expect(await detectPlatform({ platform: 'Linux', userAgent: 'Android' })).toBe('mobile')
    expect(await detectPlatform({ platform: '', userAgent: '' })).toBe('unknown')
    expect(await detectPlatform({ platform: 'Linux aarch64', userAgent: 'Linux' })).toBe('unknown')
    expect(await detectPlatform({ userAgentData: { platform: 'Windows', getHighEntropyValues: async () => ({ architecture: 'arm', bitness: '64' }) } })).toBe('unknown')
    expect(await detectPlatform({ userAgentData: { platform: 'Linux', getHighEntropyValues: async () => ({ architecture: 'x86', bitness: '32' }) } })).toBe('unknown')
  })
  it('Mac UA-CH 칩을 사용하고 거부되면 명시적 선택으로 남긴다', async () => {
    const nav = (architecture: string) => ({ userAgent: 'Macintosh', userAgentData: { platform: 'macOS', getHighEntropyValues: async () => ({ architecture }) } })
    expect(await detectPlatform(nav('arm'))).toBe('macArm')
    expect(await detectPlatform(nav('x86'))).toBe('macIntel')
    expect(await detectPlatform(nav('unknown'))).toBe('mac')
    expect(await detectPlatform({ userAgentData: { platform: 'macOS', getHighEntropyValues: async () => { throw Error('denied') } } })).toBe('mac')
  })
  it('OS와 칩이 정확히 일치하는 설치 파일만 고른다', () => {
    const names = ['Taskminal-0.1.2-mac-arm64.dmg', 'Taskminal-0.1.2-mac-x64.dmg', 'Taskminal-0.1.2-win-x64.exe', 'Taskminal-0.1.2-linux-x64.AppImage', 'Taskminal-0.1.2-linux-x64.deb']
    const assets = names.map((name) => ({ name, browser_download_url: `https://github.com/petercorders/taskminal/releases/download/v0.1.2/${name}` }))
    const got = releaseAssets({ assets })
    expect(got.macArm.name).toBe(names[0])
    expect(got.macIntel.name).toBe(names[1])
    expect(got.windows.name).toBe(names[2])
    expect(got.linux.name).toBe(names[3])
    expect(got.linuxDeb.name).toBe(names[4])
    expect(releaseAssets({ assets: [assets[0]] }).macIntel).toBeUndefined()
    expect(releaseAssets({ draft: true, assets })).toEqual({})
    expect(releaseAssets({ prerelease: true, assets })).toEqual({})
  })
  it('외부 URL·잘못된 저장소·타 아키텍처·깨진 API 데이터는 내려받기로 연결하지 않는다', () => {
    expect(releaseAssets(null)).toEqual({})
    expect(releaseAssets({ assets: {} })).toEqual({})
    const assets = [
      { name: 'Taskminal-0.1.2-mac-arm64.dmg', browser_download_url: 'javascript:alert(1)' },
      { name: 'Taskminal-0.1.2-mac-x64.dmg', browser_download_url: 'https://evil.test/file.dmg' },
      { name: 'Taskminal-0.1.2-win-arm64.exe', browser_download_url: 'https://github.com/petercorders/taskminal/releases/download/v0.1.2/a.exe' },
      { name: 'Taskminal-0.1.2-linux-x64.AppImage', browser_download_url: 'https://github.com/other/repo/releases/download/v0.1.2/file.AppImage' },
    ]
    expect(releaseAssets({ assets })).toEqual({})
  })

  it('Windows에서는 exe를 추천하고 없는 Mac Intel 파일은 비활성화한다', async () => {
    const p = page()
    vi.stubGlobal('navigator', { platform: 'Win32' })
    const url = 'https://github.com/petercorders/taskminal/releases/download/v0.1.2/Taskminal-0.1.2-win-x64.exe'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ tag_name: 'v0.1.2', assets: [{ name: 'Taskminal-0.1.2-win-x64.exe', browser_download_url: url }] }) }))
    await wireDownloads()
    expect(p.primary.href).toBe(url)
    expect(p.label.textContent).toContain('Windows')
    expect(p.cards[2].link.href).toBe(url)
    expect(p.cards[1].link.href).toBe('')
    expect(p.cards[1].attrs.get('aria-disabled')).toBe('true')
    expect(p.status.textContent).toContain('v0.1.2')
  })

  it('모바일에서도 모든 플랫폼 목록을 유지하며 실패 시 릴리스 복구를 알린다', async () => {
    const p = page('en')
    vi.stubGlobal('navigator', { userAgent: 'iPhone' })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Error('offline')))
    await wireDownloads()
    expect(p.primary.href).toBe('#downloads')
    expect(p.note.textContent).toContain('desktop app')
    expect(p.status.textContent).toContain('GitHub Releases')
    expect(p.cards.every((c) => c.attrs.get('aria-disabled') === 'true')).toBe(true)
  })

  it('응답 없는 조회는 10초 뒤 복구 상태로 끝난다', async () => {
    vi.useFakeTimers()
    const p = page()
    vi.stubGlobal('navigator', { platform: 'Linux' })
    vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('timeout'))))))
    const result = wireDownloads()
    await vi.advanceTimersByTimeAsync(10_000)
    await result
    expect(p.status.textContent).toContain('불러오지 못했어요')
    expect(p.primary.href).toBe('#downloads')
  })
})
