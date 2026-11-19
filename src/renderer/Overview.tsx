import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PaneActivity } from '../shared/activity'
import type { Branches } from '../shared/git'
import type { AppState, Id, Task } from '../shared/types'
import { MERGE_LABEL, type MergeBadge } from '../shared/worktree-cleanup'
import { ActivityIcon, activityText } from './activity-ui'
import { AgentIcon } from './AgentIcon'
import { inboxRows, overviewSections, overviewTarget } from './overview-model'
import { inboxModel, useInbox } from './inbox'
import { inboxUnread } from '../shared/inbox'
import type { NotifyKind } from '../shared/types'
import type { ActivityState } from '../shared/activity'
import { ConfirmDialog } from './ConfirmDialog'
import { shortPath, timeAgo, type PaneTarget } from './sidebar-model'

interface Props {
  state: AppState
  activity: Readonly<Record<Id, PaneActivity>>
  branches: Branches
  /** 67단계: 연결 worktree 의 병합 칩(사이드바와 같은 값) */
  mergeOf?(task: Task): MergeBadge | null
  unread: ReadonlySet<Id>
  onOpen(taskId: Id, tabId: Id, paneId: Id): void
  onClose(): void
}

/** 66단계 지난 알림의 종류 아이콘 */
const KIND_ICON: Record<NotifyKind, ActivityState> = { wait: 'waiting', long: 'done', fail: 'failed', exit: 'idle' }
/** 처음에 보이는 지난 알림 수 — 더 있으면 '모두 보기' */
const INBOX_SHOWN = 8

/** 전체 보기의 표시 여부는 App이 소유한다. 기존 task-view/터미널은 마운트를 유지한다. */
export function Overview({ state, activity, branches, unread, onOpen, onClose, mergeOf }: Props) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const current = useRef(state)
  current.current = state
  // 67단계: 사이드바와 같은 병합 칩 — 워크트리 패널에서 읽은 때의 값
  const mergeChip = (task: Task) => {
    const merge = mergeOf?.(task)
    return merge && <span className={`overview-merge ${merge.state}`} title={`${merge.reason} — 워크트리 패널에서 읽은 때 기준`}> · {MERGE_LABEL[merge.state]}</span>
  }
  const sections = useMemo(() => overviewSections(state, activity, branches, unread, query), [state, activity, branches, unread, query])
  const shown = sections.filter((s) => filter === 'all' || s.key === filter)
  const total = shown.reduce((n, s) => n + s.cards.length, 0)
  const allCount = state.tasks.filter((t) => t.archivedAt === undefined).length
  // 66단계 지난 알림 — 모델은 App 과 같이 쓴다(shared/inbox-model)
  const inbox = useInbox()
  const rows = useMemo(() => inboxRows(state, inbox), [state, inbox])
  const unreadCount = inboxUnread(inbox)
  const [allInbox, setAllInbox] = useState(false)
  const [clearing, setClearing] = useState(false)
  useEffect(() => { input.current?.focus() }, [])
  const open = (target: PaneTarget) => {
    if (!overviewTarget(current.current, target)) {
      setError('이 일감이나 화면이 닫혔어요. 목록에서 다시 골라 주세요.')
      return
    }
    setError(null)
    onOpen(target.taskId, target.tabId, target.paneId)
  }
  return (
    <section className="overview" aria-labelledby="overview-title" data-testid="overview" onKeyDown={(e) => {
      // 안의 확인 창이 Esc 를 받았으면(defaultPrevented) 전체 보기는 닫지 않는다
      if (e.key === 'Escape' && !e.defaultPrevented && !e.nativeEvent.isComposing) { e.preventDefault(); e.stopPropagation(); onClose() }
    }}>
      <header className="overview-header">
        <h1 id="overview-title">전체 보기</h1>
        <button type="button" className="button" onClick={onClose}>일감으로 돌아가기</button>
      </header>
      <div className="overview-controls">
        <input ref={input} className="input" aria-label="전체 일감 찾기" placeholder="일감 · 묶음 · 브랜치 · 에이전트 찾기" value={query} onChange={(e) => setQuery(e.target.value)} />
        <label>상태 <select className="input" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="전체 보기 상태">
          <option value="all">모든 상태</option>
          {sections.map((s) => <option key={s.key} value={s.key}>{s.title} ({s.cards.length})</option>)}
        </select></label>
        <span className="dim small" role="status">{total}개 일감</span>
      </div>
      {error && <p role="alert" className="err">{error}</p>}
      <section className="overview-inbox" aria-labelledby="overview-inbox-title" data-testid="overview-inbox">
        <div className="overview-inbox-head">
          <h2 id="overview-inbox-title">지난 알림 {unreadCount > 0 && <span className="dim small">안 읽음 {unreadCount}</span>}</h2>
          <button type="button" className="button" disabled={unreadCount === 0} onClick={() => inboxModel().readAll()}>모두 읽음</button>
          <button type="button" className="button" disabled={inbox.length === 0} onClick={() => setClearing(true)}>비우기…</button>
        </div>
        {rows.length === 0 ? <p className="dim small">지난 알림이 없어요. 보고 있지 않은 화면의 알림이 여기에 남아요(30일 · 300개).</p> : <>
          <ul className="overview-inbox-list">
            {(allInbox ? rows : rows.slice(0, INBOX_SHOWN)).map(({ entry, taskName, target }) => <li key={entry.id}>
              <button type="button" className={`button overview-inbox-row${entry.read ? '' : ' unread'}`} data-testid="overview-inbox-row" aria-disabled={!target} onClick={() => {
                inboxModel().read({ ids: [entry.id] })
                if (target) open(target)
                else setError('이 알림의 화면이 닫혔어요. 알림은 읽음으로 남겨 둘게요.')
              }}>
                <ActivityIcon state={KIND_ICON[entry.kind]} />
                <span className="overview-inbox-title">{entry.title}{!entry.read && <span className="overview-unread" aria-label="안 읽음"> · 안 읽음</span>}</span>
                <span className="overview-inbox-body">{entry.body || taskName}</span>
                <span className="dim small">{entry.body ? '' : `${taskName} · `}{timeAgo(entry.at, Date.now())} 전</span>
              </button>
            </li>)}
          </ul>
          {rows.length > INBOX_SHOWN && <button type="button" className="link" onClick={() => setAllInbox((v) => !v)}>{allInbox ? '줄여 보기' : `모두 보기 (${rows.length})`}</button>}
        </>}
      </section>
      {clearing && createPortal(
        <ConfirmDialog title="지난 알림 비우기" message="받은편지함의 지난 알림을 모두 지울까요? 되돌릴 수 없어요. 일감 · 화면은 그대로예요." confirmLabel="비우기" onConfirm={() => {
          setClearing(false)
          inboxModel().clear().catch(() => setError('지난 알림을 지우지 못했어요. 다시 시도해 주세요.'))
        }} onCancel={() => setClearing(false)} />,
        document.body,
      )}
      {allCount === 0 ? <p className="empty">일감이 없습니다. 사이드바에서 새 일감을 만들어 주세요.</p> : total === 0 ? (
        <div className="empty"><p>조건에 맞는 일감이 없습니다.</p><button type="button" className="button" onClick={() => { setQuery(''); setFilter('all'); input.current?.focus() }}>검색과 필터 지우기</button></div>
      ) : <div className="overview-grid">
        {shown.map((section) => <section className="overview-column" key={section.key} aria-label={section.title}>
          <h2>{section.title} <span className="dim small">{section.cards.length}</span></h2>
          {section.cards.length === 0 && <p className="dim small">이 상태의 일감이 없습니다.</p>}
          {section.cards.map((card) => <article className="overview-card" key={card.task.id} data-testid="overview-card" data-task-id={card.task.id}>
            <h3><button type="button" className="link overview-task-open" disabled={!card.target} onClick={() => card.target && open(card.target)} title={card.task.name}>
              {card.task.name}{card.unread && <span className="overview-unread" aria-label="안 읽음"> · 안 읽음</span>}
            </button></h3>
            <div className="dim small overview-meta" title={card.task.cwd}>{card.group && `${card.group} · `}{shortPath(card.task.cwd)}{card.branch && ` · ${card.branch}`}{mergeChip(card.task)}</div>
            <p className={`overview-last ${card.line?.tone ?? 'dim'}`}>{card.line?.agent ? <span className="agent-label"><AgentIcon agent={card.line.agent} />{card.line.text}</span> : (card.line?.text ?? '최근 활동이 없습니다.')}</p>
            {card.lastAt !== null && <div className="dim small">최근 활동 {timeAgo(card.lastAt, Date.now())} 전</div>}
            <ul className="overview-panes" aria-label={`${card.task.name} 화면`}>
              {card.panes.map((pane) => <li key={`${pane.tabId}:${pane.paneId}`}><button type="button" className="button overview-pane" onClick={() => open(pane)}>
                <ActivityIcon state={pane.activity?.state ?? 'idle'} />
                {/* 59단계: 대화 pane 은 이름 앞에, 터미널에서 띄운 에이전트는 상태 글자(Claude · 허락 기다림) 앞에 로고 */}
                <span className={pane.agent ? 'agent-label' : undefined}>{pane.agent && <AgentIcon agent={pane.agent} />}{pane.label}</span>
                <span className={`dim small${pane.activity?.agent ? ' agent-label' : ''}`}>{pane.activity?.agent && <AgentIcon agent={pane.activity.agent.agent} />}{activityText(pane.activity)}</span>
              </button></li>)}
            </ul>
          </article>)}
        </section>)}
      </div>}
    </section>
  )
}
