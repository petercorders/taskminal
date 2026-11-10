// 저장 파일 읽기 판정과 쓰기 디바운스. main 이 쓰지만 순수 로직이라 shared 에 두고 단위 시험한다.
import { normalizeState, type NewId } from './model'
import type { AppState } from './types'
import type { Schedule } from './pty'

export const STATE_VERSION = 1

export type ReadResult =
  | { kind: 'missing' }
  | { kind: 'corrupt'; reason: string }
  | { kind: 'newer'; version: number }
  | { kind: 'ok'; state: AppState }

/** 저장 파일 내용(없으면 null)을 판정한다. 더 새 버전은 정규화하지 않는다 — 모르는 칸을 버리면 데이터가 사라진다. */
export function readStateText(text: string | null, newId: NewId): ReadResult {
  if (text === null) return { kind: 'missing' }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return { kind: 'corrupt', reason: e instanceof Error ? e.message : String(e) }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { kind: 'corrupt', reason: 'JSON 객체가 아님' }
  const version = (raw as { version?: unknown }).version
  if (typeof version === 'number' && version > STATE_VERSION) return { kind: 'newer', version }
  return { kind: 'ok', state: normalizeState(raw, newId) }
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
