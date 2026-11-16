// 52단계: 사이드바 아래 Claude 한도(5시간 · 주간) — 가장 최근에 받은 계정의 값. 70% 노랑 · 90% 빨강. 누르면 '사용량·계정'.
import { USAGE_LABEL, formatResetIn, usageAgo, usageTone, type UsageMap, type UsageSnapshot, type UsageWindowKey } from '../shared/usage'

const KEYS: UsageWindowKey[] = ['fiveHour', 'sevenDay']

/** 가장 최근에 받은 계정의 값 */
export function latestUsage(usage: UsageMap): UsageSnapshot | null {
  let best: UsageSnapshot | null = null
  for (const s of Object.values(usage)) if (!best || s.at > best.at) best = s
  return best
}

export function usageSummary(snap: UsageSnapshot, now: number): string {
  const parts = KEYS.flatMap((k) => {
    const w = snap[k]
    if (!w) return []
    return [`${USAGE_LABEL[k]} ${w.resetsAt <= now ? '초기화됨' : `${Math.round(w.used)}% (${formatResetIn(w.resetsAt, now)})`}`]
  })
  return `Claude 한도 · ${parts.join(' · ')} · ${usageAgo(snap.at, now)} ${snap.source === 'chat' ? '대화' : '터미널'}에서 받은 값`
}

export function UsageBars({ usage, now, onOpen }: { usage: UsageMap; now: number; onOpen?(): void }) {
  const snap = latestUsage(usage)
  if (!snap) return null
  const summary = usageSummary(snap, now)
  return (
    <button type="button" className="usage-bars" data-testid="usage-bars" onClick={onOpen} aria-label={summary} title={summary}>
      <span className="usage-bars-name" aria-hidden>
        Claude
      </span>
      {KEYS.map((k) => {
        const w = snap[k]
        if (!w) return null
        const gone = w.resetsAt <= now
        const tone = gone ? 'gone' : usageTone(w.used)
        return (
          <span key={k} className={`usage-bar ${tone}`} data-testid={`usage-${k}`} data-tone={tone} aria-hidden>
            <span className="usage-bar-label">{USAGE_LABEL[k]}</span>
            <span className="usage-bar-track">
              <span className="usage-bar-fill" style={{ width: `${gone ? 0 : Math.min(100, Math.max(0, w.used))}%` }} />
            </span>
            <span className="usage-bar-value">{gone ? '—' : `${Math.round(w.used)}%`}</span>
          </span>
        )
      })}
    </button>
  )
}
