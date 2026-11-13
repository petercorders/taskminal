export const REPO = 'petercorders/taskminal'
export const RELEASES = `https://github.com/${REPO}/releases/latest`

export async function detectPlatform(nav = navigator) {
  const ua = nav.userAgent || ''
  const platform = nav.userAgentData?.platform || nav.platform || ''
  if (/iPhone|iPad|iPod|Android/i.test(ua) || (/Mac/i.test(platform) && nav.maxTouchPoints > 1)) return 'mobile'
  const desktop = /Win/i.test(platform) || /Windows/i.test(ua) ? 'windows' : /Linux/i.test(platform) || /Linux/i.test(ua) ? 'linux' : null
  if (desktop) {
    if (/aarch64|arm64|armv\d/i.test(`${platform} ${ua}`)) return 'unknown'
    try {
      const result = await nav.userAgentData?.getHighEntropyValues(['architecture', 'bitness'])
      if (result?.architecture === 'arm' || result?.bitness === '32') return 'unknown'
    } catch { /* 명시적인 x64 선택지는 항상 목록에 남긴다. */ }
    return desktop
  }
  if (!/Mac/i.test(platform) && !/Macintosh/i.test(ua)) return 'unknown'
  try {
    const result = await nav.userAgentData?.getHighEntropyValues(['architecture'])
    if (result?.architecture === 'arm') return 'macArm'
    if (result?.architecture === 'x86') return 'macIntel'
  } catch { /* 브라우저가 칩 정보를 숨기면 두 Mac 선택지를 제공한다. */ }
  return 'mac'
}

const PATTERNS = {
  macArm: /-(?:mac-)?arm64\.dmg$/i,
  macIntel: /-mac-x64\.dmg$/i,
  windows: /-win-x64\.exe$/i,
  linux: /-linux-x64\.AppImage$/i,
  linuxDeb: /-linux-x64\.deb$/i,
}

export function releaseAssets(release) {
  if (!release || release.draft || release.prerelease || !Array.isArray(release.assets)) return {}
  const assets = {}
  for (const [platform, pattern] of Object.entries(PATTERNS)) {
    const asset = release.assets.find((a) => {
      if (!a || typeof a.name !== 'string' || !pattern.test(a.name)) return false
      try {
        const url = new URL(a.browser_download_url)
        return url.origin === 'https://github.com' && url.pathname.startsWith(`/${REPO}/releases/download/`)
      } catch { return false }
    })
    if (asset) assets[platform] = asset
  }
  return assets
}

const TEXT = {
  ko: {
    macArm: 'Mac · Apple Silicon', macIntel: 'Mac · Intel', windows: 'Windows · x64', linux: 'Linux · AppImage', linuxDeb: 'Linux · Debian / Ubuntu',
    download: '내려받기', choose: '운영체제별 내려받기', loading: '다운로드 확인 중…', missing: '출시 준비 중', failed: '파일 목록을 불러오지 못했어요. GitHub 릴리스에서 확인해 주세요.',
    available: '설치 파일 준비 완료', recommended: '이 기기에 추천', mac: 'Mac의 칩에 맞게 Apple Silicon 또는 Intel을 선택하세요.',
    mobile: '데스크톱 앱이에요. 사용할 컴퓨터의 운영체제를 선택하세요.', unknown: '운영체제와 칩에 맞는 설치 파일을 선택하세요.',
    note: '다른 운영체제의 파일도 아래에서 선택할 수 있어요.', version: '최신 버전',
  },
  en: {
    macArm: 'Mac · Apple Silicon', macIntel: 'Mac · Intel', windows: 'Windows · x64', linux: 'Linux · AppImage', linuxDeb: 'Linux · Debian / Ubuntu',
    download: 'Download', choose: 'Downloads for all platforms', loading: 'Checking downloads…', missing: 'Coming soon', failed: 'Could not load the files. Check GitHub Releases for downloads.',
    available: 'Installer available', recommended: 'Recommended for this device', mac: 'Choose Apple Silicon or Intel to match your Mac’s chip.',
    mobile: 'A desktop app. Choose the operating system of your computer.', unknown: 'Choose the installer for your operating system and chip.',
    note: 'You can choose another operating system below.', version: 'Latest version',
  },
}

export async function wireDownloads() {
  const t = TEXT[document.documentElement.lang === 'en' ? 'en' : 'ko']
  const primary = [...document.querySelectorAll('a[data-dl]')]
  const cards = [...document.querySelectorAll('[data-platform-download]')]
  const status = document.querySelector('[data-download-status]')
  const setPrimary = (label, href) => {
    for (const link of primary) {
      const text = link.querySelector('[data-dl-label]')
      if (text) text.textContent = label
      link.href = href
    }
  }
  setPrimary(t.choose, '#downloads')
  if (status) status.textContent = t.loading
  // 칩 정보가 오지 않아도 파일 조회와 수동 선택을 막지 않는다.
  const detected = Promise.race([detectPlatform(), new Promise((resolve) => setTimeout(() => resolve('unknown'), 1500))])
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)
  let assets = {}, release = null, failed = false
  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' }, signal: controller.signal,
    })
    if (!response.ok) throw Error('release unavailable')
    release = await response.json()
    assets = releaseAssets(release)
  } catch { failed = true } finally { clearTimeout(timeout) }
  const kind = await detected
  document.documentElement.dataset.platform = kind
  for (const card of cards) {
    const platform = card.dataset.platformDownload
    const link = card.querySelector('[data-platform-link]')
    const state = card.querySelector('[data-platform-state]')
    const asset = assets[platform]
    if (link) {
      link.textContent = asset ? t.download : t.missing
      if (asset) {
        link.href = asset.browser_download_url
        link.removeAttribute('aria-disabled')
        link.removeAttribute('tabindex')
      } else {
        link.removeAttribute('href')
        link.setAttribute('aria-disabled', 'true')
        link.setAttribute('tabindex', '-1')
      }
    }
    if (state) state.textContent = asset ? (kind === platform ? t.recommended : t.available) : t.missing
    if (asset && kind === platform) card.classList.add('is-recommended')
  }
  if (status) status.textContent = failed ? t.failed : `${t.version}: ${release?.tag_name || '—'}`
  const suggestion = assets[kind]
  if (suggestion) setPrimary(`${t.download} · ${t[kind]}`, suggestion.browser_download_url)
  for (const note of document.querySelectorAll('[data-dl-note]')) note.textContent = t[kind] ? t.note : (t[kind] || t.unknown)
  if (['mac', 'mobile', 'unknown'].includes(kind)) {
    for (const note of document.querySelectorAll('[data-dl-note]')) note.textContent = t[kind]
  }
}
