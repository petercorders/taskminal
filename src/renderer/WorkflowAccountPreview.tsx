import { useRef, useState } from 'react'
import { AGENT_NAME } from '../shared/chat'
import { workflowAgents, type Workflow } from '../shared/workflows'
import { inspectWorkflowAccounts, workflowAccountSelection, workflowUsageWindows, type WorkflowAccounts } from './workflow-accounts'

type AccountResult =
  | { scope: string; state: 'loading' | 'error' }
  | { scope: string; state: 'ready'; accounts: WorkflowAccounts }

export function useWorkflowAccountPreview(taskId: string, workflow: Workflow | undefined) {
  const agents = workflow ? workflowAgents(workflow) : []
  const scope = JSON.stringify([taskId, workflow?.id, agents])
  const [result, setResult] = useState<AccountResult | null>(null)
  const [checking, setChecking] = useState(false)
  const inFlight = useRef(false)
  const current = result?.scope === scope ? result : null
  const inspect = async () => {
    if (!workflow || inFlight.current || document.hidden) return
    inFlight.current = true
    setChecking(true)
    setResult({ scope, state: 'loading' })
    try {
      const accounts = await inspectWorkflowAccounts(window.taskminal.accounts, agents)
      setResult({ scope, state: 'ready', accounts })
    } catch {
      setResult({ scope, state: 'error' })
    } finally {
      inFlight.current = false
      setChecking(false)
    }
  }
  const accounts = current?.state === 'ready' ? current.accounts : null
  return { current, accounts, checking, inspect, selection: accounts ? workflowAccountSelection(accounts, agents) : undefined }
}

export function WorkflowAccountPreview({ workflow, preview }: { workflow: Workflow; preview: ReturnType<typeof useWorkflowAccountPreview> }) {
  const now = Date.now()
  return <section className="workflow-accounts" aria-label="실행 전 계정 한도">
    <div className="workflow-controls">
      <h3>실행 전 계정 한도</h3>
      <button type="button" className="button" disabled={preview.checking} onClick={() => void preview.inspect()}>
        {preview.checking ? '한도 확인 중…' : preview.current ? '한도 다시 확인' : '계정 한도 확인'}
      </button>
    </div>
    {preview.current?.state === 'error' && <p role="status">선택 계정을 읽지 못했어요. 다시 확인해 주세요.</p>}
    <ul className="workflow-account-list">
      {workflow.steps.map((step) => {
        const result = preview.accounts?.[step.agent]
        const status = result?.status ?? null
        const windows = workflowUsageWindows(status, now)
        return <li key={step.id}>
          <strong>{step.name}</strong>
          <span>{AGENT_NAME[step.agent]} · {result?.account.name ?? '선택 계정 미확인'}</span>
          {windows.length ? <ul>{windows.map((window, i) => <li key={i}>
            {window.label} · {window.elapsed ? '초기화됨 · 현재 한도 미확인' : `${Math.round(window.used)}% 사용`}
            {window.resetsAt !== undefined
              ? <> · <time dateTime={new Date(window.resetsAt).toISOString()}>{new Date(window.resetsAt).toLocaleString()}</time> 초기화</>
              : ' · 초기화 시각 미확인'}
          </li>)}</ul> : <span>{status?.state === 'signed-out' ? '로그인 필요 · 한도 미확인' : '한도 미확인'}</span>}
        </li>
      })}
    </ul>
  </section>
}
