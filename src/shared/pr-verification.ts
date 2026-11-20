export const MAX_PR_REPORT_BYTES = 64 * 1024
const MAX_ENTRIES = 50
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i

interface VerificationEntry {
  criterion: string
  check: string
  exitCode: number | null
}

export interface PrVerificationReport {
  head: string | null
  entries: VerificationEntry[]
}

export type PrVerificationStatus = 'current' | 'previous' | 'report-unverified' | 'pr-unavailable'

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function sha(value: unknown): string | null {
  return typeof value === 'string' && SHA.test(value) ? value.toLowerCase() : null
}

function label(value: unknown, limit: number): string | null {
  if (typeof value !== 'string' || value.length > limit) return null
  return value.trim() || null
}

export function parsePrVerification(text: string, target: { repository: string; number: number }): PrVerificationReport | null {
  if (text.length > MAX_PR_REPORT_BYTES || new TextEncoder().encode(text).length > MAX_PR_REPORT_BYTES) return null
  let input: Record<string, unknown> | null
  try {
    input = record(JSON.parse(text))
  } catch {
    return null
  }
  if (!input || input.version !== 1 || typeof input.repository !== 'string' || input.repository.toLowerCase() !== target.repository.toLowerCase() || input.pullRequest !== target.number) return null
  if (!Array.isArray(input.entries) || input.entries.length === 0 || input.entries.length > MAX_ENTRIES) return null

  const entries: VerificationEntry[] = []
  for (const raw of input.entries) {
    const entry = record(raw)
    if (!entry) return null
    const criterion = label(entry.criterion, 400)
    const check = label(entry.check, 200)
    const exitCode = entry.exitCode
    if (!criterion || !check || (exitCode !== null && (typeof exitCode !== 'number' || !Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255))) return null
    entries.push({ criterion, check, exitCode })
  }
  const start = sha(input.startSha)
  return { head: start === sha(input.endSha) ? start : null, entries }
}

export function prVerificationStatus(reportHead: string | null, prHead: string | null): PrVerificationStatus {
  const recorded = sha(reportHead)
  const current = sha(prHead)
  if (!recorded) return 'report-unverified'
  if (!current) return 'pr-unavailable'
  return recorded === current ? 'current' : 'previous'
}
