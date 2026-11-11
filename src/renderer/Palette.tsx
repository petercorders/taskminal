import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { accelLabel, type Shortcut } from '../shared/keymap'
import { markSegments, nextScope, paletteItems, SCOPE_LABEL, type PaletteInput, type PaletteItem, type PaletteScope } from '../shared/palette'
import type { HistoryEntry } from '../shared/history'
import type { AppState } from '../shared/types'
import { shortPath, sidebarSections } from './sidebar-model'
import { terminals } from './terminals'

interface Props {
  state: AppState
  /** 바꾼 단축키가 반영된 표 — 명령 이름 · 키 표시 */
  shortcuts: readonly Shortcut[]
  /** 명령 기록 (19단계 — 오래된 → 최근) */
  history?: readonly HistoryEntry[]
  /** 듣는 포트 (20단계) — 숨긴 포트 · 닫힌 칩은 부르는 쪽이 뺀다 */
  ports?: PaletteInput['ports']
  /** 고른 항목을 실행 — newTab 은 ⌘↩, shift 는 ⇧↩ (빠른 명령: 입력줄에 넣기) */
  onRun(item: PaletteItem, query: string, newTab: boolean, shift?: boolean): void
  onClose(): void
  /** 보관 일감 (25단계) — 기본 목록엔 없고, 이름을 치면 '🗄 보관함 · ↩ 되살리기' 로 나온다. id 는 `archived:<일감 id>` */
  archived?: AppState['tasks']
}

// 팔레트에 보일 명령 — 탭 번호(⌘1~9)와 팔레트 자신은 뺀다
const commandsOf = (shortcuts: readonly Shortcut[]) =>
  shortcuts
    .filter((s) => !/^tab-|^last-tab$|^palette$/.test(s.command))
    .map((s) => ({ id: s.command, label: s.label, hint: s.accel ? accelLabel(s.accel) : '' }))

const OUTPUT_BUDGET = 20
export const ARCHIVED_PREFIX = 'archived:'

const KIND_LABEL: Record<PaletteItem['kind'], string> = { task: '일감', command: '명령', quick: '빠른 명령', port: '포트', template: '템플릿', history: '기록', output: '출력', 'find-all': '모두 보기', create: '새 일감' }

/** 명령 팔레트(⌘P): 일감 · 명령 · 템플릿 · 터미널 출력을 한 번에 찾는다. ↑↓ 고르기 · ↩ 실행 · ⌘↩ 새 탭으로 · ⇥ 범위 · Esc 닫기. */
export function Palette({ state, shortcuts, history = [], ports = [], onRun, onClose, archived = [] }: Props) {
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<PaletteScope>('all')
  const [selected, setSelected] = useState(0)
  // 출력 찾기는 스크롤 버퍼를 다 훑으므로 치는 동안은 쉬었다가(150ms) 한 번 — 다른 항목은 바로 찾는다
  const [outputQuery, setOutputQuery] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setOutputQuery(query.trim()), 150)
    return () => clearTimeout(t)
  }, [query])
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  useEffect(() => inputRef.current?.focus(), [])

  const items = useMemo(() => {
    const ordered = sidebarSections(state).flatMap((s) => s.tasks)
    // 출력: 셸이 떠 있는(마운트된) pane 의 스크롤 버퍼 — 사이드바 순서, 숨은 pane 포함, 모두 합쳐 20줄까지
    const outputs: PaletteInput['outputs'] = []
    if (outputQuery.length >= 2 && (scope === 'all' || scope === 'output')) {
      for (const task of ordered)
        for (const paneId of Object.keys(task.panes)) {
          const left = OUTPUT_BUDGET - outputs.length
          if (left <= 0) break
          for (const r of terminals.get(paneId)?.search(outputQuery, left) ?? [])
            outputs.push({ paneId, taskName: task.name, line: r.line, text: r.text.trim() })
        }
    }
    return paletteItems({
      tasks: [
        ...ordered.map((t) => ({ id: t.id, name: t.name, detail: shortPath(t.cwd) })),
        ...(query.trim() ? archived.map((t) => ({ id: `${ARCHIVED_PREFIX}${t.id}`, name: t.name, detail: '🗄 보관함 · ↩ 되살리기' })) : []),
      ],
      commands: commandsOf(shortcuts),
      templates: state.settings.templates.map((t) => ({ id: t.id, name: t.name })),
      outputs,
      history: historyMatches(history, state, query),
      quick: quickOf(state, ordered),
      ports,
      query,
      scope,
    })
  }, [state, shortcuts, query, scope, outputQuery, history, ports, archived])

  useEffect(() => setSelected(0), [query, scope])
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  // ↩ 를 빨리 두 번 눌러도 한 번만 돈다 — 첫 ↩ 에 팔레트가 닫히고(키 이벤트의 상태 변경은 바로 그려진다) 두 번째는 터미널로 간다
  const run = (item: PaletteItem | undefined, newTab: boolean, shift = false) => {
    if (item) onRun(item, query.trim(), newTab, shift)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (items.length) setSelected((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length)
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      // 한글 조합 중의 ↩ 는 글자 확정 — 실행하지 않는다
      e.preventDefault()
      run(items[selected], e.metaKey, e.shiftKey)
    } else if (e.key === 'Tab') {
      e.preventDefault()
      setScope((s) => nextScope(s, e.shiftKey ? -1 : 1))
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  const optionId = (i: number) => `palette-option-${i}`
  return (
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      {/* aria-modal: 열린 동안 뒤의 터미널 · 대화가 늦게 포커스를 가져가지 않게(26단계 — 글자가 커져 늦어진 맞춤이 팔레트 입력을 뺏었다) */}
      <div className="palette" role="dialog" aria-modal="true" aria-label="명령 팔레트" data-testid="palette">
        <div className="palette-input-row">
          <span className="palette-scope" data-testid="palette-scope">
            {SCOPE_LABEL[scope]}
          </span>
          <input
            ref={inputRef}
            role="combobox"
            aria-label="찾기"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={items.length ? optionId(selected) : undefined}
            aria-autocomplete="list"
            value={query}
            placeholder="일감 · 명령 · 템플릿 · 기록 · 터미널 출력 찾기"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <span className="palette-help">⇥ 범위 · ⌘↩ 새 탭</span>
        </div>
        <ul ref={listRef} id="palette-list" role="listbox" aria-label="찾은 것" className="palette-list">
          {items.map((item, i) => (
            <li
              key={`${item.kind}:${item.id}`}
              id={optionId(i)}
              role="option"
              aria-selected={i === selected}
              className={`palette-item${i === selected ? ' selected' : ''}`}
              data-testid="palette-item"
              data-kind={item.kind}
              onMouseMove={() => setSelected(i)}
              onMouseDown={(e) => e.preventDefault()} // 입력칸 포커스 유지
              onClick={(e) => run(item, e.metaKey, e.shiftKey)}
            >
              <span className={`palette-kind ${item.kind}`}>{KIND_LABEL[item.kind]}</span>
              <span className="palette-label">
                {item.kind === 'create' ? <>‘{item.label}’ 이름으로 새 일감</> : <Marked text={item.label} marks={item.marks} />}
              </span>
              {item.detail && <span className="palette-detail">{item.detail}</span>}
              {item.hint && <kbd className="palette-hint">{item.hint}</kbd>}
              {item.kind === 'task' && i === selected && <kbd className="palette-hint">⌘↩ 새 탭</kbd>}
              {item.kind === 'quick' && i === selected && <kbd className="palette-hint">⇧↩ 입력줄에 넣기</kbd>}
              {item.kind === 'port' && i === selected && <kbd className="palette-hint">⌘↩ 그 터미널로</kbd>}
            </li>
          ))}
          {items.length === 0 && <li className="palette-empty">맞는 것이 없습니다</li>}
        </ul>
      </div>
    </div>
  )
}

/** ⌘P 에 넘길 기록 — 최근 것부터 거꾸로 훑어 맞는 명령 8개(같은 명령 한 번)에서 멈춘다. 지운 일감(되돌리기 기다리는 중)의 기록은 뺀다 (리뷰) */
function historyMatches(history: readonly HistoryEntry[], state: AppState, query: string): Array<{ id: string; cmd: string; taskName: string }> {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const names = new Map(state.tasks.map((t) => [t.id, t.name]))
  const out: Array<{ id: string; cmd: string; taskName: string }> = []
  const seen = new Set<string>()
  for (let i = history.length - 1; i >= 0 && out.length < HISTORY_PICK; i--) {
    const h = history[i]!
    const name = names.get(h.taskId)
    if (name === undefined || seen.has(h.cmd) || !h.cmd.toLowerCase().includes(q)) continue
    seen.add(h.cmd)
    out.push({ id: h.id, cmd: h.cmd, taskName: name })
  }
  return out
}
const HISTORY_PICK = 8

/** ⌘P 의 빠른 명령 — 모든 일감의 단추(사이드바 순서) + 모든 일감 것(지금 일감에서 실행). id 는 `일감 id|runKey` */
function quickOf(state: AppState, ordered: readonly AppState['tasks'][number][]): NonNullable<PaletteInput['quick']> {
  const out: NonNullable<PaletteInput['quick']> = []
  for (const t of ordered)
    for (const q of t.quickCommands ?? [])
      out.push({ id: `${t.id}|t:${q.id}`, label: q.label + (q.confirm ? '…' : ''), command: q.command, taskName: t.id === state.activeTaskId ? `${t.name} (지금 일감)` : t.name, hint: q.confirm ? '실행 전 물어봐요' : '' })
  if (state.activeTaskId)
    for (const q of state.settings.quickCommands)
      out.push({ id: `${state.activeTaskId}|a:${q.id}`, label: q.label + (q.confirm ? '…' : ''), command: q.command, taskName: '모든 일감', hint: q.confirm ? '실행 전 물어봐요' : '' })
  return out
}

/** 맞은 글자를 굵게 */
function Marked({ text, marks }: { text: string; marks: number[] }) {
  return (
    <>
      {markSegments(text, marks).map((seg, i) => (seg.mark ? <mark key={i}>{seg.text}</mark> : seg.text))}
    </>
  )
}
