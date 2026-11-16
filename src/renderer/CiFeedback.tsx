// 54단계: PR 카드 아래 실패 체크(로그 끝) · 리뷰 의견 — 고른 것을 이 일감의 대화 입력칸 초안으로(보내지 않는다)
import { useCallback, useEffect, useRef, useState } from 'react'
import { LOG_STATE_TEXT, feedbackDraft, type PrFeedback } from '../shared/ci-feedback'
import type { GitTarget, GitWorkflowApi, PullRequestView } from '../shared/git-workflow'
import { usageAgo } from '../shared/usage'

interface Props {
  api: GitWorkflowApi
  dir: string
  target: GitTarget
  pr: PullRequestView
  onSend?(text: string): void
  onOpenUrl?(url: string): void
}

export function CiFeedback({ api, dir, target, pr, onSend, onOpenUrl }: Props) {
  const [data, setData] = useState<PrFeedback | null>(null)
  const [reading, setReading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  // 끈 항목만 기억한다 — 다시 읽어 새로 생긴 항목은 고른 채로 온다
  const [off, setOff] = useState<ReadonlySet<string>>(() => new Set())
  const [sent, setSent] = useState(false)
  const sentRef = useRef(false)
  const seq = useRef(0)
  const mounted = useRef(true)
  const latest = useRef({ target, pr })
  latest.current = { target, pr }
  const read = useCallback(async () => {
    const id = ++seq.current
    const { target: t, pr: p } = latest.current
    setReading(true)
    setError(null)
    try {
      const r = await api.feedback(dir, { target: t, number: p.number, head: p.head })
      if (!mounted.current || id !== seq.current) return // 늦게 온 옛 응답(앞 커밋 · 닫은 화면)은 버린다
      if (r.state === 'ok') setData(r)
      else setError(r.message)
    } catch {
      if (mounted.current && id === seq.current) setError('응답을 받지 못했어요. 다시 시도해 주세요.')
    } finally {
      if (mounted.current && id === seq.current) {
        setReading(false)
        setNow(Date.now())
      }
    }
  }, [api, dir])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      seq.current++
    }
  }, [])
  // 처음 · PR 커밋이 바뀔 때 읽는다(패널 '다시 읽기' 가 새 커밋을 보이면 따라 읽음)
  useEffect(() => {
    void read()
  }, [read, pr.head])

  const items = data ? [...data.checks.map((c) => c.id), ...data.notes.map((n) => n.id)] : []
  const chosen = items.filter((id) => !off.has(id))
  const toggle = (id: string) =>
    setOff((old) => {
      const next = new Set(old)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const send = () => {
    if (sentRef.current || !data || !onSend || chosen.length === 0) return
    sentRef.current = true // 두 번 눌러도 초안은 하나
    setSent(true)
    onSend(feedbackDraft(data, target.repo ?? '', new Set(chosen)).text)
  }
  return (
    <div className="ci-feedback" data-testid="ci-feedback" aria-busy={reading}>
      <div className="ci-feedback-head">
        <strong>체크·리뷰</strong>
        <button type="button" className="button small" disabled={reading} onClick={() => void read()}>
          {error ? '다시 시도' : '체크·리뷰 다시 읽기'}
        </button>
      </div>
      {reading && <div role="status" className="dim small">체크·리뷰 읽는 중…</div>}
      {error && <div role="alert" className="small">{error}</div>}
      {data && (
        <>
          <div className="dim small" data-testid="ci-feedback-age">
            {usageAgo(data.at, now)} 받은 값 · PR 커밋 {data.head.slice(0, 8)}
            {data.head !== pr.head ? ' (이전 커밋)' : ''}
          </div>
          {items.length === 0 && <p className="dim small">실패한 체크와 리뷰 의견이 없어요.</p>}
          {data.checks.length > 0 && (
            <fieldset className="ci-feedback-group">
              <legend>체크 실패 {data.checks.length}</legend>
              {data.checks.map((c) => (
                <div key={c.id} className="ci-feedback-item">
                  <div className="ci-feedback-row">
                    <label>
                      <input type="checkbox" checked={!off.has(c.id)} onChange={() => toggle(c.id)} />
                      {c.name}
                      {c.workflow ? ` · ${c.workflow}` : ''}
                    </label>
                    {c.url && onOpenUrl && (
                      <button type="button" className="link" aria-label={`${c.name} 체크 열기`} onClick={() => onOpenUrl(c.url!)}>
                        열기
                      </button>
                    )}
                  </div>
                  {c.log ? (
                    <details>
                      <summary>로그 끝 {c.log.split('\n').length}줄</summary>
                      <pre className="ci-feedback-log" tabIndex={0} aria-label={`${c.name} 로그 끝`}>
                        {c.log}
                      </pre>
                    </details>
                  ) : (
                    <div className="dim small">{LOG_STATE_TEXT[c.logState]}</div>
                  )}
                </div>
              ))}
            </fieldset>
          )}
          {data.notes.length > 0 && (
            <fieldset className="ci-feedback-group">
              <legend>
                리뷰 의견 {data.notes.length}
                {data.more > 0 ? ` (오래된 ${data.more}개 생략)` : ''}
              </legend>
              {data.notes.map((n) => (
                <div key={n.id} className="ci-feedback-item">
                  <label>
                    <input type="checkbox" checked={!off.has(n.id)} onChange={() => toggle(n.id)} />
                    {n.author}
                    {n.path ? ` · ${n.path}${n.line !== undefined ? `:${n.line}` : ''}` : ''}
                    {n.state === 'CHANGES_REQUESTED' ? ' · 변경 요청' : ''}
                  </label>
                  <p className="ci-feedback-body">{n.body}</p>
                </div>
              ))}
            </fieldset>
          )}
          {data.lineComments === 'error' && <div className="dim small">코드 줄 의견을 읽지 못했어요.</div>}
          {items.length > 0 && (
            <div className="ci-feedback-send">
              <button type="button" className="button" disabled={sent || chosen.length === 0 || !onSend} onClick={send}>
                대화로 보내기 ({chosen.length})
              </button>
              <span className="dim small">이 일감의 대화 입력칸에 넣기만 하고 보내지 않아요.</span>
            </div>
          )}
        </>
      )}
    </div>
  )
}
