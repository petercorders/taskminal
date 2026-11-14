// Stable across Electron IPC, which preserves Error messages but not custom fields.
export const ISSUE_TASK_DELETED = '[issue-task-deleted]'
export type IssueProvider = 'github' | 'linear'
export interface IssueRecord { provider: IssueProvider; id: string; key: string; title: string; body: string; url: string; state: string }
export interface IssuePage { items: IssueRecord[]; cursor?: string }
export interface IssueLink { taskId: string; root: string; issue: IssueRecord; prUrl?: string }
export interface IssuePrepare { requestId: string; provider: IssueProvider; id: string; source: string; root: string; worktree: boolean; base: string }
export interface IssueApi {
  list(provider: IssueProvider, source: string, cursor?: string): Promise<IssuePage>
  configure(token: string): Promise<void>
  links(): Promise<IssueLink[]>
  prepare(input: IssuePrepare): Promise<IssueLink>
  linkPr(taskId: string, url: string): Promise<void>
  close(taskId: string): Promise<void>
}
