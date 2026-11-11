// 화면에 보이는 명령 글 가리기 (작은 고침 2026-11-11). 칸 머리 · 사이드바 둘째 줄 · 닫기 확인 · 알림에 명령 글이 그대로 나가던 것.
// 판단(busy · 상태)은 원래 활동으로 하고, 그리는 곳에만 이 사본을 준다. 순수 함수라 단위 시험한다.
import type { PaneActivity } from '../shared/activity'
import { redact, type SecretOptions } from '../shared/redact'

/** 글 → 가린 글. 같은 글은 캐시(명령 글은 몇 개 안 된다). 설정이 바뀌면 새로 만든다 — 캐시가 낡지 않게 */
export function textMasker(opts: SecretOptions): (text: string) => string {
  const cache = new Map<string, string>()
  return (text) => {
    let out = cache.get(text)
    if (out === undefined) {
      out = redact(text, opts)
      if (cache.size > 500) cache.clear()
      cache.set(text, out)
    }
    return out
  }
}

/** 명령 · 기다림 메시지만 가린 사본. 가리개가 없거나 바뀐 칸이 없으면 원래 객체 */
export function maskActivity<T extends Readonly<Record<string, PaneActivity>>>(activity: T, mask: ((text: string) => string) | null): T {
  if (!mask) return activity
  let out: Record<string, PaneActivity> | null = null
  for (const [id, a] of Object.entries(activity)) {
    const command = a.command === undefined ? undefined : mask(a.command)
    const message = a.message === undefined ? undefined : mask(a.message)
    if (command === a.command && message === a.message) continue
    out ??= { ...activity }
    out[id] = { ...a, ...(command !== undefined ? { command } : {}), ...(message !== undefined ? { message } : {}) }
  }
  return (out ?? activity) as T
}
