// 15d: ⌘F 찾기 막대 — 숫자 표시와 키 판정 (화면은 FindBar.tsx)

/** @xterm/addon-search 가 세는 상한 — 넘으면 resultCount 가 이 값보다 크게 온다 */
export const FIND_LIMIT = 1000

/** '3/12' · '없음' · 빈 입력이면 '' (숨김). 지금 위치를 모르면(-1) 수만 */
export function findCountLabel(query: string, index: number, count: number): string {
  if (query === '') return ''
  if (count <= 0) return '없음'
  const total = count > FIND_LIMIT ? `${FIND_LIMIT}+` : String(count)
  return index < 0 ? total : `${index + 1}/${total}`
}

export type FindKey = 'next' | 'prev' | 'close'

/** ↩ 다음 · ⇧↩ 이전 · Esc 닫기 — 한글 조합 중이면 글자 확정이라 null */
export function findKeyAction(key: string, shift: boolean, composing: boolean): FindKey | null {
  if (composing) return null
  if (key === 'Enter') return shift ? 'prev' : 'next'
  if (key === 'Escape') return 'close'
  return null
}
