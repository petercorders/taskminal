// 55단계: 사이드바 둘째 줄 · 일감 머리가 보는 이슈 연결 목록. 앱을 열 때 한 번, 이슈 패널이 읽을 때마다 새로 싣는다.
import { useSyncExternalStore } from 'react'
import type { IssueApi, IssueLink } from '../shared/issues'

let links: readonly IssueLink[] = []
let started = 0
let applied = 0
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }

/** 읽기 하나를 싣는다 — 늦게 끝난 옛 읽기가 더 새 읽기의 결과를 덮지 않게 시작 순서로 거른다 */
export function trackIssueLinks(read: Promise<IssueLink[]>): void {
  const seq = ++started
  read.then((next) => {
    if (seq < applied) return
    applied = seq
    links = next
    listeners.forEach((notify) => notify())
  }, () => {})
}
export const useIssueLinks = (): readonly IssueLink[] => useSyncExternalStore(subscribe, () => links)
/** 앱을 연 때 한 번 — 실패(손상된 기록)는 이슈 패널이 안내한다 */
export const loadIssueLinks = (api: IssueApi) => trackIssueLinks(api.links())
