import { useEffect, useId, useRef, useState } from 'react'
import type { Task } from '../shared/types'
import { expandHome } from '../shared/cwd'
import {
  DEADLINE_MS,
  SessionFeed,
  filterSessions,
  sessionAgo,
  withDeadline,
  type AgentSession,
  type AgentSessionList,
  type ResumeHow,
  type SessionFilter,
} from '../shared/agent-sessions'
import { Modal } from './Modal'
import { Icon } from './icons'
import { shortPath } from './sidebar-model'
import './agent-sessions.css'
import { FindSwitch } from './work-tools-ui'
import type { FindKind } from '../shared/work-tools'

/** 화면에 그리는 줄 상한 — 찾기로 좁힌다 */
const SHOWN_MAX = 200
/** 패널이 보이는 동안 다시 읽는 간격 */
const REFRESH_MS = 30_000

export const sessionKey = (s: { agent: string; id: string }) => `${s.agent}:${s.id.toLowerCase()}`

interface Props {
  /** 패널을 연 순간의 일감 — 이어 하기는 이 일감에 새 탭 */
  taskId: string | null
  /** 지금 상태 — 연 뒤 일감이 사라졌는지 id 로 다시 찾는다 */
  tasks: readonly Task[]
  /** 이 앱에 이미 열린 대화 (sessionKey) */
  openKeys: ReadonlySet<string>
  onResume(session: AgentSession, how: ResumeHow, taskId: string): Promise<void>
  onClose(): void
  /** 56단계: 다른 찾기 화면에서 가져온 검색어 · 찾는 곳 바꾸기 */
  initialQuery?: string
  onSwitch?(kind: FindKind, query: string): void
}

/** 53단계 '에이전트 세션' — 밖에서 시작한 Claude · Codex 세션을 찾아 대화 · 터미널로 이어 한다 */
export function AgentSessionsPanel({ taskId, tasks, openKeys, onResume, onClose, initialQuery, onSwitch }: Props) {
  const titleId = useId()
  const input = useRef<HTMLInputElement>(null)
  const feed = useRef<SessionFeed<AgentSessionList> | null>(null)
  const mounted = useRef(false)
  const resuming = useRef(false)
  const [list, setList] = useState<AgentSessionList | null>(null)
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState('')
  const [query, setQuery] = useState(initialQuery ?? '')
  const [agent, setAgent] = useState<SessionFilter['agent']>('all')
  const [scope, setScope] = useState<SessionFilter['scope']>(taskId ? 'task' : 'all')
  const [busy, setBusy] = useState<string | null>(null)
  const [failure, setFailure] = useState<{ key: string; message: string; retry: () => void } | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const previous = document.activeElement
    mounted.current = true
    input.current?.focus()
    const f = new SessionFeed<AgentSessionList>(
      () => withDeadline(window.taskminal.agentSessions.list(), DEADLINE_MS, '응답이 없어요.'),
      (r) => {
        setLoading(false)
        setNow(Date.now())
        if (r.ok) {
          setList(r.value)
          setListError('')
        } else setListError(r.error instanceof Error ? r.error.message : '세션 목록을 읽지 못했어요.')
      },
    )
    feed.current = f
    // 창이 안 보일 때는 다시 읽지 않는다 — 다시 보이면 한 번
    const visibility = () => f.setVisible(document.visibilityState === 'visible')
    const focus = () => f.request()
    visibility()
    f.request()
    const timer = setInterval(() => f.request(), REFRESH_MS)
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('focus', focus)
    return () => {
      mounted.current = false
      f.dispose()
      clearInterval(timer)
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('focus', focus)
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])

  const refresh = () => {
    setLoading(true)
    setListError('')
    feed.current?.request()
  }

  const task = taskId ? tasks.find((t) => t.id === taskId && t.archivedAt === undefined) : undefined
  const blocked = !taskId ? '일감을 먼저 고르면 이어 할 수 있어요.' : !task ? '연 일감이 사라졌어요. 다른 일감에서 다시 열어 주세요.' : task.host ? '원격 일감에서는 이 Mac 의 세션을 이어 할 수 없어요.' : ''
  const folder = task && list ? expandHome(task.cwd, list.home) : null
  const all = list ? filterSessions(list.sessions, { query, agent, scope, folder }) : []
  const shown = all.slice(0, SHOWN_MAX)

  const resume = async (s: AgentSession, how: ResumeHow) => {
    const key = sessionKey(s)
    // 이미 열린 대화로 가기는 일감이 없어도 된다(일감이 필요한 것은 새로 이어 하기뿐)
    if (resuming.current || (!taskId && !openKeys.has(key))) return
    resuming.current = true
    setBusy(key)
    setFailure(null)
    try {
      await onResume(s, how, taskId ?? '')
      if (mounted.current) onClose()
    } catch (reason) {
      if (mounted.current) setFailure({ key, message: reason instanceof Error ? reason.message : '이어 하지 못했어요.', retry: () => void resume(s, how) })
    } finally {
      resuming.current = false
      if (mounted.current) setBusy(null)
    }
  }

  const status = loading && !list
    ? '세션 기록을 읽는 중…'
    : !list
      ? ''
      : scope === 'task' && !folder
        ? '연 일감이 없어 이 일감 폴더로 거를 수 없어요. 범위를 ‘모두’로 바꿔 보세요.'
        : all.length === 0
          ? scope === 'task' ? '이 일감 폴더에서 시작한 세션이 없어요. 범위를 ‘모두’로 바꿔 보세요.' : query ? '찾는 세션이 없어요.' : 'Claude · Codex 세션 기록이 없어요.'
          : `세션 ${all.length}개${all.length > SHOWN_MAX ? ` · 앞 ${SHOWN_MAX}개만 보여요. 찾기로 좁혀 주세요` : ''}`
  const skipped = list && list.skipped + list.badLines > 0 ? `읽지 못한 기록 ${list.skipped}개 · 손상 줄 ${list.badLines}개는 건너뛰었어요.` : ''

  return (
    <Modal role="dialog" labelledBy={titleId} className="agent-sessions" onCancel={onClose}>
      <div className="agent-sessions-head">
        <h1 id={titleId}>에이전트 세션</h1>
        <div className="agent-sessions-head-actions">
          <button type="button" className="button" onClick={refresh} disabled={loading}>
            <Icon name="restore" />새로 고침
          </button>
          <button type="button" className="button" onClick={onClose}>
            닫기
          </button>
        </div>
      </div>
      <FindSwitch current="sessions" query={query} {...(onSwitch ? { onSwitch } : {})} />
      <p className="agent-sessions-hint">터미널 · 다른 앱에서 시작한 Claude · Codex 세션이에요. 기록 파일은 읽기만 해요.</p>
      <label className="field">
        <span>찾기</span>
        <input ref={input} type="search" value={query} maxLength={200} placeholder="첫 글 · 폴더" onChange={(e) => setQuery(e.target.value)} />
      </label>
      <div className="agent-sessions-filters">
        <label className="field">
          <span>에이전트</span>
          <select value={agent} onChange={(e) => setAgent(e.target.value === 'claude' || e.target.value === 'codex' ? e.target.value : 'all')}>
            <option value="all">모두</option>
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
          </select>
        </label>
        <label className="field">
          <span>범위</span>
          <select value={scope} onChange={(e) => setScope(e.target.value === 'task' ? 'task' : 'all')}>
            <option value="task">이 일감 폴더</option>
            <option value="all">모두</option>
          </select>
        </label>
      </div>
      {blocked && <div className="agent-sessions-blocked">{blocked}</div>}
      {listError && (
        <div role="alert" className="field-error agent-sessions-error">
          <span>
            세션 목록: {listError}
            {list ? ` 마지막으로 받은 목록(${new Date(list.at).toLocaleTimeString()})을 보여요.` : ''}
          </span>
          <button type="button" className="button" onClick={refresh}>
            다시 시도
          </button>
        </div>
      )}
      <div role="status" className="agent-sessions-status">
        {status}
        {skipped && <span className="agent-sessions-skipped"> {skipped}</span>}
      </div>
      <ul className="agent-sessions-list" aria-label="에이전트 세션 목록" aria-busy={loading || busy !== null}>
        {shown.map((s) => {
          const key = sessionKey(s)
          const open = openKeys.has(key)
          const label = s.summary || '(첫 글 없음)'
          return (
            <li key={key} className="agent-session" data-session-id={s.id} data-agent={s.agent}>
              <div className="agent-session-text">
                <span className="agent-session-summary">{label}</span>
                <span className="agent-session-meta">
                  {s.agent === 'claude' ? 'Claude' : 'Codex'}
                  {s.accountName ? ` · ${s.accountName}` : ''} · <span title={s.cwd}>{shortPath(s.cwd)}</span> · {sessionAgo(s.updatedAt, now)}
                  {open ? ' · 이 앱에 열림' : ''}
                </span>
              </div>
              <div className="agent-session-actions">
                {open ? (
                  <button type="button" className="button" disabled={busy !== null} aria-label={`열린 대화로 가기: ${label}`} onClick={() => void resume(s, 'chat')}>
                    <Icon name="back" />열린 대화로 가기
                  </button>
                ) : (
                  <>
                    <button type="button" className="button" data-action="chat" disabled={busy !== null || !!blocked} aria-label={`대화로 이어 하기: ${label}`} onClick={() => void resume(s, 'chat')}>
                      <Icon name="restore" />대화로 이어 하기
                    </button>
                    <button type="button" className="button" data-action="terminal" disabled={busy !== null || !!blocked} aria-label={`터미널로 이어 하기: ${label}`} onClick={() => void resume(s, 'terminal')}>
                      <Icon name="terminal" />터미널로 이어 하기
                    </button>
                  </>
                )}
              </div>
              {busy === key && (
                <div role="status" className="agent-session-connecting">
                  연결하는 중…
                </div>
              )}
              {failure?.key === key && (
                <div role="alert" className="field-error agent-sessions-error">
                  <span>{failure.message}</span>
                  <button type="button" className="button" onClick={failure.retry} disabled={busy !== null}>
                    다시 시도
                  </button>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </Modal>
  )
}
