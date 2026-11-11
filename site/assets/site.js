// Taskminal 홈페이지 — 출시 상태 하나 · 쇼케이스 장면 고르기.
// 서명된 첫 빌드를 GitHub Releases 에 올린 뒤 RELEASE 를 'ready' 로 바꾸면
// 모든 페이지의 단추가 '출시 알림 받기' → 'Mac 용 내려받기' 로 바뀐다(JS 가 없으면 '곧 공개' 그대로).
const RELEASE = 'soon' // 'soon' | 'ready'

if (RELEASE === 'ready') document.documentElement.classList.add('is-ready')

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
