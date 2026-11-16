// 15d: ⌘F 찾기 막대 — 보고 있는 pane 오른쪽 위. 디자인이 없어 팔레트 보드의 말(판 · 선 · 돋보기 · esc 칩)을 빌렸다.
import { useEffect, useRef, useState } from 'react'
import { findCountLabel, findKeyAction } from '../shared/find'
import type { Shortcut } from '../shared/keymap'
import { commandForKey } from './keyboard'
import { findingPanes } from './runtime'
import { terminals } from './terminals'

interface Props {
  paneId: string
  /** ⌘F 를 다시 누름 — 입력칸으로 포커스 · 전체 선택 */
  signal: number
  /** 이 글자로 연다 (19단계 ⇧⌘F 결과로 갈 때) — 찾은 줄이 이미 선택돼 있어 그 자리부터 이어 찾는다 */
  initialQuery?: string
  onClose(): void
  /** 단축키 표 (설정에서 바꾼 키 포함) */
  shortcuts: readonly Shortcut[]
}

export function FindBar({ paneId, signal, initialQuery, onClose, shortcuts }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [result, setResult] = useState({ index: -1, count: 0 })

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
    if (initialQuery === undefined) return
    setQuery(initialQuery)
    // 결과로 가는 reveal(다음 프레임) 뒤에 — 그 선택에서 이어 찾아 같은 줄이 첫 결과가 된다
    let inner = 0
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        if (initialQuery) terminals.get(paneId)?.find.next(initialQuery, true)
        inputRef.current?.select()
      })
    })
    return () => {
      cancelAnimationFrame(outer)
      cancelAnimationFrame(inner)
    }
    // signal 이 바뀔 때만 (같은 열기에서 글자를 바꿔도 다시 넣지 않는다)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signal])

  // 결과 수를 받고, 막대가 닫히거나 다른 pane 으로 옮기면 칠한 것을 지운다
  useEffect(() => {
    findingPanes.add(paneId)
    const find = terminals.get(paneId)?.find
    const off = find?.onResults((index, count) => setResult({ index, count }))
    return () => {
      findingPanes.delete(paneId)
      off?.()
      find?.clear()
    }
  }, [paneId])

  const search = (q: string) => {
    setQuery(q)
    const find = terminals.get(paneId)?.find
    if (!find) return
    if (q === '') {
      find.clear()
      setResult({ index: -1, count: 0 })
    } else find.next(q, true)
  }
  const step = (dir: 'next' | 'prev') => {
    const find = terminals.get(paneId)?.find
    if (!find || query === '') return
    if (dir === 'next') find.next(query)
    else find.prev(query)
  }
  const label = findCountLabel(query, result.index, result.count)

  return (
    <div className="find-bar" role="search" data-testid="find-bar">
      <svg aria-hidden="true" width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="6" cy="6" r="4.3" />
        <path d="M9.3 9.3l3.2 3.2" strokeLinecap="round" />
      </svg>
      <input
        ref={inputRef}
        type="text"
        value={query}
        aria-label="터미널에서 찾을 말"
        placeholder="출력에서 찾기"
        spellCheck={false}
        onChange={(e) => search(e.currentTarget.value)}
        onKeyDown={(e) => {
          // 앱 단축키 처리는 입력칸의 키를 건너뛴다 — 열린 채 ⌘F(바꾼 키 포함)는 여기서 전체 선택 (15d 리뷰)
          if (commandForKey(e.nativeEvent, shortcuts) === 'find') {
            e.preventDefault()
            e.currentTarget.select()
            return
          }
          const action = findKeyAction(e.key, e.shiftKey, e.nativeEvent.isComposing)
          if (!action) return
          e.preventDefault()
          if (action === 'close') onClose()
          else step(action)
        }}
      />
      <span className={`find-count${label === '없음' ? ' none' : ''}`} data-testid="find-count" aria-live="polite">
        {label}
      </span>
      <button type="button" className="find-step" aria-label="이전 (⇧↩)" title="이전 (⇧↩)" onClick={() => step('prev')} disabled={query === ''}>
        ↑
      </button>
      <button type="button" className="find-step" aria-label="다음 (↩)" title="다음 (↩)" onClick={() => step('next')} disabled={query === ''}>
        ↓
      </button>
      <button type="button" className="find-esc" aria-label="찾기 닫기 (esc)" title="닫기" onClick={onClose}>
        esc
      </button>
    </div>
  )
}
