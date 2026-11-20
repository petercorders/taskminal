export interface WorktreeComparisonRequest { left: string; right: string; base?: string }
export interface WorktreeChange { status: string; path: string; from?: string }
export interface WorktreeCandidate { sha: string; changes: WorktreeChange[]; total: number }
export interface WorktreeComparison {
  base: string
  left: WorktreeCandidate
  right: WorktreeCandidate
  merge: { state: 'clean' | 'conflicts' | 'unknown'; paths: string[] }
}

import { isWorktreeOid } from './worktree-management'
export function validComparisonRequest(value: unknown): value is WorktreeComparisonRequest {
  if (!value || typeof value !== 'object') return false
  const { left, right, base } = value as Partial<WorktreeComparisonRequest>
  return isWorktreeOid(left) && isWorktreeOid(right) && (base === undefined || isWorktreeOid(base))
}
