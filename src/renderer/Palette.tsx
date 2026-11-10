import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { accelLabel, SHORTCUTS } from '../shared/keymap'
import { nextScope, paletteItems, SCOPE_LABEL, type PaletteItem, type PaletteScope } from '../shared/palette'
import type { AppState } from '../shared/types'
import { shortPath, sidebarSections } from './sidebar-model'
import { terminals } from './terminals'

interface Props {
  state: AppState
  /** 고른 항목을 실행 — newTab 은 ⌘↩ */
  onRun(item: PaletteItem, query: string, newTab: boolean): void
  onClose(): void
}

// 팔레트에 보일 명령 — 탭 번호(⌘1~9)와 팔레트 자신은 뺀다
const COMMANDS = SHORTCUTS.filter((s) => !/^tab-|^last-tab$|^palette$/.test(s.command)).map((s) => ({
  id: s.command,
  label: s.label,
  hint: accelLabel(s.accel),
}))

const KIND_LABEL: Record<PaletteItem['kind'], string> = { task: '일감', command: '명령', template: '템플릿', output: '출력', create: '새 일감' }

/** 명령 팔레트(⌘P): 일감 · 명령 · 템플릿 · 터미널 출력을 한 번에 찾는다. ↑↓ 고르기 · ↩ 실행 · ⌘↩ 새 탭으로 · ⇥ 범위 · Esc 닫기. */
export function Palette({ state, onRun, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<PaletteScope>('all')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  useEffect(() => inputRef.current?.focus(), [])

  const items = useMemo(() => {
    const ordered = sidebarSections(state).flatMap((s) => s.tasks)
    const q = query.trim()
    // 출력: 셸이 떠 있는(마운트된) pane 의 스크롤 버퍼 — 사이드바 순서, 숨은 pane 포함
    const outputs =
      q.length >= 2 && (scope === 'all' || scope === 'output')
        ? ordered.flatMap((task) =>
            Object.keys(task.panes).flatMap((paneId) =>
              (terminals.get(paneId)?.search(q, 20) ?? []).map((r) => ({ paneId, taskName: task.name, line: r.line, text: r.text.trim() })),
            ),
          )
        : []
    return paletteItems({
      tasks: ordered.map((t) => ({ id: t.id, name: t.name, detail: shortPath(t.cwd) })),
      commands: COMMANDS,
      templates: state.settings.templates.map((t) => ({ id: t.id, name: t.name })),
      outputs,
      query,
      scope,
    })
  }, [state, query, scope])

  useEffect(() => setSelected(0), [query, scope])
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  // ↩ 를 빨리 두 번 눌러도 한 번만 돈다 — 첫 ↩ 에 팔레트가 닫히고(키 이벤트의 상태 변경은 바로 그려진다) 두 번째는 터미널로 간다
  const run = (item: PaletteItem | undefined, newTab: boolean) => {
    if (item) onRun(item, query.trim(), newTab)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (items.length) setSelected((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length)
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      // 한글 조합 중의 ↩ 는 글자 확정 — 실행하지 않는다
      e.preventDefault()
      run(items[selected], e.metaKey)
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
      <div className="palette" role="dialog" aria-label="명령 팔레트" data-testid="palette">
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
            placeholder="일감 · 명령 · 템플릿 · 터미널 출력 찾기"
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
              onClick={(e) => run(item, e.metaKey)}
            >
              <span className={`palette-kind ${item.kind}`}>{KIND_LABEL[item.kind]}</span>
              <span className="palette-label">
                {item.kind === 'create' ? <>‘{item.label}’ 이름으로 새 일감</> : <Marked text={item.label} marks={item.marks} />}
              </span>
              {item.detail && <span className="palette-detail">{item.detail}</span>}
              {item.hint && <kbd className="palette-hint">{item.hint}</kbd>}
              {item.kind === 'task' && i === selected && <kbd className="palette-hint">⌘↩ 새 탭</kbd>}
            </li>
          ))}
          {items.length === 0 && <li className="palette-empty">맞는 것이 없습니다</li>}
        </ul>
      </div>
    </div>
  )
}

/** 맞은 글자를 굵게 */
function Marked({ text, marks }: { text: string; marks: number[] }) {
  if (marks.length === 0) return <>{text}</>
  const set = new Set(marks)
  return (
    <>
      {[...text].map((ch, i) => (set.has(i) ? <mark key={i}>{ch}</mark> : ch))}
    </>
  )
}
