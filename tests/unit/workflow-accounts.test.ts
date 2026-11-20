import { expect, test, vi } from 'vitest'
import type { AccountStatus, AgentAccount } from '../../src/shared/accounts'
import { workflowAccountSelectionMatches, type Workflow } from '../../src/shared/workflows'
import { inspectWorkflowAccounts, workflowUsageWindows } from '../../src/renderer/workflow-accounts'

const accounts: AgentAccount[] = [
  { id: 'default-claude', agent: 'claude', name: 'Claude 기본 계정', selected: false },
  { id: 'work-claude', agent: 'claude', name: 'Claude 업무', selected: true },
  { id: 'default-codex', agent: 'codex', name: 'Codex 기본 계정', selected: true },
]
const ready: AccountStatus = { display: 'work', state: 'ready', updatedAt: 1, windows: [{ label: '5시간', used: 42, resetsAt: 200 }] }

test('단계가 계정을 공유하면 실제 선택 계정만 한 번 조회한다', async () => {
  const status = vi.fn(async () => ready)
  const result = await inspectWorkflowAccounts({ list: async () => accounts, status }, ['claude', 'codex', 'claude'])
  expect(status.mock.calls).toEqual([['work-claude'], ['default-codex']])
  expect(result.claude).toEqual({ account: accounts[1], status: ready })
  expect(result.codex).toEqual({ account: accounts[2], status: ready })
})

test('한 계정의 조회 실패나 계정 미선택을 다른 계정 한도로 채우지 않는다', async () => {
  const status = vi.fn(async (id: string) => {
    if (id === 'work-claude') throw new Error('불가')
    return ready
  })
  expect(await inspectWorkflowAccounts({ list: async () => accounts.slice(0, 2), status }, ['claude', 'codex'])).toEqual({
    claude: { account: accounts[1], status: null },
  })
  expect(status).toHaveBeenCalledTimes(1)
})

test('초기화가 지난 한도와 초기화 시각 미제공을 구별한다', () => {
  const noReset = { label: '주간', used: 99 }
  const late = { label: '월간', used: 4, resetsAt: 300 }
  const status = { ...ready, windows: [ready.windows[0]!, noReset, late] }
  expect(workflowUsageWindows(status, 200)).toEqual([
    { ...late, elapsed: false },
    { ...noReset, elapsed: false },
    { ...ready.windows[0], elapsed: true },
  ])
})

test('실행 전 계정 대조는 정확한 제공자 집합과 현재 선택을 요구한다', () => {
  const workflow: Workflow = {
    id: 'test', name: 'test', steps: [
      { id: 'a', name: 'a', agent: 'claude', prompt: 'a', after: [] },
      { id: 'b', name: 'b', agent: 'codex', prompt: 'b', after: [] },
    ],
  }
  expect(workflowAccountSelectionMatches(workflow, { claude: 'work-claude', codex: 'default-codex' }, accounts)).toBe(true)
  expect(workflowAccountSelectionMatches(workflow, { claude: 'default-claude', codex: 'default-codex' }, accounts)).toBe(false)
  expect(workflowAccountSelectionMatches(workflow, { claude: 'work-claude' }, accounts)).toBe(false)
})
