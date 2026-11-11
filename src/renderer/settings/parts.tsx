import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useState, type ReactNode } from 'react'
import { settingsMatch } from '../../shared/settings'

// 찾는 중이면 모든 칸에서 맞는 줄만 보인다 — 줄마다 찾을 글자를 갖는다
export const QueryContext = createContext('')

/**
 * 28c 리뷰: 보이는 줄 수를 위로 알린다 — 줄 → 묶음 → 절 → 설정 창. 묶음 · 절은 줄이 없으면 숨고, 설정 창은 '맞는 설정이 없습니다' 를 정한다.
 * CSS :has() 는 줄이 묶음 카드 안으로 들어간 뒤 Chrome 이 다시 계산하지 않는 때가 있었고, 그린 뒤 DOM 을 세면 자식이 늦게 줄을 바꿀 때 값이 낡는다.
 */
const RowCounter = createContext<((delta: 1 | -1) => void) | null>(null)
export const RowCountProvider = RowCounter.Provider

/** 이 자리 아래에 보이는 줄 수와, 아래 줄들이 부를 알림 함수(위로도 전한다) */
export function useRowCount(): [number, (delta: 1 | -1) => void] {
  const parent = useContext(RowCounter)
  const [count, setCount] = useState(0)
  const report = useCallback(
    (delta: 1 | -1) => {
      setCount((n) => n + delta)
      parent?.(delta)
    },
    [parent],
  )
  return [count, report]
}

/** 설정 한 줄. 찾기 글자가 title · desc · keywords 에 모두 없으면 그리지 않는다. */
export function Row({ title, desc, keywords = '', control, children }: { title: string; desc?: ReactNode; keywords?: string; control?: ReactNode; children?: ReactNode }) {
  const query = useContext(QueryContext)
  const report = useContext(RowCounter)
  const shown = !query || settingsMatch(`${title} ${typeof desc === 'string' ? desc : ''} ${keywords}`, query)
  // 그리기 전(layout effect)에 세므로 숨김 · 안내가 한 번 깜빡이지 않는다
  useLayoutEffect(() => {
    if (!shown || !report) return
    report(1)
    return () => report(-1)
  }, [shown, report])
  if (!shown) return null
  return (
    <div className="setting-row" data-testid="setting-row" data-title={title}>
      <div className="setting-head">
        <div className="setting-text">
          <div className="setting-title">{title}</div>
          {desc && <div className="setting-desc">{desc}</div>}
        </div>
        {control}
      </div>
      {children}
    </div>
  )
}

/**
 * 28단계(Orca 의 설정 묶음): 제목은 카드 밖, 줄들은 테두리 카드 안 · 줄 사이 선.
 * 찾기로 줄이 하나도 안 남으면 묶음째 숨긴다(보이는 줄 수를 센다 — useRowCount).
 */
export function Group({ title, desc, action, children }: { title?: string; desc?: string; action?: ReactNode; children: ReactNode }) {
  const [rows, report] = useRowCount()
  return (
    <section className="setting-group" aria-label={title} hidden={rows === 0}>
      {title && (
        <div className="setting-group-head">
          <div>
            <h3 className="setting-group-title">{title}</h3>
            {desc && <div className="setting-group-desc">{desc}</div>}
          </div>
          {action}
        </div>
      )}
      <RowCountProvider value={report}>
        <div className="setting-card">{children}</div>
      </RowCountProvider>
    </section>
  )
}

/** 설정 칸 하나의 절 — 찾는 중이면 칸 이름을 제목으로 달고, 보이는 줄이 없으면 숨긴다 */
export function Section({ id, title, showTitle, children }: { id: string; title: string; showTitle: boolean; children: ReactNode }) {
  const [rows, report] = useRowCount()
  return (
    <section className="settings-section" aria-label={title} data-section={id} hidden={rows === 0}>
      {showTitle && <h2 className="settings-section-title">{title}</h2>}
      <RowCountProvider value={report}>{children}</RowCountProvider>
    </section>
  )
}

export function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange(v: boolean): void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`switch${checked ? ' on' : ''}`} onClick={() => onChange(!checked)}>
      <span className="switch-knob" aria-hidden />
    </button>
  )
}

/** 라디오 묶음 — 'segment' 는 짧은 값(Orca 의 segmented: 테두리 한 상자 · 고른 칸 바탕), 'card' 는 설명이 붙는 큰 칸 */
export function Choices<T extends string | number>({ label, value, options, onChange, kind = 'segment' }: { label: string; value: T; options: Array<{ value: T; title: ReactNode; desc?: string }>; onChange(v: T): void; kind?: 'segment' | 'card' }) {
  return (
    <div role="radiogroup" aria-label={label} className={`choices ${kind}`}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" role="radio" aria-checked={value === o.value} className={`choice${value === o.value ? ' selected' : ''}`} onClick={() => onChange(o.value)}>
          <span className="choice-title">{o.title}</span>
          {o.desc && <span className="choice-desc">{o.desc}</span>}
        </button>
      ))}
    </div>
  )
}

/** 글자 칸: 칠 때마다가 아니라 ↩ · 포커스를 잃을 때 한 번 반영(빈 이름 · 반쯤 친 경로가 저장되지 않게). Esc 는 되돌림 */
export function TextField({ label, value, onCommit, placeholder, className, list }: { label: string; value: string; onCommit(v: string): void; placeholder?: string; className?: string; list?: string }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <input
      className={className ?? 'setting-input'}
      aria-label={label}
      value={draft}
      placeholder={placeholder}
      list={list}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft === value) return
        onCommit(draft)
        setDraft(value) // 받아들이지 않은 값(틀린 수 · 빈 이름)은 칸을 원래대로 — 받아들였으면 새 value 가 다시 채운다
      }}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          e.stopPropagation() // 설정 창을 닫지 않고 되돌리기만
          setDraft(value)
        }
      }}
    />
  )
}
