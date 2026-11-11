import { useEffect, useMemo, useRef, useState } from 'react'
import type { PaneActivity } from '../shared/activity'
import { createPortPoller, mergePorts, type PortChip, type ProbeResult } from '../shared/ports'
import { integratedPanes, runtime } from './runtime'
import { terminals } from './terminals'

/** 창에 포커스가 없을 때 주기 배수 (3초 → 15초) */
const BACKGROUND_FACTOR = 5

/**
 * 포트 칩 (20단계) — main 에 주기로 묻는다.
 * - 대상: 마운트된 pane 중 '셸 통합이 있고 바쁘지 않음' 이 아닌 것 + 열린 칩이 있는 pane(꺼졌는지 보려고). 없으면 묻지 않는다.
 * - 주기: 포커스 3초 · 아니면 15초 · 창이 숨으면 멈춤. 한 번에 하나(createPortPoller) — 앞 조사가 안 끝났으면 건너뜀.
 * - 옛 응답: invalidate() 뒤(끄기 · 숨기기) 이미 떠난 조사의 응답은 버린다.
 * onOpened: 새로 뜬 칩(처음 알림 · 겹침) — 늘 최신 함수를 부른다(ref).
 */
export function usePorts(ready: boolean, activity: Readonly<Record<string, PaneActivity>>, windowFocused: boolean, onOpened: (opened: PortChip[], all: Record<string, PortChip[]>) => void) {
  const [chips, setChips] = useState<Record<string, PortChip[]>>({})
  const [failed, setFailed] = useState(false)
  const chipsRef = useRef(chips)
  const activityRef = useRef(activity)
  activityRef.current = activity
  const onOpenedRef = useRef(onOpened)
  onOpenedRef.current = onOpened
  const [hidden, setHidden] = useState(() => document.hidden)
  useEffect(() => {
    const on = () => setHidden(document.hidden)
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])

  const apply = (r: ProbeResult, probed: string[]) => {
    const live = new Set(terminals.keys())
    const merged = mergePorts(chipsRef.current, r.ok ? r.ports : {}, r.ok ? probed : [], live, Date.now())
    chipsRef.current = merged.next
    setChips(merged.next)
    setFailed(!r.ok)
    if (merged.opened.length > 0) onOpenedRef.current(merged.opened, merged.next)
  }
  const poller = useMemo(() => createPortPoller((ids) => window.taskminal.ports.probe(ids), apply), [])

  const tick = () => {
    const act = activityRef.current
    const ids = [...terminals.keys()].filter(
      (id) => act[id]?.busy || !integratedPanes.has(id) || chipsRef.current[id]?.some((c) => c.closedAt === undefined),
    )
    // 물을 pane 이 없어도 닫힌 칩의 10초는 지나가야 한다
    if (ids.length === 0) apply({ ok: true, ports: {} }, [])
    else poller.tick(ids)
  }
  const tickRef = useRef(tick)
  tickRef.current = tick

  useEffect(() => {
    if (!ready || hidden) return
    tickRef.current()
    const t = setInterval(() => tickRef.current(), runtime.portPollMs * (windowFocused ? 1 : BACKGROUND_FACTOR))
    return () => clearInterval(t)
  }, [ready, hidden, windowFocused])

  return {
    chips,
    failed,
    /** 끄기 · 숨기기 뒤 — 이미 떠난 조사의 응답을 버리고 바로 다시 묻는다 */
    refresh() {
      poller.invalidate()
      tickRef.current()
    },
  }
}
