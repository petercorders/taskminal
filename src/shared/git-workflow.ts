/** 33단계: GitHub 작업은 확인할 때 본 저장소·브랜치·SHA에 고정한다. */
export interface GitTarget {
  root: string
  branch: string
  head: string
  remote: string
  base: string | null
  repo: string | null
  /** 내부 비교에만 쓰는 URL은 자격증명 부분을 제거한 값이다. */
  remoteUrl: string
}
export interface WorkflowOptions { remote?: string; base?: string }
export interface PullRequestView {
  number: number
  title: string
  url: string
  state: string
  head: string
  branch: string
  base: string
  draft: boolean
  review: string
  checks: 'passed' | 'pending' | 'failed' | 'none'
  mergeable: boolean
}
export interface GitWorkflowView {
  state: 'ok' | 'not-repo' | 'no-git' | 'error'
  message?: string
  root: string | null
  branch: string | null
  head: string | null
  remotes: string[]
  target: GitTarget | null
  upstream: string | null
  ahead: number
  behind: number
  gh: 'ready' | 'missing' | 'login' | 'not-github' | 'error'
  pr: PullRequestView | null
}
export interface CreatePullRequest { target: GitTarget; title: string; body: string }
export interface MergePullRequest { target: GitTarget; number: number; head: string }
export interface GitWorkflowResult {
  state: 'ok' | 'busy' | 'changed' | 'blocked' | 'unknown' | 'error'
  message: string
  url?: string
}
export interface GitWorkflowApi {
  view(dir: string, options?: WorkflowOptions): Promise<GitWorkflowView>
  push(dir: string, target: GitTarget): Promise<GitWorkflowResult>
  create(dir: string, request: CreatePullRequest): Promise<GitWorkflowResult>
  merge(dir: string, request: MergePullRequest): Promise<GitWorkflowResult>
}
export function validWorkflowOptions(value: unknown): value is WorkflowOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return (v.remote === undefined || validRefPart(v.remote)) && (v.base === undefined || validRefPart(v.base))
}
export function validRefPart(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !value.startsWith('-') && !/[\s\x00-\x1f\x7f~^:?*\[\\]/.test(value) && !value.includes('..') && !value.includes('@{')
}
export function validGitTarget(value: unknown): value is GitTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return typeof v.root === 'string' && v.root.length <= 4096 && !v.root.includes('\0') && validRefPart(v.branch) && validRefPart(v.remote)
    && typeof v.head === 'string' && /^[a-f0-9]{40,64}$/.test(v.head)
    && (v.base === null || validRefPart(v.base)) && (v.repo === null || typeof v.repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(v.repo))
    && typeof v.remoteUrl === 'string' && v.remoteUrl.length <= 4096 && !v.remoteUrl.includes('\0')
}
