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

/** Strict macOS `lsof -F0pn` framing, exclusively for mutation guards.
 * lsof escapes non-printable names even with NUL framing. Reject ambiguous
 * names instead of treating an escaped display value as a verified path.
 */
export function parseStrictLsofCwds(out: string, pids: readonly number[]): Record<number, string> {
  const fail = () => new Error('실행 중인 셸의 실제 폴더를 안전하게 확인하지 못했어요')
  if (pids.length > 4096 || pids.some(pid => !Number.isInteger(pid) || pid <= 0 || pid >= 2 ** 31) || new Set(pids).size !== pids.length) throw fail()
  const requested = new Set(pids)
  const found: Record<number, string> = {}
  const records = /p([1-9]\d*)\0\nfcwd\0n([^\0]*)\0\n/gy
  let offset = 0
  while (offset < out.length) {
    records.lastIndex = offset
    const match = records.exec(out)
    if (!match) throw fail()
    const pid = Number(match[1]), path = match[2]
    if (!requested.has(pid) || Object.hasOwn(found, pid) || !path.startsWith('/') ||
      /[\\^\p{C}\u2028\u2029\uFFFD]/u.test(path) || path.endsWith(' (deleted)')) throw fail()
    found[pid] = path
    offset = records.lastIndex
  }
  if (Object.keys(found).length !== requested.size) throw fail()
  return found
}

/**
 * 셸이 알려 준 절대 경로(OSC 7 · lsof)를 일감 폴더와 같은 모양으로 — 일감 폴더가 `~` 로 쓰였으면 홈 아래 경로를 `~/…` 로.
 * 모양이 다르면 cd 하지 않은 pane 도 폴더가 바뀐 것으로 보이고(저장), 템플릿으로 저장할 때 일감 기준 상대 경로를 못 만든다(13단계 리뷰).
 */
export function cwdLike(path: string, taskCwd: string, home: string): string {
  if (!home || !(taskCwd === '~' || taskCwd.startsWith('~/'))) return path
  if (path === home) return '~'
  return path.startsWith(home + '/') ? '~' + path.slice(home.length) : path
}

/** `~` · `~/…` 를 home 으로 푼다 — 셸을 여는 폴더(pty-manager)와 브랜치를 읽는 폴더(git-branch)가 같은 규칙을 쓴다 */
export function expandHome(path: string, home: string): string {
  return path === '~' ? home : path.startsWith('~/') ? home + '/' + path.slice(2) : path
}
