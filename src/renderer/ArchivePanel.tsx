import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Modal } from './Modal'
import { RECENT_DELETED_MS, recentlyDeleted, searchArchive, type DeletedTask } from '../shared/archive'
import type { AppState, Id, Task } from '../shared/types'
import { shortPath } from './sidebar-model'

interface Props {
  state: AppState
  onRestore(ids: Id[]): void
  onRemove(task: Task): void
  /** 최근 지운 것 되살리기 — 17단계 restoreTask 로 그 백업에서 */
  onRestoreDeleted(d: DeletedTask): void
  onClose(): void
}

function day(at: number): string {
  const d = new Date(at)
  return `${d.getMonth() + 1}월 ${d.getDate()}일`
}
function meta(t: Task): string {
  const notes = (t.notes ?? []).length
  return [t.host ? `⇄ ${t.host}:${t.cwd}` : shortPath(t.cwd), `탭 ${t.tabs.length}`, notes ? `메모 ${notes}` : ''].filter(Boolean).join(' · ')
}

/** 보관함 ⇧⌘E — 보관한 일감(찾기 · 고르기 · 되살리기 · 지우기) + 최근 지운 것(17단계 '지움' 백업, 30일) */
export function ArchivePanel({ state, onRestore, onRemove, onRestoreDeleted, onClose }: Props) {
  const [tab, setTab] = useState<'archive' | 'deleted'>('archive')
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const [checked, setChecked] = useState<ReadonlySet<Id>>(new Set())
  const [deleted, setDeleted] = useState<DeletedTask[] | null>(null)
  const [deletedError, setDeletedError] = useState<string | null>(null)
  const [readingDeleted, setReadingDeleted] = useState(false)
  const [retry, setRetry] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const list = useMemo(() => searchArchive(state, query), [state, query])

  // 최근 지운 것 — 열 때마다 백업을 다시 읽고, 늦게 온 옛 응답은 버린다(요청 번호)
  const reqNo = useRef(0)
  const stateRef = useRef(state)
  stateRef.current = state
  // 일감이 더해지거나 빠질 때만 다시 읽는다(state 는 pane 폴더 · 본 때로 자주 바뀐다 — 그때마다 다시 읽으면 끝나지 않는다)
  const taskKey = state.tasks.map((t) => t.id).join(',')
  useEffect(() => {
    if (tab !== 'deleted') return
    const no = ++reqNo.current
    setReadingDeleted(true)
    setDeletedError(null)
    void (async () => {
      const now = Date.now()
      // 이유를 가리지 않는다 — 지우기 직전 모습이 이미 같은 백업(시작 · 자동)에 있으면 '지움' 백업은 따로 생기지 않는다(같은 내용은 건너뜀)
      try {
        const infos = (await window.taskminal.backup.list()).filter((b) => now - b.at <= RECENT_DELETED_MS)
        if (no !== reqNo.current) return
        const read = await Promise.all(infos.map(async (b) => ({ name: b.name, at: b.at, state: await window.taskminal.backup.read(b.name).catch(() => null) })))
        if (no !== reqNo.current) return
        const valid = read.filter((r): r is { name: string; at: number; state: AppState } => r.state !== null)
        const failed = read.length - valid.length
        const found = recentlyDeleted(valid, stateRef.current, now)
        // 재시도 중 일부 백업이 실패해도 이미 읽은 항목은 남긴다. 지금 존재하는 일감은 제외한다.
        setDeleted((old) => {
          if (!failed) return found
          const have = new Set(stateRef.current.tasks.map((t) => t.id))
          const ids = new Set(found.map((d) => d.task.id))
          return [...found, ...(old ?? []).filter((d) => !have.has(d.task.id) && !ids.has(d.task.id) && now - d.at <= RECENT_DELETED_MS)]
        })
        setDeletedError(failed ? `백업 ${failed}개를 읽지 못했어요. 일부 일감이 보이지 않을 수 있어요.` : null)
      } catch {
        if (no !== reqNo.current) return
        setDeletedError('백업 목록을 읽지 못했어요. 다시 시도해 주세요.')
      } finally {
        if (no === reqNo.current) setReadingDeleted(false)
      }
    })()
    return () => { reqNo.current++ }
  }, [tab, taskKey, retry])

  useEffect(() => searchRef.current?.focus(), [tab])
  useEffect(() => setSel(0), [query, tab])

  // 최근 지운 것도 찾기 칸으로 거른다 — 그린 줄 · ↑↓ · ↩ 가 같은 목록을 본다(25단계 리뷰: ↩ 가 거르기 전 목록에서 골랐다)
  const shownDeleted = (deleted ?? []).filter((d) => !query.trim() || d.task.name.toLowerCase().includes(query.trim().toLowerCase()))
  const rows = tab === 'archive' ? list : shownDeleted
  const selected = Math.max(0, Math.min(sel, rows.length - 1))
  useEffect(() => setSel((i) => Math.max(0, Math.min(i, rows.length - 1))), [rows.length])
  const selectedId = tab === 'archive' ? list[selected]?.id : shownDeleted[selected]?.task.id
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [selected, selectedId, tab])
  const pickIds = (): Id[] => (checked.size > 0 ? [...checked] : list[selected] ? [list[selected]!.id] : [])

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return
    // 버튼 · 탭 · 체크박스는 각자의 Enter/Space 기본 동작을 쓴다.
    if (e.target instanceof HTMLElement && e.target.closest('button, input[type="checkbox"]')) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setSel((i) => Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1))))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (tab === 'archive') {
        const ids = pickIds()
        if (ids.length) onRestore(ids)
      } else {
        const d = shownDeleted[selected]
        if (d) onRestoreDeleted(d)
      }
    } else if (e.key === ' ' && tab === 'archive' && e.target !== searchRef.current) {
      e.preventDefault()
      const t = list[selected]
      if (t) setChecked((c) => (c.has(t.id) ? new Set([...c].filter((x) => x !== t.id)) : new Set([...c, t.id])))
    } else if (e.key === 'Backspace' && e.metaKey && tab === 'archive' && (e.target !== searchRef.current || query === '')) {
      // 글이 있는 찾기 칸의 ⌘⌫ 는 글 지우기(macOS) — 일감 지우기로 가로채지 않는다(빈 칸이면 지울 글이 없으니 일감)
      e.preventDefault()
      const t = list[selected]
      if (t) onRemove(t)
    } else if (e.key === '/' && e.target !== searchRef.current) {
      e.preventDefault()
      searchRef.current?.focus()
    }
  }

  return (
    <Modal role="dialog" labelledBy="archive-title" className="archive-panel" onCancel={onClose}>
      <div onKeyDown={onKeyDown} data-testid="archive-panel" style={{ display: 'contents' }}>
        <div className="weekly-head">
          <h2 id="archive-title">보관함</h2>
          <div className="archive-tabs" role="tablist">
            <button type="button" role="tab" className="button" aria-selected={tab === 'archive'} onClick={() => setTab('archive')}>
              보관한 일감 {searchArchive(state, '').length}
            </button>
            <button type="button" role="tab" className="button" aria-selected={tab === 'deleted'} onClick={() => setTab('deleted')} data-testid="archive-deleted-tab">
              최근 지운 것
            </button>
          </div>
        </div>
        <input
          ref={searchRef}
          className="archive-search"
          aria-label="보관함에서 찾기"
          placeholder={tab === 'archive' ? '⌕ 이름 · 폴더 · 메모에서 찾기  /' : '⌕ 이름에서 찾기'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <ul ref={listRef} className="archive-list" role="listbox" aria-label={tab === 'archive' ? '보관한 일감' : '최근 지운 것'}>
          {tab === 'archive' &&
            list.map((t, i) => (
              <li key={t.id} className="archive-row" role="option" aria-selected={i === selected} data-testid="archive-row" data-task-name={t.name} onMouseDown={() => setSel(i)}>
                <input type="checkbox" aria-label={`${t.name} 고르기`} checked={checked.has(t.id)} onChange={() => setChecked((c) => (c.has(t.id) ? new Set([...c].filter((x) => x !== t.id)) : new Set([...c, t.id])))} />
                <span>
                  <div className="archive-name">{t.name}</div>
                  <div className="archive-meta">{meta(t)}</div>
                </span>
                <span className="archive-when">{t.archivedAt ? day(t.archivedAt) : ''}</span>
                <span className="archive-actions">
                  <button type="button" className="button primary" onClick={() => onRestore([t.id])}>
                    되살리기
                  </button>
                  <button type="button" className="button" onClick={() => onRemove(t)} aria-label={`${t.name} 지우기`}>
                    지우기…
                  </button>
                </span>
              </li>
            ))}
          {tab === 'deleted' &&
            shownDeleted.map((d, i) => (
              <li key={d.task.id} className="archive-row" role="option" aria-selected={i === selected} data-testid="deleted-row" data-task-name={d.task.name} onMouseDown={() => setSel(i)}>
                <span />
                <span>
                  <div className="archive-name">{d.task.name}</div>
                  <div className="archive-meta">{meta(d.task)}</div>
                </span>
                <span className="archive-when">{Math.max(0, Math.ceil((d.at + RECENT_DELETED_MS - Date.now()) / 86_400_000))}일 남음</span>
                <span className="archive-actions">
                  <button type="button" className="button primary" onClick={() => onRestoreDeleted(d)}>
                    되살리기
                  </button>
                </span>
              </li>
            ))}
        </ul>
        {tab === 'archive' && list.length === 0 && (
          <p className="archive-empty">{query.trim() ? `‘${query.trim()}’ 와 맞는 보관 일감이 없어요.` : '보관한 일감이 없어요 — 일감 우클릭 › 보관하기(⌥⌘A) 하면 여기 모여요.'}</p>
        )}
        {tab === 'deleted' && readingDeleted && <p className="archive-empty" role="status">읽는 중…</p>}
        {tab === 'deleted' && deletedError && (
          <div className="archive-empty" role="alert">
            {deletedError}{' '}
            <button type="button" className="button" disabled={readingDeleted} onClick={() => setRetry((n) => n + 1)}>다시 시도</button>
          </div>
        )}
        {tab === 'deleted' && !readingDeleted && !deletedError && deleted?.length === 0 && <p className="archive-empty">30일 안에 지운 일감이 없어요.</p>}
        {tab === 'deleted' && !readingDeleted && !!deleted?.length && shownDeleted.length === 0 && <p className="archive-empty">‘{query.trim()}’ 와 맞는 지운 일감이 없어요.</p>}
        <p className="archive-hint">
          {tab === 'archive'
            ? `↑↓ 고르기 · Space 체크 · ↩ 되살리기${checked.size ? ` (${checked.size}개)` : ''} · ⌘⌫ 지우기 · / 찾기 — 되살리면 탭 · 분할 · 폴더 그대로 새 셸이 떠요`
            : '지운 일감은 백업에 30일 남아요 · 되살리면 탭 · 폴더가 돌아오고 셸은 새로 열려요 (명령 기록은 돌아오지 않아요)'}
        </p>
      </div>
    </Modal>
  )
}
