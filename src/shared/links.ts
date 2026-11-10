// 15b: 터미널 출력의 링크(글 속 주소 · OSC 8). 출력은 남이 만든 글이라 http(s) 만 바깥 브라우저로 연다.

/** http · https 주소면 검사한 그대로(정규화한 href — 앞뒤 공백 · 제어 문자는 빠진다), 아니면 null */
export function webUrl(url: unknown): string | null {
  if (typeof url !== 'string' || url.length === 0) return null
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}

/** ⌘+클릭일 때만 연다 — 그냥 클릭은 글 선택 (iTerm2 · Terminal 과 같다) */
export function linkToOpen(uri: string, metaKey: boolean): string | null {
  return metaKey ? webUrl(uri) : null
}

/** renderer 가 보내는 링크의 길이 상한 — 터미널 링크만(window.open · 이동 길은 길이를 보지 않는다) */
export const MAX_LINK = 8192
