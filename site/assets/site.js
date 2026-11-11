// Taskminal 홈페이지 — 출시 상태 하나 · 쇼케이스 장면 고르기.
// 서명된 첫 빌드를 GitHub Releases 에 올린 뒤 RELEASE 를 'ready' 로 바꾸면
// 모든 페이지의 단추가 '출시 알림 받기' → 'Mac 용 내려받기' 로 바뀐다(JS 가 없으면 '곧 공개' 그대로).
const RELEASE = 'soon' // 'soon' | 'ready'

if (RELEASE === 'ready') document.documentElement.classList.add('is-ready')

// 내려받기 — 보는 사람의 OS · 칩을 보고 맞는 파일로 잇는다(Orca 방식).
// 지금 빌드는 macOS Apple Silicon(.dmg) 하나뿐 — 다른 OS 는 받을 파일 대신 지원 범위를 알린다.
// 파일은 GitHub API 로 최신 릴리스의 자산에서 찾고, 못 찾으면 릴리스 페이지(기본 href)로 둔다.
const REPO = 'petercorders/taskminal'
const TEXT = {
  ko: {
    macArm: 'Mac 용 내려받기 (Apple Silicon)',
    macIntel: 'Intel Mac 은 아직 지원하지 않아요',
    other: 'macOS 전용이에요 — Mac 에서 내려받기',
    mobile: 'Mac 에서 열어 내려받으세요',
    noteArm: 'Apple Silicon(M1 이후) 전용 · Apple 공증 · Intel Mac 이면 아직 실행되지 않아요',
    noteIntel: 'Intel Mac · Windows · Linux 용은 아직 없어요 — 저장소의 Watch › Releases 로 소식을 받을 수 있어요',
  },
  en: {
    macArm: 'Download for Mac (Apple Silicon)',
    macIntel: 'Intel Macs are not supported yet',
    other: 'macOS only — download on your Mac',
    mobile: 'Open this page on a Mac to download',
    noteArm: 'Apple Silicon (M1 or later) only · Notarized by Apple · Does not run on Intel Macs yet',
    noteIntel: 'No Intel Mac, Windows or Linux builds yet — Watch › Releases on GitHub to hear about them',
  },
}

async function detectPlatform() {
  const ua = navigator.userAgent
  const uad = navigator.userAgentData
  const platform = (uad && uad.platform) || navigator.platform || ''
  if (/iPhone|iPad|iPod|Android/i.test(ua) || (/Mac/.test(platform) && navigator.maxTouchPoints > 1)) return 'mobile'
  // 브라우저가 OS 를 알려 주면(userAgentData) 그것을 믿고, 아니면 platform · UA 로 본다
  const isMac = uad && uad.platform ? /mac/i.test(uad.platform) : /Mac/i.test(platform) || /Macintosh/.test(ua)
  if (!isMac) return 'other'
  // Chromium 계열은 칩 종류를 알려 준다
  try {
    if (uad && uad.getHighEntropyValues) {
      const { architecture } = await uad.getHighEntropyValues(['architecture'])
      if (architecture === 'arm') return 'macArm'
      if (architecture === 'x86') return 'macIntel'
    }
  } catch {}
  // Safari · Firefox: 그래픽 칩 이름으로 짐작 — Intel 이 보이면 Intel, 아니면 Apple Silicon(2020 이후 Mac 대부분)
  try {
    const gl = document.createElement('canvas').getContext('webgl')
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info')
    const r = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : ''
    if (/Intel|AMD|Radeon|NVIDIA/i.test(r)) return 'macIntel'
  } catch {}
  return 'macArm'
}

async function latestDmgUrl() {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } })
    if (!res.ok) return null
    const rel = await res.json()
    const a = (rel.assets || []).find((x) => /arm64\.dmg$/i.test(x.name)) || (rel.assets || []).find((x) => /\.dmg$/i.test(x.name))
    return a ? a.browser_download_url : null
  } catch {
    return null
  }
}

async function wireDownloads() {
  const links = Array.from(document.querySelectorAll('a[data-dl]'))
  if (!links.length) return
  const t = TEXT[document.documentElement.lang === 'en' ? 'en' : 'ko']
  const kind = await detectPlatform()
  document.documentElement.dataset.platform = kind
  const setLabel = (text) => {
    for (const a of links) {
      const label = a.querySelector('[data-dl-label]')
      if (label) label.textContent = text
    }
  }
  const setNote = (text) => {
    for (const n of document.querySelectorAll('[data-dl-note]')) n.textContent = text
  }
  if (kind === 'macArm') {
    setLabel(t.macArm)
    setNote(t.noteArm)
    const url = await latestDmgUrl()
    if (url) for (const a of links) a.href = url
    return
  }
  // 받을 파일이 없는 OS — 단추는 릴리스 페이지(기본 href)로 두고 문구만 바꾼다
  setLabel(t[kind])
  setNote(t.noteIntel)
}

if (RELEASE === 'ready') document.addEventListener('DOMContentLoaded', wireDownloads)

document.addEventListener('DOMContentLoaded', () => {
  const tabs = Array.from(document.querySelectorAll('.scene-tab'))
  const panels = Array.from(document.querySelectorAll('[data-scene-panel]'))
  if (!tabs.length || !panels.length) return

  const show = (id) => {
    for (const t of tabs) t.setAttribute('aria-pressed', String(t.dataset.scene === id))
    for (const p of panels) p.hidden = p.dataset.scenePanel !== id
  }
  // JS 가 없으면 세 장면이 모두 보인다 — 있으면 첫 장면만
  show(tabs[0].dataset.scene)
  for (const t of tabs) t.addEventListener('click', () => show(t.dataset.scene))
})
