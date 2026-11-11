// 명령 기록 칸 ⌘Y (19단계, History 보드) — 오른쪽에서 밀려 나오는 칸. 본문을 가리지 않고 좁힌다.
import { Icon } from './icons'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { formatDuration, type PaneActivity } from '../shared/activity'
import { isDangerous } from '../shared/danger'
import { filterHistory, groupByDay, hasMask, HISTORY_SCOPE_LABEL, HISTORY_SCOPES, isFailed, type HistoryEntry, type HistoryScope } from '../shared/history'
import { hasPane } from '../shared/layout'
import { tabShownLabel } from '../shared/model'
import type { Task } from '../shared/types'
import type { HistoryView } from './history-state'
import { integratedPanes } from './runtime'
import { terminals } from './terminals'

type Chip = 'all' | 'failed' | 'running'

interface Props {
  view: HistoryView
  tasks: readonly Task[]
  activeTaskId: string | null
  /** 지금 보고 있는 pane — 범위 '이 pane' · 입력줄에 넣기의 대상 */
  activePaneId: string | null
  activity: Readonly<Record<string, PaneActivity>>
  /** 칸을 다시 열면(⌘Y) 찾기 칸으로 */
  signal: number
  onInsert(entry: HistoryEntry): void
  onRunSplit(entry: HistoryEntry): void
  /** 그 출력으로 — 마커가 없으면 false */
  onGoto(entry: HistoryEntry): void
  onNewTab(entry: HistoryEntry): void
  /** ⚡ 빠른 명령으로 저장 (20단계) — 가린 자리가 든 명령은 고를 수 없다 */
  onSaveQuick(entry: HistoryEntry): void
  onRemove(entry: HistoryEntry): void
  onClose(): void
}

const pad = (n: number) => String(n).padStart(2, '0')
const clock = (t: number) => {
  const d = new Date(t)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const when = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clock(t)}`
}

function paneLabel(task: Task | undefined, paneId: string): string {
  const tab = task?.tabs.find((t) => hasPane(t.layout, paneId))
  return task && tab ? tabShownLabel(task, tab) : ''
}

/** 다음 범위 (⌥R) */
const nextScope = (s: HistoryScope): HistoryScope => HISTORY_SCOPES[(HISTORY_SCOPES.indexOf(s) + 1) % HISTORY_SCOPES.length]!

export function HistoryPanel({ view, tasks, activeTaskId, activePaneId, activity, signal, onInsert, onRunSplit, onGoto, onNewTab, onSaveQuick, onRemove, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<HistoryScope>('task')
  const [chip, setChip] = useState<Chip>('all')
  const [hideShort, setHideShort] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [openDays, setOpenDays] = useState<ReadonlySet<string>>(() => new Set())
  const [menuId, setMenuId] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [signal])

  const taskOf = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks])
  const now = Date.now()
  // 거르기 · 묶기는 기록 · 거르기 칸이 바뀔 때만 — 칸이 열린 동안 활동 신호마다 App 이 다시 그려도 5,000줄 × 일감을 다시 훑지 않게 (리뷰)
  const { live, failedCount, allCount, grouped } = useMemo(() => {
    const base = { scope, taskId: activeTaskId ?? '', paneId: activePaneId ?? '', hideShort, query }
    // 지운 일감의 기록(되돌리기를 기다리는 동안)은 보이지 않는다
    const live = view.entries.filter((e) => taskOf.has(e.taskId))
    const all = filterHistory(live, { ...base, failedOnly: false })
    const failed = all.filter(isFailed)
    const shown = chip === 'failed' ? failed : all
    const prev = view.prevIds
    return { live, shown, failedCount: failed.length, allCount: all.length, grouped: groupByDay(shown, Date.now(), openDays, (e) => prev.has(e.id)) }
  }, [view.entries, view.prevIds, taskOf, scope, activeTaskId, activePaneId, hideShort, query, chip, openDays])
  // 실행 중(C 뒤 D 전) — 활동에서. 저장하지 않는다
  const q = query.trim().toLowerCase()
  const running = Object.entries(activity)
    .filter(([paneId, a]) => {
      if (!a.busy || !a.command) return false
      const taskId = tasks.find((t) => paneId in t.panes)?.id
      if (!taskId) return false
      if (scope === 'task' && taskId !== activeTaskId) return false
      if (scope === 'pane' && paneId !== activePaneId) return false
      return !q || a.command.toLowerCase().includes(q)
    })
    .map(([paneId, a]) => ({ paneId, command: a.command!, startedAt: a.startedAt ?? now, taskId: tasks.find((t) => paneId in t.panes)!.id }))
  const days = chip === 'running' ? [] : grouped
  const rows = days.flatMap((d) => d.rows)
  const selected = rows.find((e) => e.id === selectedId) ?? null

  useEffect(() => {
    listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  const move = (step: 1 | -1) => {
    if (rows.length === 0) return
    const at = rows.findIndex((e) => e.id === selectedId)
    const next = at < 0 ? (step === 1 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, at + step))
    setSelectedId(rows[next]!.id)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return
    const inInput = e.target instanceof HTMLInputElement
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      move(e.key === 'ArrowDown' ? 1 : -1)
    } else if (e.key === 'Enter' && selected && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault()
      if (e.altKey) onRunSplit(selected)
      else onInsert(selected)
    } else if (e.metaKey && e.code === 'KeyO' && selected) {
      e.preventDefault()
      onGoto(selected)
    } else if (e.altKey && e.code === 'KeyR') {
      e.preventDefault()
      setScope(nextScope)
    } else if ((e.key === 'Backspace' || e.key === 'Delete') && !inInput && selected) {
      // ⌫ 는 목록에 포커스가 있을 때만 — 찾기 칸에서는 글자 지우기
      e.preventDefault()
      onRemove(selected)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (menuId) setMenuId(null)
      else onClose()
    }
  }

  const empty = live.length === 0
  // 셸 통합 신호를 아직 못 받은 pane — 셸 지킴이에 다시 붙은 셸은 새 프롬프트 전까지 신호가 없으므로, 기록 · 활동이 있던 pane 은 뺀다
  const noIntegration =
    activePaneId !== null &&
    terminals.has(activePaneId) &&
    !integratedPanes.has(activePaneId) &&
    activity[activePaneId] === undefined &&
    !view.entries.some((e) => e.paneId === activePaneId)
  return (
    <aside className="history-panel" aria-label="명령 기록" data-testid="history-panel" onKeyDown={onKeyDown}>
      <div className="history-head">
        <h2>명령 기록</h2>
        <button type="button" className="history-close" aria-label="기록 닫기 (esc)" title="닫기 (esc)" onClick={onClose}>
          esc
        </button>
      </div>
      {view.saveFailed && (
        <p className="history-fail" role="status" data-testid="history-save-failed">
          기록을 저장하지 못했어요 · 디스크 공간을 확인해 주세요
          <button type="button" className="link" onClick={view.retry}>
            다시 저장
          </button>
        </p>
      )}
      <input
        ref={inputRef}
        className="history-search"
        aria-label="기록에서 찾기"
        placeholder="명령 · 폴더 찾기"
        spellCheck={false}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="history-scopes" role="radiogroup" aria-label="범위 (⌥R)">
        {HISTORY_SCOPES.map((s) => (
          <button key={s} type="button" role="radio" aria-checked={scope === s} className={`seg${scope === s ? ' on' : ''}`} data-testid={`history-scope-${s}`} onClick={() => setScope(s)}>
            {HISTORY_SCOPE_LABEL[s]}
          </button>
        ))}
      </div>
      <div className="history-chips">
        <button type="button" className={`chip fail${chip === 'failed' ? ' on' : ''}`} aria-pressed={chip === 'failed'} data-testid="history-chip-failed" onClick={() => setChip((c) => (c === 'failed' ? 'all' : 'failed'))}>
          ✗ 실패 {failedCount}
        </button>
        <button type="button" className={`chip${chip === 'running' ? ' on' : ''}`} aria-pressed={chip === 'running'} onClick={() => setChip((c) => (c === 'running' ? 'all' : 'running'))}>
          ● 실행 중 {running.length}
        </button>
        <button type="button" className={`chip${chip === 'all' ? ' on' : ''}`} aria-pressed={chip === 'all'} onClick={() => setChip('all')}>
          전체 {allCount}
        </button>
        <label className="history-short">
          <input type="checkbox" checked={hideShort} onChange={(e) => setHideShort(e.target.checked)} /> 짧은 명령 숨기기
        </label>
      </div>
      {noIntegration && (
        <p className="history-note" data-testid="history-no-integration">
          이 pane 은 셸 통합이 없어 기록을 못 남겨요 · 명령 기록은 지금 zsh 에서만 돼요
        </p>
      )}
      <div className="history-list" ref={listRef} tabIndex={-1} role="listbox" aria-label="기록">
        {chip !== 'failed' &&
          running.map((r) => (
            <div key={`run:${r.paneId}`} className="history-row running" data-testid="history-running">
              <span className="history-badge run">● 실행 중</span>
              <span className="history-time">{clock(r.startedAt)}</span>
              <code className="history-cmd">{r.command}</code>
              <span className="history-pane">{paneLabel(taskOf.get(r.taskId), r.paneId)}</span>
            </div>
          ))}
        {empty && running.length === 0 && (
          <p className="history-empty" data-testid="history-empty">
            아직 기록이 없어요 · 이 일감에서 명령을 실행하면 여기 쌓여요.
          </p>
        )}
        {!empty && rows.length === 0 && running.length === 0 && <p className="history-empty">맞는 기록이 없어요</p>}
        {days.map((d) => (
          <section key={d.key} className="history-day">
            <h3>
              {d.label}
              {d.prev && <span className="tag">이전 세션</span>}
            </h3>
            {d.rows.map((e) => {
              const task = taskOf.get(e.taskId)
              const isSel = e.id === selectedId
              const failed = isFailed(e)
              const markerOk = !view.prevIds.has(e.id) && (terminals.get(e.paneId)?.hasMarker(e.id) ?? false)
              const danger = isDangerous(e.cmd)
              const masked = hasMask(e.cmd)
              return (
                <div
                  key={e.id}
                  role="option"
                  aria-selected={isSel}
                  data-selected={isSel}
                  data-testid="history-row"
                  data-failed={failed}
                  className={`history-row${failed ? ' failed' : ''}${isSel ? ' selected' : ''}`}
                  tabIndex={-1}
                  onClick={() => {
                    setSelectedId(isSel ? null : e.id)
                    setMenuId(null)
                  }}
                >
                  <div className="history-line">
                    <span className={`history-badge${failed ? ' fail' : ''}`}>{e.code === null ? '?' : failed ? `✗ ${e.code}` : '✓ 0'}</span>
                    <span className="history-time">{clock(e.endedAt)}</span>
                    <code className="history-cmd" data-testid="history-cmd">
                      {e.cmd}
                    </code>
                    {scope === 'all' && (
                      <span className="history-task">
                        <span className="task-dot" style={{ background: task?.color ?? 'var(--muted)' }} aria-hidden />
                        {task?.name}
                      </span>
                    )}
                    <span className="history-pane">{paneLabel(task, e.paneId)}</span>
                    <span className="history-dur">{formatDuration(e.endedAt - e.startedAt)}</span>
                  </div>
                  {isSel && (
                    <div className="history-detail" onClick={(ev) => ev.stopPropagation()}>
                      <p className="history-where">
                        {e.cwd} · {when(e.endedAt)}
                      </p>
                      {/^\s*ssh\s/.test(e.cmd) && <p className="history-note">서버 안에서 친 명령은 기록되지 않아요 · ssh 한 줄만 남아요</p>}
                      {e.tail.length > 0 && <pre className="history-tail">{e.tail.join('\n')}</pre>}
                      <div className="history-actions">
                        <button type="button" className="button" disabled={!markerOk} data-testid="history-goto" onClick={() => onGoto(e)}>
                          ↗ 출력으로 가기 <kbd>⌘O</kbd>
                        </button>
                        <button type="button" className="button" data-testid="history-insert" onClick={() => onInsert(e)}>
                          ↻ 입력줄에 넣기 <kbd>↩</kbd>
                        </button>
                        <button type="button" className="button" data-testid="history-split" onClick={() => onRunSplit(e)}>
                          ⊞ {danger || masked ? '새 pane 에 넣기' : '새 pane 에서 실행'} <kbd>⌥↩</kbd>
                        </button>
                        <button type="button" className="button" aria-haspopup="menu" aria-expanded={menuId === e.id} aria-label="더 보기" data-testid="history-more" onClick={() => setMenuId((m) => (m === e.id ? null : e.id))}>
                          ⋯
                        </button>
                      </div>
                      {!markerOk && <p className="history-note">출력이 스크롤 밖이에요{view.prevIds.has(e.id) ? ' (이전 세션)' : ''}</p>}
                      {danger && <p className="history-note">위험할 수 있는 명령이라 새 pane 에는 넣기만 해요</p>}
                      {masked && !danger && <p className="history-note">가린 값이 들어 있어 새 pane 에는 넣기만 해요 · 가린 자리를 고쳐 실행해 주세요</p>}
                      {menuId === e.id && (
                        <div className="history-menu" role="menu">
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              void navigator.clipboard.writeText(e.cmd).catch(() => {})
                              setMenuId(null)
                            }}
                          >
                            명령 복사
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setMenuId(null)
                              onNewTab(e)
                            }}
                          >
                            이 폴더에서 새 탭
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            data-testid="history-save-quick"
                            disabled={masked}
                            title={masked ? '가린 값이 들어 있어 단추로 만들 수 없어요' : undefined}
                            onClick={() => {
                              setMenuId(null)
                              onSaveQuick(e)
                            }}
                          >
                            <Icon name="bolt" size={14} />
                            빠른 명령으로 저장…
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            data-testid="history-remove"
                            onClick={() => {
                              setMenuId(null)
                              onRemove(e)
                            }}
                          >
                            이 기록 지우기 <kbd>⌫</kbd>
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
            {d.more > 0 && (
              <button type="button" className="link history-more" onClick={() => setOpenDays((s) => new Set(s).add(d.key))}>
                이날 더 보기 ({d.more})
              </button>
            )}
          </section>
        ))}
      </div>
      <p className="history-keys">↑↓ 고르기 · ↩ 입력줄에 넣기 · ⌥↩ 새 pane · ⌘O 출력으로 · ⌥R 범위 · ⌫ 지우기 · esc</p>
    </aside>
  )
}
