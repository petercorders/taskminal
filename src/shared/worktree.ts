// 15f: git worktree 일감 — 브랜치 이름 검사 · 새 폴더 자리

export type WorktreeResult = { ok: true; path: string } | { ok: false; error: string }

/** 대화상자에서 바로 알려 줄 이름 문제 (git check-ref-format 의 흔한 규칙) — 괜찮으면 null. 나머지는 git 이 거절한다 */
export function checkBranchName(name: string): string | null {
  if (name.trim() === '') return '브랜치 이름을 적어 주세요'
  if (name.length > 100) return '브랜치 이름이 너무 깁니다 (100자까지)'
  if (/[\s\x00-\x1f\x7f]/.test(name)) return '브랜치 이름에 빈칸을 쓸 수 없습니다'
  if (/[~^:?*[\\]/.test(name)) return '브랜치 이름에 ~ ^ : ? * [ \\ 를 쓸 수 없습니다'
  if (name === '@' || name.includes('@{')) return "브랜치 이름에 '@{' 를 쓸 수 없습니다"
  if (name.includes('..') || name.includes('//')) return "브랜치 이름에 '..' · '//' 를 쓸 수 없습니다"
  if (name.startsWith('-') || name.startsWith('/')) return "브랜치 이름은 '-' · '/' 로 시작할 수 없습니다"
  if (name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock')) return "브랜치 이름은 '/' · '.' · '.lock' 으로 끝날 수 없습니다"
  return null
}

/** 저장소 뿌리 옆 `<뿌리>-<브랜치(/ → -)>` — 저장소 안을 더럽히지 않는다 */
export function worktreeDir(root: string, branch: string): string {
  return `${root.replace(/\/+$/, '')}-${branch.replace(/\//g, '-')}`
}
