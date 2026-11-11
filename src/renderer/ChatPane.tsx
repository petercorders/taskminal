// 대화 pane (21단계) — Claude 와 채팅. 도구는 한 줄로 접고, 허락 · 질문은 카드에서 바로 답한다. 보드 'Chat'.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { ActivityEvent } from '../shared/activity'
import { CHAT_PERMISSIONS, chatStatus, foldBlocks, isChatEvent, type ChatBlock, type ChatDecision, type ChatEvent, type ChatPermission } from '../shared/chat'

interface Props {
  paneId: string
  cwd: string
  sessionId: string | undefined
  /** 보이는 탭의 포커스 pane */
  active: boolean
  visible: boolean
  focusSignal: number
  permission: ChatPermission
  onPermission(p: ChatPermission): void
  /** init 의 session_id — pane 에 저장해 재시작 뒤 --resume */
  onSession(id: string): void
  /** ⇧⌘J · 실패 띠 '터미널로 열기' */
  onToTerminal(): void
  /** 로그인 띠 — 같은 폴더 새 탭에서 claude (사용자가 /login) */
  onOpenLogin(): void
  onActivity(ev: ActivityEvent): void
}

const EXAMPLES = ['최근 실패한 시험 고치기', '이 폴더가 무엇인지 설명해 줘', '시험 돌리고 결과 알려 줘']
const ANSWER_LABEL: Record<string, string> = { allow: '허락함', always: '늘 허락함', deny: '거절함', answer: '답함', lost: '응답 없이 끝남' }

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}초`
  return `${Math.floor(s / 60)}분 ${s % 60}초`
}
function clock(ms: number): string {
  const d = new Date(ms)
  return `${d.getHours()}시 ${String(d.getMinutes()).padStart(2, '0')}분`
}

export function ChatPane(p: Props) {
  const [events, setEvents] = useState<ChatEvent[]>([])
  const [loaded, setLoaded] = useState(false)
  const [text, setText] = useState('')
  const [hint, setHint] = useState<string | null>(null)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [picks, setPicks] = useState<Record<string, number[]>>({})
  const [now, setNow] = useState(() => Date.now())
  const [permMenu, setPermMenu] = useState(false)
  /** 마지막 보낸 원문 — 다시 시도는 이것을(디스크의 가린 글이 아니라) 보낸다. 재시작 뒤에는 없다 */
  const lastSent = useRef<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const cb = useRef(p)
  cb.current = p

  // 기록 + 실시간: 번호가 upTo 보다 큰 실시간 이벤트만 붙인다(겹침 · 빠짐 없이)
  useEffect(() => {
    let alive = true
    let upTo: number | null = null
    const early: { ev: ChatEvent; n: number }[] = []
    const take = (ev: ChatEvent) => {
      setEvents((xs) => [...xs, ev])
      if (ev.t === 'session') cb.current.onSession(ev.id)
      const act = activityOf(ev)
      if (act) cb.current.onActivity(act)
    }
    const off = window.taskminal.chat.onEvent((paneId, ev, n) => {
      if (paneId !== p.paneId || !isChatEvent(ev) || typeof n !== 'number') return
      if (upTo === null) early.push({ ev, n })
      else if (n > upTo) take(ev)
    })
    void window.taskminal.chat.history(p.paneId).then(
      (h) => {
        if (!alive) return
        upTo = h.upTo
        setEvents(h.events.filter(isChatEvent))
        setLoaded(true)
        for (const e of early) if (e.n > h.upTo) take(e.ev)
      },
      () => {
        upTo = 0
        setLoaded(true)
      },
    )
    return () => {
      alive = false
      off()
    }
  }, [p.paneId])

  const status = useMemo(() => chatStatus(events), [events])
  const blocks = useMemo(() => foldBlocks(events), [events])
  const running = status.state === 'run' || status.state === 'wait'
  const pending = blocks.find((b): b is Extract<ChatBlock, { kind: 'permission' | 'question' }> => (b.kind === 'permission' || b.kind === 'question') && b.answer === null)

  useEffect(() => {
    if (status.state !== 'run' && status.state !== 'wait') return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [status.state])
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [blocks.length, events.length])
  useEffect(() => {
    if (p.active && p.visible && !document.querySelector('[aria-modal="true"]')) inputRef.current?.focus()
  }, [p.active, p.visible, p.focusSignal])

  const send = async (raw: string) => {
    const body = raw.trim()
    if (!body) return
    if (running) {
      setHint('끝나면 보낼 수 있어요 · ⌘. 멈춤')
      return
    }
    setHint(null)
    lastSent.current = body
    setText('')
    cb.current.onActivity({ type: 'command', text: body.split('\n')[0]!.slice(0, 200) })
    cb.current.onActivity({ type: 'start' })
    const r = await window.taskminal.chat.send(p.paneId, body, p.cwd, p.sessionId).catch(() => 'busy' as const)
    if (r === 'busy') {
      setText((t) => t || body)
      setHint('끝나면 보낼 수 있어요 · ⌘. 멈춤')
    }
  }
  const answer = (id: string, d: ChatDecision) => {
    window.taskminal.chat.answer(p.paneId, id, d)
    inputRef.current?.focus()
  }
  const deny = (id: string) => {
    answer(id, { how: 'deny', ...(text.trim() ? { message: text.trim() } : {}) })
    setText('')
  }
  const submitQuestion = (b: Extract<ChatBlock, { kind: 'question' }>) => {
    const own = text.trim()
    const answers: Record<string, string> = {}
    b.questions.forEach((q, qi) => {
      const sel = picks[b.id]?.[qi] ?? 0
      answers[q.question] = qi === 0 && own ? own : (q.options[sel]?.label ?? own)
    })
    if (own) setText('')
    answer(b.id, { how: 'answer', answers })
  }

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return
    if (e.metaKey && e.key === '.') {
      e.preventDefault()
      window.taskminal.chat.interrupt(p.paneId)
      return
    }
    const inInput = e.target === inputRef.current
    if (pending) {
      if (pending.kind === 'permission') {
        if (e.key === 'Enter' && !e.shiftKey && (!inInput || text.trim() === '')) {
          e.preventDefault()
          if (e.altKey) {
            if (!pending.danger) answer(pending.id, { how: 'always' })
          } else answer(pending.id, { how: 'allow' })
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          deny(pending.id)
          return
        }
      } else {
        const n = Number(e.key)
        if (!inInput || text === '') {
          if (n >= 1 && n <= 9 && n <= (pending.questions[0]?.options.length ?? 0)) {
            e.preventDefault()
            setPicks((x) => ({ ...x, [pending.id]: [n - 1, ...(x[pending.id] ?? []).slice(1)] }))
            return
          }
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          submitQuestion(pending)
          return
        }
      }
    }
    if (inInput && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send(text)
    }
  }

  const statusChip = (() => {
    switch (status.state) {
      case 'new':
        return { text: '○ 새 대화', cls: 'dim' }
      case 'run':
        return { text: `● 실행 중 · ${duration(now - (status.since ?? now))}`, cls: 'run' }
      case 'wait':
        return { text: `● 입력 기다림 · ${pending?.kind === 'question' ? '질문' : '허락'}`, cls: 'wait' }
      case 'done':
        return { text: `✓ 끝남${status.ms ? ' · ' + duration(status.ms) : ''}`, cls: 'ok' }
      case 'fail':
        return { text: '✕ 실패', cls: 'err' }
      case 'stopped':
        return { text: '■ 멈춤(내가 멈춤)', cls: 'dim' }
    }
  })()
  const permName = CHAT_PERMISSIONS.find((x) => x.id === p.permission)?.name ?? ''
  const lastCtx = [...events].reverse().find((e): e is Extract<ChatEvent, { t: 'turn_end' }> => e.t === 'turn_end' && e.ctxPct !== undefined)?.ctxPct

  const renderBlock = (b: ChatBlock) => {
    switch (b.kind) {
      case 'user':
        return (
          <div key={b.key} className="chat-user" data-testid="chat-block" data-kind="user">
            {b.text}
          </div>
        )
      case 'text':
        return (
          <div key={b.key} className="chat-text" data-testid="chat-block" data-kind="text">
            {b.text}
          </div>
        )
      case 'tools': {
        const isOpen = !!open[b.key]
        const counts = new Map<string, number>()
        for (const i of b.items) counts.set(i.name, (counts.get(i.name) ?? 0) + 1)
        const summary = b.items.length === 1 ? `${b.items[0]!.name} · ${b.items[0]!.summary}` : `도구 ${b.items.length}번 · ${[...counts].map(([n, c]) => `${n} ${c}`).join(' · ')}`
        const st = b.items.some((i) => i.state === 'run') ? ['실행 중', 'run'] : b.items.some((i) => i.state === 'err') ? ['✕ 실패 있음', 'err'] : ['✓ 끝남', 'ok']
        return (
          <div key={b.key} className="chat-tools" data-testid="chat-block" data-kind="tools">
            <button type="button" className="chat-tools-head" aria-expanded={isOpen} onClick={() => setOpen((o) => ({ ...o, [b.key]: !isOpen }))}>
              <span aria-hidden>{isOpen ? '▾' : '▸'}</span>
              <span className="chat-tools-summary">{summary}</span>
              <span className={`chat-tools-state ${st[1]}`}>{st[0]}</span>
            </button>
            {isOpen && (
              <ul className="chat-tools-items">
                {b.items.map((i) => (
                  <li key={i.id} className={i.state} data-testid="chat-tool-item">
                    <span className="chat-tool-name">{i.name}</span> {i.summary}
                    {i.tail && <pre className="chat-tool-tail">{i.tail}</pre>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )
      }
      case 'permission':
        return (
          <div key={b.key} className={`chat-card perm${b.answer ? ' answered' : ''}`} data-testid="perm-card" data-answer={b.answer ?? ''}>
            <div className="chat-card-title">
              허락이 필요해요 <span className="dim">{b.tool}{b.why ? ` · ${b.why}` : ''}</span>
            </div>
            <pre className="chat-card-cmd">{b.summary}</pre>
            {b.answer === null ? (
              <>
                <div className="chat-card-actions">
                  <button type="button" className="primary" onClick={() => answer(b.id, { how: 'allow' })}>
                    허락 ↩
                  </button>
                  {!b.danger && (
                    <button type="button" onClick={() => answer(b.id, { how: 'always' })}>
                      이 명령만 늘 허락 ⌥↩
                    </button>
                  )}
                  <button type="button" onClick={() => deny(b.id)}>
                    거절하고 다른 방법 말하기 Esc
                  </button>
                </div>
                {b.danger && <div className="chat-card-note">작업 폴더 밖 · rm · push --force 는 &quot;늘 허락&quot; 을 보이지 않아요. 입력창에 쓴 글은 거절 이유로 가요.</div>}
              </>
            ) : (
              <div className="chat-card-done">{ANSWER_LABEL[b.answer]}</div>
            )}
          </div>
        )
      case 'question':
        return (
          <div key={b.key} className={`chat-card ask${b.answer ? ' answered' : ''}`} data-testid="ask-card" data-answer={b.answer ?? ''}>
            {b.questions.map((q, qi) => (
              <div key={qi} className="chat-ask">
                <div className="chat-card-title">{q.question}</div>
                <div className="chat-ask-options" role="radiogroup" aria-label={q.question}>
                  {q.options.map((o, oi) => {
                    const on = (picks[b.id]?.[qi] ?? 0) === oi
                    return (
                      <button
                        key={oi}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        disabled={b.answer !== null}
                        className={`chat-ask-option${on ? ' on' : ''}`}
                        onClick={() =>
                          setPicks((x) => {
                            const cur = [...(x[b.id] ?? [])]
                            cur[qi] = oi
                            return { ...x, [b.id]: cur }
                          })
                        }
                      >
                        <span className="chat-ask-key">{oi + 1}</span> {o.label}
                        {o.description && <span className="dim"> {o.description}</span>}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
            {b.answer === null ? (
              <div className="chat-card-actions">
                <span className="dim">1~{Math.min(9, b.questions[0]?.options.length ?? 0)} 고르기 · ↩ 보내기 · 직접 써도 돼요</span>
                <button type="button" className="primary" onClick={() => submitQuestion(b)}>
                  보내기 ↩
                </button>
              </div>
            ) : (
              <div className="chat-card-done">{ANSWER_LABEL[b.answer]}</div>
            )}
          </div>
        )
      case 'band':
        return <Band key={b.key} b={b} onRetry={() => lastSent.current && void send(lastSent.current)} canRetry={lastSent.current !== null} onToTerminal={p.onToTerminal} onOpenLogin={p.onOpenLogin} />
      case 'done':
        return (
          <div key={b.key} className="chat-done" data-testid="chat-block" data-kind="done">
            ✓ 끝남 · {duration(b.ms)}
          </div>
        )
      case 'stopped':
        return (
          <div key={b.key} className="chat-stopped" data-testid="chat-block" data-kind="stopped">
            ■ 멈춤(내가 멈춤)
          </div>
        )
    }
  }

  return (
    <div className="chat-pane" data-testid="chat-pane" data-pane-id={p.paneId} data-state={status.state} onKeyDown={onKey}>
      <header className="chat-head">
        <span className="chat-agent">Claude</span>
        <span className="chat-where" title={p.cwd}>
          {p.cwd}
        </span>
        {p.permission === 'auto' && <span className="chat-auto">자동</span>}
        <span className={`chat-status ${statusChip.cls}`} data-testid="chat-status">
          {statusChip.text}
        </span>
        <button type="button" className="chat-switch" onClick={p.onToTerminal} title="같은 세션을 터미널로 (⇧⌘J)">
          터미널 ⇧⌘J
        </button>
      </header>
      <div className="chat-list" ref={listRef}>
        {loaded && events.length === 0 && (
          <div className="chat-empty" data-testid="chat-empty">
            <div className="chat-empty-title">Claude 와 대화를 시작해요</div>
            <div className="dim">이 일감 폴더({p.cwd})에서 일해요. 예시를 눌러도 돼요.</div>
            <div className="chat-examples">
              {EXAMPLES.map((x, i) => (
                <button key={x} type="button" onClick={() => void send(x)}>
                  <span className="chat-ask-key">{i + 1}</span> {x}
                </button>
              ))}
            </div>
            <div className="dim small">⌘P › 새 대화 (Claude) 로도 열 수 있어요 · 터미널 단추로 같은 세션을 TUI 로</div>
          </div>
        )}
        {blocks.map(renderBlock)}
      </div>
      <footer className="chat-input-box">
        {hint && (
          <div className="chat-hint" data-testid="chat-hint">
            {hint}
          </div>
        )}
        <textarea
          ref={inputRef}
          className="chat-input"
          data-testid="chat-input"
          aria-label="대화 입력"
          rows={2}
          value={text}
          placeholder={pending ? (pending.kind === 'question' ? '카드에서 고르거나 직접 써도 돼요' : '허락하거나, 다른 방법을 말해 주세요') : running ? '도는 중이에요 · 끝나면 보낼 수 있어요 (⌘. 멈춤)' : '무엇을 할까요?'}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="chat-input-row">
          <span className="chat-perm-wrap">
            <button type="button" className={`chat-perm${p.permission === 'auto' ? ' auto' : ''}`} data-testid="chat-perm" aria-haspopup="menu" aria-expanded={permMenu} onClick={() => setPermMenu((v) => !v)}>
              허락: {permName} ▾
            </button>
            {p.permission !== 'ask' && <span className="dim small"> · 저장됨</span>}
            {permMenu && (
              <span className="chat-perm-menu" role="menu">
                {CHAT_PERMISSIONS.map((x) => (
                  <button
                    key={x.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={x.id === p.permission}
                    onClick={() => {
                      setPermMenu(false)
                      p.onPermission(x.id)
                      inputRef.current?.focus()
                    }}
                  >
                    {x.name}
                  </button>
                ))}
              </span>
            )}
          </span>
          {lastCtx !== undefined && <span className={`chat-ctx${lastCtx >= 90 ? ' warn' : ''}`}>대화 창 {lastCtx}%{lastCtx >= 90 ? ' · /compact 로 줄이기' : ''}</span>}
          <span className="dim small chat-keys">↩ 보내기 · ⇧↩ 줄바꿈 · ⌘. 멈춤</span>
          {running ? (
            <button type="button" className="chat-send stop" onClick={() => window.taskminal.chat.interrupt(p.paneId)}>
              멈춤 ⌘.
            </button>
          ) : (
            <button type="button" className="chat-send" data-testid="chat-send" disabled={!text.trim()} onClick={() => void send(text)}>
              보내기 ↩
            </button>
          )}
        </div>
      </footer>
    </div>
  )
}

function Band({ b, onRetry, canRetry, onToTerminal, onOpenLogin }: { b: Extract<ChatBlock, { kind: 'band' }>; onRetry(): void; canRetry: boolean; onToTerminal(): void; onOpenLogin(): void }) {
  let title: string
  let body: string
  let actions: { label: string; run(): void }[] = []
  switch (b.error) {
    case 'login':
      title = 'Claude 에 로그인되어 있지 않아요'
      body = '터미널에서 claude 를 열어 /login 해 주세요. 로그인하면 이 대화를 바로 이어 써요.'
      actions = [{ label: '터미널 열기', run: onOpenLogin }, ...(canRetry ? [{ label: '다시 시도', run: onRetry }] : [])]
      break
    case 'missing':
      title = 'claude 명령을 찾지 못했어요'
      body = 'Claude Code 를 설치하면 대화를 쓸 수 있어요. 설치한 뒤 다시 시도하면 다시 찾아요.'
      actions = [
        { label: '설치 명령 복사', run: () => void navigator.clipboard.writeText('npm install -g @anthropic-ai/claude-code') },
        ...(canRetry ? [{ label: '다시 시도', run: onRetry }] : []),
      ]
      break
    case 'limit':
      title = `사용 한도를 다 썼어요${b.resetsAt ? ` · ${clock(b.resetsAt)}에 풀려요` : ''}`
      body = '풀리면 다시 시도해 주세요.'
      actions = canRetry ? [{ label: '다시 시도', run: onRetry }] : []
      break
    default: {
      title = `작업이 실패했어요${b.ms ? ` · ${duration(b.ms)}` : ''}`
      const code = b.code !== undefined ? ` (종료 코드 ${b.code})` : b.message ? ` (${b.message})` : ''
      body = `${b.error === 'crash' ? 'Claude 가 갑자기 끝났어요. ' : ''}지금까지의 대화와 파일은 그대로예요. 다시 시도해도 같으면 터미널로 열어 보세요.${code}`
      if (b.error === 'crash' && canRetry) body += ' 보낸 글이 이미 들어갔으면 두 번 보일 수 있어요.'
      actions = [...(canRetry ? [{ label: '다시 시도', run: onRetry }] : []), { label: '터미널로 열기 ⇧⌘J', run: onToTerminal }]
    }
  }
  return (
    <div className={`chat-band ${b.tone}`} data-testid="chat-band" data-error={b.error}>
      <div className="chat-card-title">{title}</div>
      <div className="chat-band-body">{body}</div>
      <div className="chat-card-actions">
        {actions.map((a, i) => (
          <button key={a.label} type="button" className={i === 0 ? 'primary' : ''} onClick={a.run}>
            {a.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/** 대화 이벤트 → pane 활동(사이드바 · 확인 필요 · 알림이 터미널과 같은 말을 쓰게) */
function activityOf(ev: ChatEvent): ActivityEvent | null {
  switch (ev.t) {
    case 'permission':
      return { type: 'notify', text: `허락이 필요해요 · ${ev.tool}` }
    case 'question':
      return { type: 'notify', text: '질문에 답해 주세요' }
    case 'answered':
      return { type: 'start' }
    case 'turn_end':
      return { type: 'end', code: ev.ok ? 0 : 1 }
    case 'error':
      return { type: 'end', code: 1 }
    case 'stopped':
      return { type: 'end', code: null }
    default:
      return null
  }
}
