// 70단계: 가져온 일감의 '이어 하기' 후보 띠 — 그 폴더에서 하던 Claude · Codex 세션. 누를 때만 53 의 이어 하기로 연다(자동으로 시작하지 않는다).
import { useState } from 'react'
import { AgentIcon } from './AgentIcon'
import { AGENT_NAME } from '../shared/chat'
import { sessionAgo, type ResumeHow } from '../shared/agent-sessions'
import type { SessionHint } from '../shared/types'
import { ipcMessage } from './ipc-message'

interface Props {
  hints: readonly SessionHint[]
  /** 53 resumeAgentSession — 이미 열린 대화면 그리로. 열었거나 옮겼으면 true, 다른 요청이 여는 중이라 안 했으면 false. 실패하면 던진다(탭을 만들기 전) */
  onResume(hint: SessionHint, how: ResumeHow): Promise<boolean>
  /** 이어 한 후보 하나(id) · 닫기(모두) */
  onDrop(id?: string): void
}

export function SessionHintBand({ hints, onResume, onDrop }: Props) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  if (!hints.length) return null
  const now = Date.now()
  const resume = (hint: SessionHint, how: ResumeHow) => {
    if (busy) return
    setBusy(hint.id)
    setError('')
    onResume(hint, how).then(
      (opened) => { setBusy(null); if (opened) onDrop(hint.id); else setError('같은 세션을 다른 곳에서 여는 중이에요 — 끝난 뒤 다시 눌러 주세요.') },
      (e: unknown) => { setBusy(null); setError(ipcMessage(e, '이어 하지 못했어요. 다시 시도해 주세요.')) },
    )
  }
  return (
    <div className="session-hint-band" role="region" aria-label="이 폴더에서 하던 세션" data-testid="session-hints">
      <span className="session-hint-title">이 폴더에서 하던 세션</span>
      <ul className="session-hint-list">
        {hints.map((h) => {
          const label = h.summary || '(첫 글 없음)'
          return (
            <li key={h.id} className="session-hint" data-agent={h.agent}>
              <span className="session-hint-text">
                <AgentIcon agent={h.agent} size={12} />
                <span>{AGENT_NAME[h.agent]} · {label} · {busy === h.id ? '여는 중…' : sessionAgo(h.at, now)}</span>
              </span>
              <button type="button" className="button small" disabled={busy !== null} aria-label={`대화로 이어 하기: ${label}`} onClick={() => resume(h, 'chat')}>대화로 이어 하기</button>
              <button type="button" className="button small" disabled={busy !== null} aria-label={`터미널로 이어 하기: ${label}`} onClick={() => resume(h, 'terminal')}>터미널로</button>
            </li>
          )
        })}
      </ul>
      {error && <span role="alert" className="session-hint-error">{error}</span>}
      <button type="button" className="button small" disabled={busy !== null} aria-label="이어 하기 후보 닫기" onClick={() => onDrop()}>닫기</button>
    </div>
  )
}
