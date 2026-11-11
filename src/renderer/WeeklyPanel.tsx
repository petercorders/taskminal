import { useMemo, useState, type KeyboardEvent } from 'react'
import { Modal } from './Modal'
import { hours, weekRange, weeklyMarkdown, weeklySummary } from '../shared/weekly'
import type { HistoryEntry } from '../shared/history'
import type { Task } from '../shared/types'

interface Props {
  /** 연 순간의 명령 기록(가린 뒤) — 주를 바꿔도 다시 읽지 않는다 */
  entries: readonly HistoryEntry[]
  /** 보관 일감 포함 — 지운 일감은 기록이 이미 없다 */
  tasks: readonly Task[]
  onCopied(): void
  onClose(): void
}

const DOW = ['월', '화', '수', '목', '금', '토', '일']
function label(start: number, offset: number): string {
  const s = new Date(start)
  const e = new Date(start + 6 * 86_400_000)
  const md = (d: Date) => `${d.getMonth() + 1}월 ${d.getDate()}일`
  return `${md(s)} – ${s.getMonth() === e.getMonth() ? `${e.getDate()}일` : md(e)}${offset === 0 ? ' (이번 주)' : ''}`
}

/** 주간 정리 — 한 주의 일감 · 명령 · 실패 · 터미널 시간(명령이 돈 시간 합). [ ] 로 주 바꾸기 · ⇧⌘C 마크다운으로 복사 */
export function WeeklyPanel({ entries, tasks, onCopied, onClose }: Props) {
  const [offset, setOffset] = useState(0)
  const [now] = useState(() => Date.now())
  const range = useMemo(() => weekRange(now, new Date(now).getTimezoneOffset(), offset), [now, offset])
  const names = useMemo(() => new Map(tasks.map((t) => [t.id, t.name])), [tasks])
  const s = useMemo(() => weeklySummary(entries, range, (id) => names.get(id) ?? null), [entries, range, names])
  const text = label(range.start, offset)
  const max = Math.max(1, ...s.days)

  const copy = () => void navigator.clipboard.writeText(weeklyMarkdown(s, text)).then(onCopied, () => {})
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === '[') setOffset((o) => o - 1)
    else if (e.key === ']') setOffset((o) => Math.min(0, o + 1))
    else if (e.key.toLowerCase() === 'c' && e.metaKey && e.shiftKey) {
      e.preventDefault()
      copy()
    }
  }

  return (
    <Modal role="dialog" labelledBy="weekly-title" className="weekly-panel" onCancel={onClose}>
      <div onKeyDown={onKeyDown} tabIndex={-1} data-testid="weekly-panel" style={{ display: 'contents' }}>
        <div className="weekly-head">
          <button type="button" className="button" aria-label="앞 주" onClick={() => setOffset((o) => o - 1)} autoFocus>
            ‹
          </button>
          <h2 id="weekly-title" data-testid="weekly-label">
            {text}
          </h2>
          <button type="button" className="button" aria-label="다음 주" disabled={offset === 0} onClick={() => setOffset((o) => Math.min(0, o + 1))}>
            ›
          </button>
          <button type="button" className="button" onClick={copy} data-testid="weekly-copy">
            마크다운으로 복사 <kbd>⇧⌘C</kbd>
          </button>
        </div>
        {s.insight && <p className="weekly-insight">✗ {s.insight}</p>}
        <div className="weekly-kpis">
          {(
            [
              ['다룬 일감', String(s.tasks)],
              ['터미널 시간', hours(s.ms)],
              ['명령', String(s.commands)],
              ['실패', String(s.failed)],
            ] as const
          ).map(([k, v]) => (
            <div key={k} className="weekly-kpi" data-testid="weekly-kpi" data-kpi={k}>
              <b>{v}</b>
              <span>{k}</span>
            </div>
          ))}
        </div>
        <div className="weekly-days" aria-label={`요일별 명령이 돌던 시간: ${s.days.map((d, i) => `${DOW[i]} ${hours(d)}`).join(', ')}`}>
          {s.days.map((d, i) => (
            <div key={i} className="weekly-day">
              <i style={{ height: `${Math.round((d / max) * 70)}px` }} />
              {DOW[i]}
            </div>
          ))}
        </div>
        {s.commands === 0 ? (
          <p className="archive-empty">이 주에 끝난 명령 기록이 없어요 — 명령을 돌리면 여기 모여요(기록은 이 Mac 에만 90일).</p>
        ) : (
          <table className="weekly-table" data-testid="weekly-table">
            <thead>
              <tr>
                <th>일감</th>
                <th className="num">시간</th>
                <th className="num">명령</th>
                <th className="num">실패</th>
                <th>마지막 상태</th>
              </tr>
            </thead>
            <tbody>
              {s.rows.map((r) => {
                const t = tasks.find((x) => x.id === r.taskId)
                return (
                  <tr key={r.taskId}>
                    <td>{r.name}</td>
                    <td className="num">{hours(r.ms)}</td>
                    <td className="num">{r.commands}</td>
                    <td className={`num${r.failed ? ' fail' : ''}`}>{r.failed}</td>
                    <td>{t?.archivedAt ? '🗄 보관됨' : ''}</td>
                  </tr>
                )
              })}
              {s.rest && (
                <tr>
                  <td>나머지 {s.rest.tasks}개 일감</td>
                  <td className="num">{hours(s.rest.ms)}</td>
                  <td className="num">{s.rest.commands}</td>
                  <td />
                  <td />
                </tr>
              )}
            </tbody>
          </table>
        )}
        <p className="archive-hint">[ ] 주 바꾸기 · 월요일 시작 · AI 토큰은 아직 모아 두지 않아요</p>
      </div>
    </Modal>
  )
}
