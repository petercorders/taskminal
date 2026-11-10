import { useEffect, useState } from 'react'
import { formatDuration, type ActivityState, type PaneActivity } from '../shared/activity'

export const ACTIVITY_LABEL: Record<ActivityState, string> = {
  idle: '쉬는 중',
  running: '실행 중',
  waiting: '입력 기다림',
  done: '끝남',
  failed: '실패',
}

/** 활동 아이콘 — 색만이 아니라 모양으로도 구분한다: 실행 중 호 · 기다림 원 · 끝남 체크 · 실패 네모. 쉬는 중은 그리지 않는다. */
export function ActivityIcon({ state, size = 12 }: { state: ActivityState; size?: number }) {
  if (state === 'idle') return null
  return (
    <svg className={`activity-icon ${state}`} width={size} height={size} viewBox="0 0 12 12" role="img" aria-label={ACTIVITY_LABEL[state]} data-activity={state}>
      {state === 'running' && <path d="M6 1.5 A4.5 4.5 0 1 1 1.5 6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />}
      {state === 'waiting' && <circle cx="6" cy="6" r="4" fill="currentColor" />}
      {state === 'done' && <path d="M2.2 6.3 L4.8 8.8 L9.8 3.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />}
      {state === 'failed' && <rect x="2" y="2" width="8" height="8" rx="1.2" fill="currentColor" />}
    </svg>
  )
}

/** 실행 중이면 1초마다 다시 그려 경과를 늘린다 */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [ticking])
  return now
}

/** pane 머리: 명령(없으면 '셸') · 폴더 · 실행 상태(● 실행 중 경과 / ✓ exit 0 걸린 시간 / ✗ exit N) */
export function PaneHead({ activity, folder, focused }: { activity: PaneActivity | undefined; folder: string; focused: boolean }) {
  const a = activity
  const now = useNow(a?.busy ?? false)
  const took = a?.startedAt !== undefined ? formatDuration((a.endedAt ?? now) - a.startedAt) : null
  let status: string | null = null
  if (a?.state === 'running' || (a?.state === 'waiting' && a.busy)) status = `${ACTIVITY_LABEL[a.state]}${took ? ` · ${took}` : ''}`
  else if (a?.state === 'waiting') status = ACTIVITY_LABEL.waiting
  else if (a?.state === 'done' || a?.state === 'failed') status = `${a.exitCode === undefined ? ACTIVITY_LABEL[a.state] : `exit ${a.exitCode}`}${took ? ` · ${took}` : ''}`
  return (
    <div className={`pane-head${focused ? ' focused' : ''}`} data-testid="pane-head" data-activity={a?.state ?? 'idle'}>
      <span className="pane-head-command" title={a?.command}>
        {a?.command ?? '셸'}
      </span>
      <span className="pane-head-folder">{folder}</span>
      {status && (
        <span className={`pane-head-status ${a!.state}`} data-testid="pane-status" title={a?.message}>
          {a && <ActivityIcon state={a.state} size={10} />}
          {status}
        </span>
      )}
    </div>
  )
}
