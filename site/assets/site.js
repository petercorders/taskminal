import { wireDownloads } from './downloads.mjs'

// 검증된 공개 릴리스가 준비되면 ready로 전환한다.
const RELEASE = 'ready' // 'soon' | 'ready'
if (RELEASE === 'ready') document.documentElement.classList.add('is-ready')
// 다운로드 목록은 공개 자산을 직접 확인한다. 없는 OS의 파일은 준비 중으로 표시한다.
void wireDownloads()

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
