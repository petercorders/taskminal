// 저장 파일 읽기 판정과 쓰기 디바운스. main 이 쓰지만 순수 로직이라 shared 에 두고 단위 시험한다.
import { normalizeState, type NewId } from './model'
import type { AppState } from './types'
import type { Schedule } from './pty'

export const STATE_VERSION = 1

export type ReadResult =
  | { kind: 'missing' }
  | { kind: 'corrupt'; reason: string }
  | { kind: 'newer'; version: unknown }
  /** lossy: 검증이 원본의 무언가를 버렸다 — 첫 저장 전에 원본을 백업해야 한다 */
  | { kind: 'ok'; state: AppState; lossy: boolean }

/**
 * 저장 파일 내용(없으면 null)을 판정한다. version 이 없거나 1 일 때만 정규화한다 — 그 밖의 값(2 · "2" · 객체)은
 * 이 앱이 모르는 형식이라 정규화하면 모르는 칸이 버려져 데이터가 사라진다.
 */
export function readStateText(text: string | null, newId: NewId): ReadResult {
  if (text === null) return { kind: 'missing' }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return { kind: 'corrupt', reason: e instanceof Error ? e.message : String(e) }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { kind: 'corrupt', reason: 'JSON 객체가 아님' }
  if ('version' in raw && (raw as { version: unknown }).version !== STATE_VERSION) {
    return { kind: 'newer', version: (raw as { version: unknown }).version }
  }
  const state = normalizeState(raw, newId)
  return { kind: 'ok', state, lossy: canonical(state) !== canonical(raw) }
}

/** 키 순서와 상관없는 JSON 문자열 — 원본과 정규화 결과가 같은 내용인지 비교한다. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  )
}

/** 마지막 값만 남겨 ms 뒤 한 번 쓴다. flush 는 남은 값을 바로 쓴다(앱 종료). */
export class Debouncer<T> {
  private pending: { value: T; cancel: () => void } | null = null

  constructor(
    private readonly write: (value: T) => void,
    private readonly schedule: Schedule,
    private readonly ms: number,
  ) {}

  push(value: T): void {
    this.pending?.cancel()
    this.pending = { value, cancel: this.schedule(() => this.flush(), this.ms) }
  }

  flush(): void {
    const p = this.pending
    if (!p) return
    this.pending = null
    p.cancel()
    this.write(p.value)
  }
}
