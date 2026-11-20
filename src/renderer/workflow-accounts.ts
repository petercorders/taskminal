import type { AccountStatus, AccountsApi, AgentAccount } from '../shared/accounts'
import type { ChatAgent } from '../shared/chat'
import type { WorkflowAccountSelection } from '../shared/workflows'

interface AccountCheck {
  account: AgentAccount
  status: AccountStatus | null
}
export type WorkflowAccounts = Partial<Record<ChatAgent, AccountCheck>>

export async function inspectWorkflowAccounts(api: Pick<AccountsApi, 'list' | 'status'>, agents: readonly ChatAgent[]): Promise<WorkflowAccounts> {
  const accounts = await api.list()
  const selected = accounts.filter((account) => account.selected && agents.includes(account.agent))
  const checked = await Promise.all(selected.map(async (account) => {
    let status: AccountStatus | null
    try { status = await api.status(account.id) } catch { status = null }
    return [account.agent, { account, status }] as const
  }))
  return Object.fromEntries(checked)
}

export function workflowAccountSelection(accounts: WorkflowAccounts, agents: readonly ChatAgent[]): WorkflowAccountSelection | undefined {
  if (!agents.every((agent) => accounts[agent])) return undefined
  return Object.fromEntries(agents.map((agent) => [agent, accounts[agent]!.account.id]))
}

export function workflowUsageWindows(status: AccountStatus | null, now: number) {
  return (status?.state === 'ready' ? status.windows : [])
    .map(({ label, used, resetsAt }) => resetsAt !== undefined && Number.isFinite(new Date(resetsAt).getTime())
      ? { label, used, resetsAt, elapsed: resetsAt <= now }
      : { label, used, elapsed: false })
    .sort((a, b) => Number(a.elapsed) - Number(b.elapsed) || (a.resetsAt ?? Infinity) - (b.resetsAt ?? Infinity))
}
