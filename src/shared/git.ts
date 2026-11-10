// 15c: 일감 폴더의 git 브랜치 — .git/HEAD · .git 파일(worktree)을 읽어 푼다. git 을 실행하지 않는다.

/** HEAD 파일: `ref: refs/heads/<브랜치>` → 브랜치, 커밋 해시(브랜치 아닌 HEAD) → 앞 7자리, 그 밖 null */
export function parseHead(text: string): string | null {
  const t = text.trim()
  const ref = /^ref: refs\/heads\/(.+)$/.exec(t)
  if (ref) return ref[1]!
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(t) ? t.slice(0, 7) : null
}

export type Branches = Readonly<Record<string, string | null>>

/** 새 결과가 이전과 같으면 이전 객체를 그대로 — 5초마다 다시 그리지 않게 */
export function keepIfSame(prev: Branches, next: Branches): Branches {
  const a = Object.keys(prev)
  const b = Object.keys(next)
  return a.length === b.length && b.every((k) => k in prev && prev[k] === next[k]) ? prev : next
}

/** 일감 폴더 목록(겹침 없이 · 정렬) — 바뀌었을 때만 다시 읽게 하는 키 */
export function taskDirs(cwds: readonly string[]): string[] {
  return [...new Set(cwds.filter((c) => c.length > 0))].sort()
}

/** worktree · 하위 모듈의 `.git` 파일: `gitdir: <경로>` → 경로 */
export function parseGitdir(text: string): string | null {
  const m = /^gitdir: (.+)$/m.exec(text)
  const path = m?.[1]?.trim()
  return path ? path : null
}
