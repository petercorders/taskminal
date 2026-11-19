// 66단계 알림 받은편지함 — 창마다 모델 하나(App · 전체 보기 · 사이드바가 같이 본다). 판단은 shared/inbox-model.
import { useSyncExternalStore } from 'react'
import type { InboxEntry } from '../shared/inbox'
import { InboxModel } from '../shared/inbox-model'

let model: InboxModel | null = null
export function inboxModel(): InboxModel {
  return (model ??= new InboxModel(window.taskminal.inbox, Date.now, (what, reason) => console.warn(`[inbox] ${what}`, reason)))
}
export function useInbox(): readonly InboxEntry[] {
  const m = inboxModel()
  return useSyncExternalStore(m.subscribe, () => m.entries)
}
