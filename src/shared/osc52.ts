// OSC 52 — 터미널 안 프로그램(vim · tmux · ssh 너머의 프로그램)이 클립보드에 쓰는 신호 (58c). 순수 함수.
// 형식: `<선택>;<base64>`. 쓰기만 받는다 — 읽기 요청(`?`)에 답하면 터미널 안 프로그램(원격 포함)이 클립보드를 훔쳐볼 수 있다.

/** 한 번에 받는 글의 상한(풀어 낸 바이트) — 넘으면 통째로 버린다 */
export const OSC52_MAX_BYTES = 100 * 1024

/**
 * OSC 52 의 내용(`52;` 뒤)을 클립보드에 쓸 글로. 받지 않을 것은 null:
 * 선택 칸이 클립보드(c)가 아님(빈 값은 받는다) · 읽기 요청(?) · 빈 내용(프로그램이 클립보드를 비우지 못하게) ·
 * 깨진 base64 · maxBytes 초과 · UTF-8 이 아닌 바이트. 패딩(=)이 빠진 base64 는 받는다.
 */
export function parseOsc52(data: string, maxBytes: number): string | null {
  const at = data.indexOf(';')
  if (at < 0) return null
  const target = data.slice(0, at)
  if (target !== '' && !target.includes('c')) return null
  const m = /^([A-Za-z0-9+/]+)(={0,2})$/.exec(data.slice(at + 1)) // '?' · 빈 내용도 여기서 걸러진다
  if (!m) return null
  const body = m[1]!
  const pad = (4 - (body.length % 4)) % 4
  if (pad === 3 || (m[2] !== '' && m[2]!.length !== pad)) return null
  // 풀기 전에 길이로 먼저 — 큰 값을 풀어 놓고 버리지 않는다
  if (Math.floor((body.length * 3) / 4) > maxBytes) return null
  try {
    const bin = atob(body + '='.repeat(pad))
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0))
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}
