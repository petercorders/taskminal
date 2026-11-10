// 셸의 작업 폴더 알아내기 — 셸 통합의 OSC 7 · 통합이 없는 셸은 main 의 lsof.

/** 호스트 이름 비교용: 소문자 · 끝의 `.local` 뗌 */
const hostKey = (h: string) => h.toLowerCase().replace(/\.local$/, '')

/**
 * OSC 7 `file://<호스트><퍼센트 인코딩한 경로>` → 경로. 이 Mac 이 아닌 호스트(ssh 안의 셸)가 보낸 것 · 깨진 글은 null —
 * 다른 컴퓨터의 폴더를 이 Mac 의 폴더로 저장하지 않게.
 */
export function parseOsc7(data: string, localHost: string): string | null {
  const m = /^file:\/\/([^/]*)(\/.*)$/.exec(data)
  if (!m) return null
  const host = m[1]!
  if (host !== '' && hostKey(host) !== 'localhost' && hostKey(host) !== hostKey(localHost)) return null
  try {
    return decodeURIComponent(m[2]!)
  } catch {
    return null
  }
}

/** `lsof -a -d cwd -Fpn -p <pid,…>` 출력 → { pid: 폴더 }. `p<pid>` 다음의 `n<경로>` 만, 절대 경로만. */
export function parseLsofCwd(out: string): Record<number, string> {
  const found: Record<number, string> = {}
  let pid: number | null = null
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) {
      const n = Number(line.slice(1))
      pid = Number.isInteger(n) && n > 0 ? n : null
    } else if (line.startsWith('n/') && pid !== null) {
      found[pid] = line.slice(1)
    }
  }
  return found
}
