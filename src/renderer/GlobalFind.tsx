// 모든 출력에서 찾기 ⇧⌘F (19단계, GlobalFind 보드) — 가운데 창. 마운트된 pane 은 xterm 버퍼, 안 연 탭은 저장된 스크롤 글.
// pane 하나씩 조각으로(setTimeout 0) 훑어 입력을 막지 않고, 새 입력이 오면 세대 번호로 하던 찾기를 버린다.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import {
  CONTEXT,
  DEBOUNCE_MS,
  findInLines,
  isMaskQuery,
  makeMatcher,
  MANY_SHOW,
  PER_PANE,
  prevSessionLine,
  savedLines,
  secretHint,
  snippet,
  TOTAL,
  type Line,
  type LineHit,
} from '../shared/global-find'
import { paneIds } from '../shared/layout'
import { tabLabel } from '../shared/model'
import { redact as redactText, type SecretOptions } from '../shared/redact'
import type { AppState } from '../shared/types'
import { sidebarSections } from './sidebar-model'
import { terminals } from './terminals'

export type FindScope = 'all' | 'task' | 'group'
const SCOPES: readonly FindScope[] = ['all', 'task', 'group']
const SCOPE_LABEL: Record<FindScope, string> = { all: '모든 일감', task: '지금 일감', group: '지금 묶음' }
/** 완료 상태 (model 의 기본 상태 '완료') */
const DONE = 'done'
/** 결과가 이보다 많으면 일감마다 MANY_SHOW 줄만 먼저 */
const MANY = 20

/** ⇧⌘F 를 다시 누르면 그대로 — 마지막 낱말 · 범위 · 거르기 · 고른 줄 */
export interface FindMemo {
  query: string
  scope: FindScope
  cs: boolean
  re: boolean
  prev: boolean
  done: boolean
  selected: string | null
  /** 빈 칸에서 ↑ */
  last: string
}
export const FIND_MEMO: FindMemo = { query: '', scope: 'all', cs: false, re: false, prev: true, done: false, selected: null, last: '' }

/** 고른 결과 — App 이 그 일감 · 탭 · pane 으로 가서 그 줄로 */
export interface FindTarget {
  paneId: string
  line: number
  /** 맞은 글자 (그 pane 의 ⌘F 막대에 넣는다) */
  text: string
}

interface PaneResult {
  key: string
  taskId: string
  taskName: string
  color: string | null
  tabName: string
  paneId: string
  saved: boolean
  prev: boolean
  done: boolean
  hits: LineHit[]
  more: boolean
}

interface Props {
  state: AppState
  redact: SecretOptions
  memo: FindMemo
  onMemo(memo: FindMemo): void
  onJump(target: FindTarget, keepOpen: boolean): void
  onClose(): void
}

const rowKey = (paneId: string, line: number) => `${paneId}:${line}`

export function GlobalFind({ state, redact, memo, onMemo, onJump, onClose }: Props) {
  const [query, setQuery] = useState(memo.query)
  const [scope, setScope] = useState<FindScope>(memo.scope)
  const [cs, setCs] = useState(memo.cs)
  const [re, setRe] = useState(memo.re)
  const [prev, setPrev] = useState(memo.prev)
  const [done, setDone] = useState(memo.done)
  const [selected, setSelected] = useState<string | null>(memo.selected)
  const [results, setResults] = useState<PaneResult[]>([])
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [stopped, setStopped] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set())
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const linesRef = useRef(new Map<string, Line[]>())
  const gen = useRef(0)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  // 닫힐 때 기억 — 다시 열면 그대로
  const memoRef = useRef(memo)
  memoRef.current = { query, scope, cs, re, prev, done, selected, last: query.trim() || memo.last }
  useEffect(() => () => onMemo(memoRef.current), []) // eslint-disable-line react-hooks/exhaustive-deps

  // 찾기 대상(일감 · 탭 · pane)은 찾기를 시작할 때 떠 둔다 — 그 사이 닫힌 pane 은 ↩ 때 다시 찾는다
  const stateRef = useRef(state)
  stateRef.current = state
  const redactRef = useRef(redact)
  redactRef.current = redact

  useEffect(() => {
    const my = ++gen.current
    const q = query
    const timer = setTimeout(() => {
      if (my !== gen.current) return
      setError(null)
      setStopped(false)
      linesRef.current = new Map()
      if (q.trim() === '') {
        setResults([])
        setProgress(null)
        return
      }
      const matcher = makeMatcher(q, { cs, re })
      if (!matcher.ok) {
        setError(matcher.error)
        setResults([])
        setProgress(null)
        return
      }
      const st = stateRef.current
      const active = st.tasks.find((t) => t.id === st.activeTaskId) ?? null
      const ordered = sidebarSections(st).flatMap((s) => s.tasks)
      const tasks = ordered.filter((t) => scope === 'all' || (active && (scope === 'task' ? t.id === active.id : t.groupId === active.groupId)))
      const jobs = tasks.flatMap((task) => task.tabs.flatMap((tab) => paneIds(tab.layout).map((paneId) => ({ task, tab, paneId }))))
      const maskQuery = isMaskQuery(q)
      const found: PaneResult[] = []
      let total = 0
      setResults([])
      setProgress({ done: 0, total: jobs.length })
      const step = async (i: number) => {
        if (my !== gen.current) return
        if (i >= jobs.length || total >= TOTAL) {
          setStopped(total >= TOTAL && i < jobs.length)
          setProgress(null)
          return
        }
        const { task, tab, paneId } = jobs[i]!
        const handle = terminals.get(paneId)
        let lines: Line[] = []
        let saved = false
        let banner = -1
        if (handle) {
          lines = handle.lines()
          banner = prevSessionLine(lines)
        } else {
          saved = true
          const entry = await window.taskminal.scrollback.load(paneId).catch(() => null)
          if (my !== gen.current) return
          lines = entry ? savedLines(entry.text) : []
        }
        // 이전 세션: 되살린 배너 앞 줄 · 안 연 탭의 저장된 글 전부
        const isPrev = (l: Line) => saved || l.line < banner
        if (!prev) lines = lines.filter((l) => !isPrev(l))
        const r = findInLines(lines, matcher, { limit: Math.min(PER_PANE, TOTAL - total), redact: redactRef.current, maskQuery })
        if (r.hits.length > 0) {
          linesRef.current.set(paneId, lines)
          total += r.hits.length
          found.push({
            key: paneId,
            taskId: task.id,
            taskName: task.name,
            color: task.color,
            tabName: tabLabel(task, tab),
            paneId,
            saved,
            prev: r.hits.some((h) => saved || h.line < banner),
            done: task.statusId === DONE,
            hits: r.hits,
            more: r.more,
          })
          setResults([...found])
        }
        setProgress({ done: i + 1, total: jobs.length })
        setTimeout(() => void step(i + 1), 0)
      }
      void step(0)
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query, scope, cs, re, prev])
  // 창을 닫으면 남은 조각을 버린다
  useEffect(() => () => void gen.current++, [])

  const visible = done ? results : results.filter((r) => !r.done)
  const hiddenDone = results.filter((r) => r.done).reduce((n, r) => n + r.hits.length, 0)
  const hitCount = visible.reduce((n, r) => n + r.hits.length, 0)
  const many = hitCount > MANY
  // 일감 묶음 (사이드바 순서 그대로 — results 가 그 순서로 쌓인다)
  const byTask = useMemo(() => {
    const out: Array<{ taskId: string; taskName: string; color: string | null; done: boolean; panes: PaneResult[] }> = []
    for (const r of visible) {
      const last = out[out.length - 1]
      if (last && last.taskId === r.taskId) last.panes.push(r)
      else out.push({ taskId: r.taskId, taskName: r.taskName, color: r.color, done: r.done, panes: [r] })
    }
    return out
  }, [visible])
  // 보이는 줄 (키로 고르는 차례)
  const rows: Array<{ key: string; paneId: string; hit: LineHit }> = []
  const shownOf = new Map<string, number>()
  for (const t of byTask) {
    if (collapsed.has(t.taskId)) continue
    const cap = many && !opened.has(t.taskId) ? MANY_SHOW : Infinity
    let n = 0
    for (const p of t.panes)
      for (const h of p.hits) {
        if (n >= cap) break
        rows.push({ key: rowKey(p.paneId, h.line), paneId: p.paneId, hit: h })
        n++
      }
    shownOf.set(t.taskId, n)
  }
  const shownKeys = new Set(rows.map((r) => r.key))
  const sel = rows.find((r) => r.key === selected) ?? rows[0] ?? null

  useEffect(() => {
    listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [sel?.key])

  const jump = (row: { paneId: string; hit: LineHit } | null, keepOpen: boolean) => {
    if (!row) return
    setSelected(rowKey(row.paneId, row.hit.line))
    onJump({ paneId: row.paneId, line: row.hit.line, text: row.hit.text.slice(row.hit.at, row.hit.at + row.hit.len) }, keepOpen)
    // 열어 둔 채(⌘↩): 뒤에서 보이게 된 터미널이 포커스를 가져가도 입력칸으로 돌아온다(그려진 뒤)
    if (keepOpen) requestAnimationFrame(() => requestAnimationFrame(() => inputRef.current?.focus()))
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return
    const opt = e.altKey && e.metaKey
    if (opt && e.code === 'Digit1') return e.preventDefault(), setPrev((v) => !v)
    if (opt && e.code === 'Digit3') return e.preventDefault(), setDone((v) => !v)
    if (opt && e.code === 'KeyC') return e.preventDefault(), setCs((v) => !v)
    if (opt && e.code === 'KeyR') return e.preventDefault(), setRe((v) => !v)
    if (e.key === 'ArrowUp' && query === '' && memo.last) {
      e.preventDefault()
      return setQuery(memo.last)
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (rows.length === 0) return
      const at = sel ? rows.findIndex((r) => r.key === sel.key) : -1
      const next = (at + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length
      setSelected(rows[next]!.key)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      jump(sel, e.metaKey)
    } else if (e.key === 'Tab') {
      e.preventDefault()
      setScope((s) => SCOPES[(SCOPES.indexOf(s) + (e.shiftKey ? SCOPES.length - 1 : 1)) % SCOPES.length]!)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  const savedTabs = new Set(visible.filter((r) => r.saved).map((r) => r.paneId)).size
  const hint = !error && progress === null && query.trim() !== '' && hitCount === 0 ? secretHint(query.trim(), redact) : null
  const sel2 = sel && linesRef.current.get(sel.paneId)
  const context = sel && sel2 ? sel2.filter((l) => Math.abs(l.line - sel.hit.line) <= CONTEXT && l.line !== sel.hit.line) : []
  const allCollapsed = byTask.length > 0 && byTask.every((t) => collapsed.has(t.taskId))
  return (
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette global-find" role="dialog" aria-label="모든 출력에서 찾기" data-testid="global-find" onKeyDown={onKeyDown}>
        <div className="palette-input-row">
          <span className="palette-scope" data-testid="global-find-scope">
            {SCOPE_LABEL[scope]}
          </span>
          <input
            ref={inputRef}
            aria-label="모든 출력에서 찾을 말"
            value={query}
            placeholder="모든 터미널 출력에서 찾기"
            spellCheck={false}
            onChange={(e) => {
              setQuery(e.target.value)
              setSelected(null)
            }}
          />
          <span className="palette-help">⇥ 범위 · ⌘↩ 열어 둔 채</span>
        </div>
        {/* 칩을 눌러도 입력칸 포커스는 그대로(눌러 놓고 바로 이어 치게) */}
        <div className="gf-chips" onMouseDown={(e) => e.preventDefault()}>
          <button type="button" className={`chip${prev ? ' on' : ''}`} aria-pressed={prev} title="⌥⌘1" onClick={() => setPrev((v) => !v)}>
            이전 세션
          </button>
          <button type="button" className={`chip${done ? ' on' : ''}`} aria-pressed={done} title="⌥⌘3" data-testid="gf-done" onClick={() => setDone((v) => !v)}>
            완료 일감
          </button>
          <button type="button" className={`chip${cs ? ' on' : ''}`} aria-pressed={cs} title="대소문자 (⌥⌘C)" onClick={() => setCs((v) => !v)}>
            Aa
          </button>
          <button type="button" className={`chip${re ? ' on' : ''}`} aria-pressed={re} title="정규식 (⌥⌘R)" data-testid="gf-re" onClick={() => setRe((v) => !v)}>
            .*
          </button>
          {byTask.length > 1 && (
            <button type="button" className="link gf-fold" onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(byTask.map((t) => t.taskId)))}>
              {allCollapsed ? '모두 펼치기' : '모두 접기'}
            </button>
          )}
        </div>
        {progress && (
          <div className="gf-progress" data-testid="gf-progress">
            찾는 중 · pane {progress.done}/{progress.total}
            <span className="gf-bar" style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
          </div>
        )}
        {error && (
          <p className="gf-error" role="alert" data-testid="gf-error">
            {error} · .* 를 끄면 글자 그대로 찾아요
            <button type="button" className="link" onClick={() => setRe(false)}>
              .* 끄기
            </button>
          </p>
        )}
        {stopped && (
          <p className="gf-note" data-testid="gf-stopped">
            {TOTAL}개에서 멈췄어요 · 일감 {byTask.length}
            {scope !== 'task' && (
              <button type="button" className="link" onClick={() => setScope('task')}>
                지금 일감만
              </button>
            )}
            <button type="button" className="link" onClick={() => setScope((s) => SCOPES[(SCOPES.indexOf(s) + 1) % SCOPES.length]!)}>
              범위 바꾸기
            </button>
          </p>
        )}
        <div className="gf-list" ref={listRef} role="listbox" aria-label="찾은 줄">
          {byTask.map((t) => (
            <section key={t.taskId} className="gf-task">
              <button type="button" className="gf-task-head" aria-expanded={!collapsed.has(t.taskId)} onClick={() => setCollapsed((s) => toggle(s, t.taskId))}>
                <span className="task-dot" style={{ background: t.color ?? 'var(--muted)' }} aria-hidden />
                {t.taskName}
                {t.done && <span className="tag">완료 일감</span>}
                <span className="gf-count">{t.panes.reduce((n, p) => n + p.hits.length, 0)}</span>
              </button>
              {!collapsed.has(t.taskId) &&
                t.panes.map((p) => {
                  const hits = p.hits.filter((h) => shownKeys.has(rowKey(p.paneId, h.line)))
                  if (hits.length === 0) return null
                  return (
                    <div key={p.key} className="gf-pane">
                      <div className="gf-pane-head">
                        {p.tabName}
                        {p.prev && <span className="tag">이전 세션</span>}
                        {p.saved && <span className="tag">저장된 출력</span>}
                      </div>
                      {hits.map((h) => {
                        const key = rowKey(p.paneId, h.line)
                        const isSel = sel?.key === key
                        const s = snippet(h.text, h.at, h.len)
                        return (
                          <div key={key}>
                            <div
                              role="option"
                              aria-selected={isSel}
                              data-selected={isSel}
                              data-testid="gf-row"
                              className={`gf-row${isSel ? ' selected' : ''}`}
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={(e) => jump({ paneId: p.paneId, hit: h }, e.metaKey)}
                            >
                              <span className="gf-line">{h.line + 1}</span>
                              <code>
                                {s.pre}
                                <mark>{s.hit}</mark>
                                {s.post}
                              </code>
                            </div>
                            {isSel && context.length > 0 && (
                              <pre className="gf-context" data-testid="gf-context">
                                {context.map((l) => `${l.line + 1}  ${redactText(l.text, redact)}`).join('\n')}
                              </pre>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )
                })}
              {!collapsed.has(t.taskId) && many && !opened.has(t.taskId) && (shownOf.get(t.taskId) ?? 0) < t.panes.reduce((n, p) => n + p.hits.length, 0) && (
                <button type="button" className="link gf-more" onClick={() => setOpened((s) => new Set(s).add(t.taskId))}>
                  이 일감에서 {t.panes.reduce((n, p) => n + p.hits.length, 0) - (shownOf.get(t.taskId) ?? 0)}개 더 보기
                </button>
              )}
            </section>
          ))}
          {!error && progress === null && query.trim() !== '' && hitCount === 0 && (
            <div className="palette-empty" data-testid="gf-empty">
              찾은 게 없어요
              {scope !== 'all' && (
                <button type="button" className="link" onClick={() => setScope('all')}>
                  모든 일감에서 찾기
                </button>
              )}
              {hint && (
                <p className="gf-note" data-testid="gf-secret">
                  비밀값은 가린 뒤에 찾아서, 원래 값으로는 안 나와요
                  <button type="button" className="link" onClick={() => setQuery(hint)}>
                    ‘{hint}’ 로 찾기
                  </button>
                </p>
              )}
            </div>
          )}
        </div>
        {!done && hiddenDone > 0 && (
          <p className="gf-note" data-testid="gf-hidden-done">
            완료 일감에 {hiddenDone}개 더 있어요
            <button type="button" className="link" onClick={() => setDone(true)}>
              포함하기
            </button>
          </p>
        )}
        {savedTabs > 0 && <p className="gf-note" data-testid="gf-saved">열지 않은 탭 {savedTabs}개는 저장된 출력에서 찾았어요</p>}
        <p className="history-keys">↑↓ 고르기 · ↩ 가기 · ⌘↩ 열어 둔 채 · ⇥ 범위 · ⌥⌘1 이전 세션 · ⌥⌘3 완료 · ⌥⌘C Aa · ⌥⌘R .* · esc</p>
      </div>
    </div>
  )
}

function toggle(s: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(s)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}
