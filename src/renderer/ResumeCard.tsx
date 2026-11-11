import { useEffect, useRef, useState } from 'react'
import { formatDuration } from '../shared/activity'
import type { Fact, ResumeCard as Card } from '../shared/resume'

const MARK: Record<Fact['kind'], string> = { attention: '?', failed: '✕', running: '●', agent: '✦', note: '✎', changed: '±', done: '✓', todo: '☐' }

interface Props {
  card: Card
  /** 처음 한 번 안내 줄 (설정 resumeTipSeen) */
  tip: string | null
  /** 앱이 터미널로 포커스를 돌릴 때(팔레트 · 메뉴 뒤) — 카드가 떠 있는 동안은 카드가 다시 가져간다 */
  focusSignal: number
  onGo(fact: Fact): void
  onHistory(): void
  onClose(): void
}

/** 이어받기 요약 카드 (24단계) — 일감 화면 맨 위에 덮어 뜬다. 뜨면 포커스, ↑↓ 줄 · ↩ 그리로 · Esc 닫기 */
export function ResumeCard({ card, tip, focusSignal, onGo, onHistory, onClose }: Props) {
  const rows = [...(card.top ? [card.top] : []), ...card.facts]
  const [at, setAt] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  // 바로 한 번(뜨자마자 친 Esc 를 받게) + 터미널의 포커스 효과보다 뒤에 한 번 더
  useEffect(() => {
    box.current?.focus()
    const t = setTimeout(() => box.current?.focus(), 0)
    return () => clearTimeout(t)
  }, [focusSignal])
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      return onClose()
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      return setAt((i) => Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1))))
    }
    if (e.key === 'Enter' && rows[at]) {
      e.preventDefault()
      onGo(rows[at])
    }
  }
  const row = (f: Fact, i: number, top: boolean) => (
    <li key={i} className={`resume-fact ${f.kind}${top ? ' top' : ''}${i === at ? ' sel' : ''}`} data-testid={top ? 'resume-top' : 'resume-fact'} data-kind={f.kind} onMouseEnter={() => setAt(i)}>
      <span className="resume-mark" aria-hidden="true">
        {MARK[f.kind]}
      </span>
      <span className="resume-text">
        <span className="resume-main">{f.text}</span>
        {f.sub && <span className="resume-sub">{f.sub}</span>}
      </span>
      <button type="button" className="button small" tabIndex={-1} onClick={() => onGo(f)}>
        {f.button}
      </button>
    </li>
  )
  return (
    <div className="resume-card" role="dialog" aria-label="이어받기 요약" tabIndex={-1} ref={box} onKeyDown={onKey} data-testid="resume-card">
      <div className="resume-head">
        <strong>그 사이 일</strong>
        <span className="resume-away">{formatDuration(card.awayMs)} 동안 안 봄</span>
        <button type="button" className="icon-button" aria-label="요약 닫기" title="닫기 (Esc)" onClick={onClose} data-testid="resume-close">
          ✕
        </button>
      </div>
      {tip && (
        <p className="resume-tip" data-testid="resume-tip">
          {tip}
        </p>
      )}
      <ul className="resume-list">
        {card.top && row(card.top, 0, true)}
        {card.facts.map((f, i) => row(f, i + (card.top ? 1 : 0), false))}
      </ul>
      {card.more > 0 && (
        <button type="button" className="resume-more link-button" onClick={onHistory} data-testid="resume-more">
          외 {card.more}개 · 명령 기록(⌘Y)에서 보기
        </button>
      )}
      <p className="resume-keys">↑↓ 고르기 · ↩ 그리로 · Esc 닫기</p>
    </div>
  )
}
