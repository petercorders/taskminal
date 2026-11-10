// 15b: 터미널 출력의 링크(글 속 주소 · OSC 8). 출력은 남이 만든 글이라 http(s) 만 바깥 브라우저로 연다.

const MAX_URL = 2048

/** http · https 주소면 그대로, 아니면(다른 스킴 · 깨진 글 · 너무 김) null */
export function webUrl(url: unknown): string | null {
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_URL) return null
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

/** ⌘+클릭일 때만 연다 — 그냥 클릭은 글 선택 (iTerm2 · Terminal 과 같다) */
export function linkToOpen(uri: string, metaKey: boolean): string | null {
  return metaKey ? webUrl(uri) : null
}
