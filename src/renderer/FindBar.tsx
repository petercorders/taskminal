// 15d: ⌘F 찾기 막대 — 보고 있는 pane 오른쪽 위. 디자인이 없어 팔레트 보드의 말(판 · 선 · 돋보기 · esc 칩)을 빌렸다.
import { useEffect, useRef, useState } from 'react'
import { findCountLabel, findKeyAction } from '../shared/find'
import { terminals } from './terminals'

interface Props {
  paneId: string
  /** ⌘F 를 다시 누름 — 입력칸으로 포커스 · 전체 선택 */
  signal: number
  onClose(): void
}

export function FindBar({ paneId, signal, onClose }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [result, setResult] = useState({ index: -1, count: 0 })

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [signal])

  // 결과 수를 받고, 막대가 닫히거나 다른 pane 으로 옮기면 칠한 것을 지운다
  useEffect(() => {
    const find = terminals.get(paneId)?.find
    if (!find) return
    const off = find.onResults((index, count) => setResult({ index, count }))
    return () => {
      off()
      find.clear()
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
