// 64단계: 일감 머리의 Jira 쓰기 단추는 토큰이 있을 때만 보인다 — 머리가 처음 그려질 때 한 번 읽고,
// 이슈 패널이 인증을 읽거나 · 저장하거나 · 지울 때마다 그 답으로 갱신한다(처음 읽은 값이 낡지 않게).
import { useSyncExternalStore } from 'react'
import type { JiraStatus } from '../shared/jira'

let token: boolean | null = null
let started = 0
let applied = 0
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }

/** 인증 상태 읽기 · 저장 · 지움 하나를 싣는다 — 늦게 끝난 옛 답이 더 새 답을 덮지 않게 시작 순서로 거른다 */
export function trackJiraStatus(read: Promise<JiraStatus>): void {
  const seq = ++started
  read.then((status) => {
    if (seq < applied) return
    applied = seq
    if (token === status.token) return
    token = status.token
    listeners.forEach((notify) => notify())
  }, () => {})
}
/** 일감 머리가 처음 그려질 때 한 번 */
export function loadJiraToken(api: { status(): Promise<JiraStatus> }): void {
  if (started === 0) trackJiraStatus(api.status())
}
/** null 은 아직 모름 */
export const useJiraToken = (): boolean | null => useSyncExternalStore(subscribe, () => token)
