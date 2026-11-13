import { useEffect, useMemo, useRef, useState } from 'react'
import type { PaneActivity } from '../shared/activity'
import type { Branches } from '../shared/git'
import type { AppState, Id } from '../shared/types'
import { ACTIVITY_LABEL, ActivityIcon } from './activity-ui'
import { overviewSections, overviewTarget } from './overview-model'
import { shortPath, timeAgo, type PaneTarget } from './sidebar-model'

interface Props {
  state: AppState
  activity: Readonly<Record<Id, PaneActivity>>
  branches: Branches
  unread: ReadonlySet<Id>
  onOpen(taskId: Id, tabId: Id, paneId: Id): void
  onClose(): void
}

/** 전체 보기의 표시 여부는 App이 소유한다. 기존 task-view/터미널은 마운트를 유지한다. */
export function Overview({ state, activity, branches, unread, onOpen, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const current = useRef(state)
  current.current = state
  const sections = useMemo(() => overviewSections(state, activity, branches, unread, query), [state, activity, branches, unread, query])
  const shown = sections.filter((s) => filter === 'all' || s.key === filter)
  const total = shown.reduce((n, s) => n + s.cards.length, 0)
  const allCount = state.tasks.filter((t) => t.archivedAt === undefined).length
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
      if (e.key === 'Escape' && !e.nativeEvent.isComposing) { e.preventDefault(); e.stopPropagation(); onClose() }
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
            <div className="dim small overview-meta" title={card.task.cwd}>{card.group && `${card.group} · `}{shortPath(card.task.cwd)}{card.branch && ` · ${card.branch}`}</div>
            <p className={`overview-last ${card.line?.tone ?? 'dim'}`}>{card.line?.text ?? '최근 활동이 없습니다.'}</p>
            {card.lastAt !== null && <div className="dim small">최근 활동 {timeAgo(card.lastAt, Date.now())} 전</div>}
            <ul className="overview-panes" aria-label={`${card.task.name} 화면`}>
              {card.panes.map((pane) => <li key={`${pane.tabId}:${pane.paneId}`}><button type="button" className="button overview-pane" onClick={() => open(pane)}>
                <ActivityIcon state={pane.activity?.state ?? 'idle'} /><span>{pane.label}</span><span className="dim small">{ACTIVITY_LABEL[pane.activity?.state ?? 'idle']}</span>
              </button></li>)}
            </ul>
          </article>)}
        </section>)}
      </div>}
    </section>
  )
}
