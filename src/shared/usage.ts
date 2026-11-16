// 52단계: Claude 한도(5시간 · 주간) 실수치. 원천 두 가지:
// ① 대화 pane stream-json `rate_limit_event.rate_limit_info.unifiedWindows.{five_hour,seven_day}.{utilization 0~1, resetsAt 초}` (스파이크로 확인)
// ② 터미널 TUI statusLine 입력 `rate_limits.{five_hour,seven_day}.{used_percentage 0~100, resets_at 초}` (설치된 2.1.325 의 statusLine 문서로 확인 · 실제 TUI 대조 안 함)
import { isObj } from './guards'

export interface UsageWindow {
  /** 0~100 (넘을 수 있다) */
  used: number
  /** 초기화 시각 ms */
  resetsAt: number
}
export type UsageWindowKey = 'fiveHour' | 'sevenDay'
export interface UsageSnapshot {
  fiveHour?: UsageWindow
  sevenDay?: UsageWindow
  /** 받은 시각 ms */
  at: number
  source: 'chat' | 'terminal'
}
/** 계정 id → 마지막 값 */
export type UsageMap = Record<string, UsageSnapshot>

const KEYS: Array<[UsageWindowKey, string]> = [
  ['fiveHour', 'five_hour'],
  ['sevenDay', 'seven_day'],
]
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function build(get: (wire: string) => UsageWindow | null, at: number, source: UsageSnapshot['source']): UsageSnapshot | null {
  const out: UsageSnapshot = { at, source }
  for (const [key, wire] of KEYS) {
    const w = get(wire)
    if (w) out[key] = w
  }
  return out.fiveHour || out.sevenDay ? out : null
}

export function usageFromRateLimitInfo(info: unknown, now: number): UsageSnapshot | null {
  const wins = isObj(info) && isObj(info['unifiedWindows']) ? info['unifiedWindows'] : null
  if (!wins) return null
  return build(
    (wire) => {
      const w = wins[wire]
      return isObj(w) && num(w['utilization']) && num(w['resetsAt']) ? { used: Math.round(w['utilization'] * 1000) / 10, resetsAt: w['resetsAt'] * 1000 } : null
    },
    now,
    'chat',
  )
}

export function usageFromStatusLine(rateLimits: unknown, now: number): UsageSnapshot | null {
  if (!isObj(rateLimits)) return null
  return build(
    (wire) => {
      const w = rateLimits[wire]
      return isObj(w) && num(w['used_percentage']) && num(w['resets_at']) ? { used: w['used_percentage'], resetsAt: w['resets_at'] * 1000 } : null
    },
    now,
    'terminal',
  )
}

/** statusLine 스크립트가 쓴 파일: `v1⇥<CLAUDE_CONFIG_DIR>⇥<rate_limits JSON>` */
export function parseStatusFile(text: string): { configDir: string; rateLimits: unknown } | null {
  const line = text.split('\n')[0] ?? ''
  const parts = line.split('\t')
  if (parts.length !== 3 || parts[0] !== 'v1') return null
  try {
    return { configDir: parts[1]!, rateLimits: JSON.parse(parts[2]!) as unknown }
  } catch {
    return null
  }
}

const sameWindow = (a: UsageWindow | undefined, b: UsageWindow | undefined): boolean => a?.used === b?.used && a?.resetsAt === b?.resetsAt
/** 같은 값이어도 이만큼 지나면 받은 시각을 새로 — 화면의 'n분 전' · 가장 최근 계정 고르기가 낡지 않게(쓰기는 1분에 한 번 이하) */
const REFRESH_MS = 60_000

/**
 * 더 새 값만 받는다(늦게 도착한 옛 값이 새 값을 덮지 않게). 새 값에 없는 창은 초기화 전이면 앞 값을 남긴다.
 * 받을 것이 없거나 보이는 값이 같으면(1분 안) null — 저장 · 화면 전송을 하지 않는다.
 */
export function mergeUsage(prev: UsageSnapshot | undefined, next: UsageSnapshot, now: number): UsageSnapshot | null {
  if (!prev) return next
  if (next.at <= prev.at) return null
  const out: UsageSnapshot = { at: next.at, source: next.source }
  for (const [key] of KEYS) {
    const w = next[key] ?? (prev[key] && prev[key]!.resetsAt > now ? prev[key] : undefined)
    if (w) out[key] = w
  }
  if (KEYS.every(([k]) => sameWindow(prev[k], out[k])) && next.at - prev.at < REFRESH_MS) return null
  return out
}

export function usageTone(used: number): 'ok' | 'warn' | 'danger' {
  return used >= 90 ? 'danger' : used >= 70 ? 'warn' : 'ok'
}

/** 90% 를 새로 넘은 창 — 같은 창(같은 초기화 시각)에서는 한 번만 */
export function crossedDanger(prev: UsageSnapshot | undefined, next: UsageSnapshot): UsageWindowKey[] {
  const out: UsageWindowKey[] = []
  for (const [key] of KEYS) {
    const n = next[key]
    if (!n || n.used < 90) continue
    const p = prev?.[key]
    if (p && p.resetsAt === n.resetsAt && p.used >= 90) continue
    out.push(key)
  }
  return out
}

export function formatResetIn(resetsAt: number, now: number): string {
  const ms = resetsAt - now
  if (ms < 0) return '초기화됨'
  const min = Math.floor(ms / 60_000)
  if (min < 1) return '곧 초기화'
  const h = Math.floor(min / 60)
  if (h >= 24) return `${Math.floor(h / 24)}일 ${h % 24}시간 뒤 초기화`
  return h > 0 ? `${h}시간 ${min % 60}분 뒤 초기화` : `${min}분 뒤 초기화`
}

export const USAGE_LABEL: Record<UsageWindowKey, string> = { fiveHour: '5시간', sevenDay: '주간' }

/** 저장 파일 · IPC 값 검사 — 모양이 틀린 창은 버리고, 창이 하나도 없으면 계정을 버린다 */
export function normalizeUsageMap(raw: unknown): UsageMap {
  const out: UsageMap = {}
  if (!isObj(raw)) return out
  for (const [id, v] of Object.entries(raw)) {
    if (!isObj(v) || !num(v['at']) || (v['source'] !== 'chat' && v['source'] !== 'terminal')) continue
    const snap = build(
      (wire) => {
        const key = KEYS.find(([, w]) => w === wire)![0]
        const w = v[key]
        return isObj(w) && num(w['used']) && num(w['resetsAt']) ? { used: w['used'], resetsAt: w['resetsAt'] } : null
      },
      v['at'],
      v['source'],
    )
    if (snap && id.length <= 100) out[id] = snap
  }
  return out
}

/** 계정 화면(AccountStatus.windows) 모양 */
export function accountWindows(u: UsageSnapshot | undefined): Array<{ label: string; used: number; resetsAt: number }> {
  if (!u) return []
  return KEYS.flatMap(([key]) => (u[key] ? [{ label: USAGE_LABEL[key], used: u[key]!.used, resetsAt: u[key]!.resetsAt }] : []))
}

export function usageAgo(at: number, now: number): string {
  const s = Math.max(0, now - at) / 1000
  if (s < 60) return '방금'
  if (s < 3600) return `${Math.floor(s / 60)}분 전`
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`
  return `${Math.floor(s / 86400)}일 전`
}
