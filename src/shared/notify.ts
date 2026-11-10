// 설정의 '알림 · 활동': pane 활동의 한 사건이 알릴 일인지. 셸 닫힘(exit)은 pty 끝에서 따로 부른다.
import type { ActivityEvent, PaneActivity } from './activity'
import type { NotifyKind } from './types'

/** 사건 전후 활동으로 알릴 일을 고른다. 알림을 보낼지(설정 · 보고 있는지)는 부르는 쪽이 정한다. */
export function notifyKind(prev: PaneActivity | undefined, next: PaneActivity, ev: ActivityEvent, longMs: number): NotifyKind | null {
  if (ev.type === 'bell' || ev.type === 'notify') return next !== prev && next.attention && next.state === 'waiting' ? 'wait' : null
  if (ev.type !== 'end') return null
  if (next.state === 'failed') return 'fail'
  // 시작(C)을 본 명령만 — 셸 통합 전부터 돌던 명령은 걸린 시간을 모른다
  const startedAt = prev?.startedAt
  return prev?.busy && startedAt !== undefined && next.endedAt !== undefined && next.endedAt - startedAt >= longMs ? 'long' : null
}
