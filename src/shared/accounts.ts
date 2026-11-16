import type { ChatAgent } from './chat'
export interface AgentAccount {
  id: string
  agent: ChatAgent
  name: string
  selected: boolean
}
export interface UsageWindow {
  label: string
  used: number
  resetsAt?: number
}
export interface AccountStatus {
  state: 'ready' | 'signed-out' | 'unsupported' | 'unavailable' | 'missing'
  display: string
  windows: UsageWindow[]
  updatedAt: number
  message?: string
  login?: { running: boolean; output: string }
}
export interface AccountsApi {
  tui(paneId: string): Promise<string>
  list(): Promise<AgentAccount[]>
  add(agent: ChatAgent, name: string): Promise<void>
  select(id: string): Promise<void>
  status(id: string): Promise<AccountStatus>
  login(id: string): Promise<void>
  cancel(id: string): Promise<void>
}
export function codexUsage(value: unknown): UsageWindow[] {
  if (!value || typeof value !== 'object') return []
  const obj = value as Record<string, unknown>
  const buckets =
    obj['rateLimitsByLimitId'] && typeof obj['rateLimitsByLimitId'] === 'object' ? Object.entries(obj['rateLimitsByLimitId']) : [['Codex', obj['rateLimits']]]
  const out: UsageWindow[] = []
  for (const [name, b] of buckets) {
    if (!b || typeof b !== 'object') continue
    for (const key of ['primary', 'secondary']) {
      const w = (b as Record<string, unknown>)[key] as Record<string, unknown> | null
      if (!w || typeof w['usedPercent'] !== 'number' || !Number.isFinite(w['usedPercent']) || w['usedPercent'] < 0 || w['usedPercent'] > 100) continue
      const mins = w['windowDurationMins']
      out.push({
        label: `${name} · ${typeof mins === 'number' ? mins + '분' : key}`,
        used: w['usedPercent'],
        ...(typeof w['resetsAt'] === 'number' && Number.isFinite(w['resetsAt']) ? { resetsAt: w['resetsAt'] * 1000 } : {}),
      })
    }
  }
  return out.slice(0, 20)
}
