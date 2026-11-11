// 대화 pane (21단계) — Claude 와 채팅. 도구는 한 줄로 접고, 허락 · 질문은 카드에서 바로 답한다. 보드 'Chat'.
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react'
import type { ActivityEvent } from '../shared/activity'
import { shortPath } from './sidebar-model'
import {
  AGENT_NAME,
  CHAT_PERMISSIONS,
  IMAGE_MAX_BYTES,
  IMAGE_MAX_COUNT,
  IMAGE_MIMES,
  chatStatus,
  foldBlocks,
  isChatEvent,
  rewindPlan,
  type ChatAgent,
  type ChatBlock,
  type ChatDecision,
  type ChatEvent,
  type ChatImage,
  type ChatPermission,
} from '../shared/chat'

interface Props {
  paneId: string
  cwd: string
  /** 에이전트 · 이어 할 세션 · 아직 안 보낸 갈라질 자리 (22단계) */
  chat: { agent: ChatAgent; sessionId?: string; forkAt?: string }
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
  /** 26단계 ⌘J: 이 대화 아래에 셸을 꺼낸다(있으면 그리로) */
  onShell(): void
  /** 로그인 띠 — 같은 폴더 새 탭에서 claude (사용자가 /login) */
  onOpenLogin(): void
  onActivity(ev: ActivityEvent): void
  /** 되감기 뒤 — 다음 보내기가 forkAt 에서 갈라지게 상태에 남긴다 (null = 새 세션) */
  onRewound(forkAt: string | null, sessionId?: string): void
  /** ⑂ 여기서 새 대화로 나누기 */
  onBranch(index: number, at: number): void
  onToast(text: string, sub?: string): void
  /** 파일을 고친 도구 줄의 'diff 열기 →' — 변경 pane 에서 그 파일 (23단계) */
  onOpenDiff(path: string): void
  /** 변경 pane 의 '대화에 묻기' 가 넣는 글 — n 이 바뀔 때마다 입력칸 끝에 붙인다 */
  draft: { text: string; n: number } | null
  /** 글을 받았다 — App 이 지워 두어야 다시 그려질 때 같은 글을 또 붙이지 않는다(리뷰) */
  onDraftTaken(n: number): void
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
/** 이 도구 묶음이 고친 파일 — 폴더 안 상대 경로만(절대 경로 = 폴더 밖, 변경 pane 에 없다). Codex 는 여러 경로를 ', ' 로 잇는다 */
function editedPaths(items: ReadonlyArray<{ name: string; summary: string; state: string }>): string[] {
  const out = new Set<string>()
  for (const i of items) {
    if (!EDIT_TOOLS.has(i.name) || i.state !== 'ok') continue
    for (const path of i.summary.split(', ')) if (path && !path.startsWith('/') && !path.endsWith('…')) out.add(path)
  }
  return [...out]
}

/** 대기열 한 칸 — 원문 · 그림은 renderer 메모리에만(디스크 · 상태 파일에 쓰지 않는다) */
interface Queued {
  text: string
  images: ChatImage[]
}

const INSTALL: Record<ChatAgent, string> = { claude: 'npm install -g @anthropic-ai/claude-code', codex: 'npm install -g @openai/codex' }

/** File(붙여넣기 · 끌어 놓기) → 그림. 종류 · 크기가 맞지 않으면 null */
function readImage(f: File): Promise<ChatImage | null> {
  if (!(IMAGE_MIMES as readonly string[]).includes(f.type) || f.size > IMAGE_MAX_BYTES) return Promise.resolve(null)
  return new Promise((resolve) => {
    const r = new FileReader()
    r.onload = () => {
      const url = String(r.result)
      const i = url.indexOf(',')
      resolve(i > 0 ? { name: f.name || 'image.png', mime: f.type, data: url.slice(i + 1) } : null)
    }
    r.onerror = () => resolve(null)
    r.readAsDataURL(f)
  })
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
  /** 여러 개 고르기 질문 — 질문마다 켠 선택지 */
  const [multi, setMulti] = useState<Record<string, number[][]>>({})
  const [now, setNow] = useState(() => Date.now())
  const [permMenu, setPermMenu] = useState(false)
  /** 보내기 전에 붙인 그림 */
  const [images, setImages] = useState<ChatImage[]>([])
  const [queue, setQueue] = useState<Queued[]>([])
  /** 턴이 실패 · 멈춤 · 한도로 끝나 대기열을 저절로 보내지 않는다 — [이어 보내기] 로 */
  const [queuePaused, setQueuePaused] = useState(false)
  /** 되감기 확인 띠 */
  const [confirm, setConfirm] = useState<{ index: number; at: number; removed: number } | null>(null)
  /** 마지막 보낸 원문 — 다시 시도는 이것을(디스크의 가린 글이 아니라) 보낸다. 재시작 뒤에는 없다 */
  const lastSent = useRef<Queued | null>(null)
  /** 끝 이벤트(턴 끝 · 멈춤 · 오류)를 어디까지 보고 대기열을 움직였나 — 같은 끝으로 두 번 보내지 않게 */
  const handledEnd = useRef(-1)
  /** ⌘↩ 지금 보내기 — 멈춤을 받으면 대기열 첫 것을 보낸다 */
  const sendNow = useRef(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // 변경 pane 의 '대화에 묻기' · '고쳐 달라고 하기' (23단계) — 보내지 않고 입력칸에만
  useEffect(() => {
    if (!p.draft) return
    const add = p.draft.text
    setText((t) => (t ? `${t.replace(/\s+$/, '')}\n${add}` : add))
    p.onDraftTaken(p.draft.n)
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [p.draft?.n]) // eslint-disable-line react-hooks/exhaustive-deps
  const listRef = useRef<HTMLDivElement>(null)
  const cb = useRef(p)
  cb.current = p
  const agent = p.chat.agent
  const name = AGENT_NAME[agent]

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
    const loadedWith = (xs: ChatEvent[]) => {
      handledEnd.current = xs.length - 1 // 기록에 있던 끝은 대기열을 움직이지 않는다
      setEvents(xs)
      setLoaded(true)
    }
    void window.taskminal.chat.history(p.paneId).then(
      (h) => {
        if (!alive) return
        upTo = h.upTo
        loadedWith(h.events.filter(isChatEvent))
        for (const e of early) if (e.n > h.upTo) take(e.ev)
      },
      () => {
        if (!alive) return
        upTo = 0 // 기록을 못 읽었다 — 그 사이 온 실시간 이벤트는 모두 붙인다
        loadedWith([])
        for (const e of early) take(e.ev)
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
  const model = useMemo(() => [...events].reverse().find((e): e is Extract<ChatEvent, { t: 'session' }> => e.t === 'session' && !!e.model)?.model, [events])

  useEffect(() => {
    if (status.state !== 'run' && status.state !== 'wait') return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [status.state])
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [blocks.length, events.length, confirm])
  useEffect(() => {
    if (p.active && p.visible && !document.querySelector('[aria-modal="true"]')) inputRef.current?.focus()
  }, [p.active, p.visible, p.focusSignal])

  /** 실제로 보낸다 — 실행 중이면(main 이 busy) 대기열 맨 앞으로 되돌린다 */
  const dispatchSend = async (item: Queued) => {
    lastSent.current = item
    setHint(null)
    cb.current.onActivity({ type: 'command', text: item.text.split('\n')[0]!.slice(0, 200) })
    cb.current.onActivity({ type: 'start' })
    const r = await window.taskminal.chat.send(p.paneId, item.text, p.cwd, cb.current.chat, item.images).catch(() => 'rejected' as const)
    if (r === 'busy') {
      setQueue((q) => [item, ...q])
      setHint('끝나면 보낼게요 · 대기열에 넣었어요')
    } else if (r === 'rejected') {
      // main 이 거절했다(붙일 수 없는 그림 등) — 끝 이벤트가 오지 않으니 대기열에 두면 영영 안 간다(리뷰). 입력창에 되돌린다
      cb.current.onActivity({ type: 'end', code: null }) // 위에서 연 '시작' 을 닫는다
      lastSent.current = null
      setText((t) => (t ? `${item.text}\n${t}` : item.text))
      setImages([])
      setHint('보내지 못했어요 · 그림을 빼고 다시 보내 주세요')
    }
  }
  // 대기열을 손으로 비웠으면 멈춤도 푼다 — 남겨 두면 다음 대기열이 저절로 가지 않는다(리뷰)
  useEffect(() => {
    if (queue.length === 0) setQueuePaused(false)
  }, [queue.length])

  // 대기열: 턴이 잘 끝나면 다음 것을 저절로, 실패 · 멈춤이면 멈춰 둔다. ⌘↩ 은 멈춤을 받은 뒤 보낸다
  useEffect(() => {
    let last = -1
    for (let i = events.length - 1; i > handledEnd.current; i--) {
      const t = events[i]!.t
      if (t === 'turn_end' || t === 'stopped' || t === 'error') {
        last = i
        break
      }
    }
    if (last < 0) return
    handledEnd.current = last
    const ev = events[last]!
    const wantNow = sendNow.current
    sendNow.current = false
    if (queue.length === 0) return
    if ((ev.t === 'turn_end' && ev.ok && !queuePaused) || (ev.t === 'stopped' && wantNow)) {
      const [first, ...rest] = queue
      setQueue(rest)
      setQueuePaused(false)
      void dispatchSend(first!)
    } else {
      setQueuePaused(true)
    }
  }, [events]) // 끝 이벤트가 더해질 때만 — 대기열 · 멈춤 표시는 그 순간의 값을 읽는다

  const takeInput = (): Queued | null => {
    const body = text.trim()
    if (!body) return null
    const item = { text: body, images }
    setText('')
    setImages([])
    return item
  }
  const send = (raw?: string) => {
    const item = raw !== undefined ? { text: raw.trim(), images: [] } : takeInput()
    if (!item || !item.text) return
    if (running || queue.length > 0) {
      // 도는 동안 · 대기열이 있으면 순서를 지켜 뒤에 선다
      setQueue((q) => [...q, item])
      if (!running && queuePaused) setHint('대기열이 멈춰 있어요 · [이어 보내기] 로 보냅니다')
      return
    }
    void dispatchSend(item)
  }
  /** ⌘↩ 지금 보내기 — 입력창 글을 대기열 맨 앞에 두고, 도는 중이면 멈춘 뒤 보낸다 */
  const sendNowKey = () => {
    const item = takeInput()
    if (!running) {
      const q = item ? [item, ...queue] : queue
      const [first, ...rest] = q
      if (!first) return
      setQueue(rest)
      setQueuePaused(false)
      void dispatchSend(first)
      return
    }
    if (item) setQueue((q) => [item, ...q])
    if (!item && queue.length === 0) return
    sendNow.current = true
    window.taskminal.chat.interrupt(p.paneId)
  }
  const resumeQueue = () => {
    const [first, ...rest] = queue
    if (!first || running) return
    setQueue(rest)
    setQueuePaused(false)
    void dispatchSend(first)
  }
  const answer = (id: string, d: ChatDecision) => {
    window.taskminal.chat.answer(p.paneId, id, d)
    inputRef.current?.focus()
  }
  const deny = (id: string) => {
    const reason = text.trim()
    answer(id, { how: 'deny', ...(reason ? { message: reason } : {}) })
    setText('')
    // Codex 승인 답에는 글 칸이 없다 — 거절 이유는 이 턴이 끝난 뒤 다음 턴으로 보낸다
    if (agent === 'codex' && reason) setQueue((q) => [{ text: reason, images: [] }, ...q])
  }
  const submitQuestion = (b: Extract<ChatBlock, { kind: 'question' }>) => {
    const own = text.trim()
    const answers: Record<string, string | string[]> = {}
    b.questions.forEach((q, qi) => {
      if (qi === 0 && own) answers[q.question] = own
      else if (q.multi) answers[q.question] = (multi[b.id]?.[qi] ?? []).map((i) => q.options[i]?.label ?? '').filter(Boolean)
      else answers[q.question] = q.options[picks[b.id]?.[qi] ?? 0]?.label ?? own
    })
    if (own) setText('')
    answer(b.id, { how: 'answer', answers })
  }
  const pickOption = (b: Extract<ChatBlock, { kind: 'question' }>, qi: number, oi: number) => {
    if (b.questions[qi]?.multi) {
      setMulti((x) => {
        const all = [...(x[b.id] ?? [])]
        const cur = all[qi] ?? []
        all[qi] = cur.includes(oi) ? cur.filter((i) => i !== oi) : [...cur, oi].sort((a, c) => a - c)
        return { ...x, [b.id]: all }
      })
    } else {
      setPicks((x) => {
        const cur = [...(x[b.id] ?? [])]
        cur[qi] = oi
        return { ...x, [b.id]: cur }
      })
    }
  }

  // ─── 그림 (22단계) ───
  const addImages = (more: ChatImage[], skipped: number) => {
    setImages((cur) => {
      const room = Math.max(0, IMAGE_MAX_COUNT - cur.length)
      const over = more.length - room
      if (skipped > 0 || over > 0) cb.current.onToast(`그림 ${skipped + Math.max(0, over)}개는 붙이지 않았어요.`, `한 번에 ${IMAGE_MAX_COUNT}장 · 장마다 5MB · PNG · JPEG · GIF · WebP 만 붙일 수 있어요.`)
      return [...cur, ...more.slice(0, room)]
    })
  }
  const addFiles = async (files: File[]) => {
    const got = await Promise.all(files.map(readImage))
    addImages(got.filter((x): x is ChatImage => x !== null), got.filter((x) => x === null).length)
  }
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.items].filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile()).filter((f): f is File => f !== null)
    if (files.length === 0) return
    e.preventDefault()
    void addFiles(files)
  }
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'))
    if (files.length === 0) return
    e.preventDefault()
    void addFiles(files)
  }
  const pickImages = async () => {
    const r = await window.taskminal.chat.pickImages().catch(() => ({ images: [], skipped: [] }))
    addImages(r.images, r.skipped.length)
    inputRef.current?.focus()
  }

  // ─── 되감기 · 나누기 (22단계) ───
  const askRewind = (b: Extract<ChatBlock, { kind: 'user' }>) => {
    const plan = rewindPlan(events, b.index, 'rewind')
    if (!plan || running) return
    setConfirm({ index: b.index, at: b.at, removed: plan.removed })
  }
  const doRewind = async () => {
    const c = confirm
    setConfirm(null)
    if (!c) return
    const r = await window.taskminal.chat.rewind(p.paneId, c.index, c.at, cb.current.chat).catch(() => null)
    if (!r) return cb.current.onToast('되감지 못했어요.', '그 사이 대화가 바뀌었거나 아직 도는 중이에요.')
    handledEnd.current = r.events.length - 1
    setEvents(r.events.filter(isChatEvent))
    lastSent.current = null
    cb.current.onRewound(r.forkAt, r.sessionId)
    if (r.refill !== null) setText((t) => t || r.refill!)
    else if (r.masked) setHint('가린 글이 있어 입력창에 다시 넣지 않았어요')
    inputRef.current?.focus()
  }

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return
    if (e.metaKey && e.key === '.') {
      e.preventDefault()
      window.taskminal.chat.interrupt(p.paneId)
      return
    }
    if (confirm) {
      if (e.key === 'Escape') {
        e.preventDefault()
        setConfirm(null)
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        void doRewind()
        return
      }
    }
    const inInput = e.target === inputRef.current
    if (inInput && e.metaKey && e.key === 'Enter') {
      e.preventDefault()
      sendNowKey()
      return
    }
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
            pickOption(pending, 0, n - 1)
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
      send()
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
      case 'user': {
        const canBranch = !running && rewindPlan(events, b.index, 'branch') !== null
        // 앞 턴이 멈춤 · 실패로 끝났으면 되감을 자리가 없다 — 단추를 숨긴다
        const canRewind = !running && rewindPlan(events, b.index, 'rewind') !== null
        return (
          <div key={b.key} className="chat-user" data-testid="chat-block" data-kind="user">
            <span data-testid="chat-user-text">{b.text}</span>
            {b.images.length > 0 && (
              <div className="chat-user-images" data-testid="chat-user-images">
                {b.images.map((n, i) => (
                  <span key={i} className="chat-image-chip">
                    🖼 {n}
                  </span>
                ))}
              </div>
            )}
            {(canRewind || canBranch) && (
              <span className="chat-user-actions">
                {canRewind && (
                  <button type="button" data-testid="chat-rewind" onClick={() => askRewind(b)} title="이 메시지 앞으로 대화를 되돌려요 · 파일은 그대로">
                    ↶ 여기로 되감기
                  </button>
                )}
                {canBranch && (
                  <button type="button" data-testid="chat-branch" onClick={() => p.onBranch(b.index, b.at)} title="이 메시지의 답까지 가진 새 대화를 오른쪽에">
                    ⑂ 여기서 새 대화로 나누기
                  </button>
                )}
              </span>
            )}
          </div>
        )
      }
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
            {st[1] !== 'run' &&
              editedPaths(b.items).map((path) => (
                <div key={path} className="chat-diff-card" data-testid="chat-diff-card">
                  <span className="chat-diff-path">{path}</span>
                  <button type="button" onClick={() => p.onOpenDiff(path)}>
                    diff 열기 →
                  </button>
                </div>
              ))}
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
                {q.multi && <div className="dim small">여러 개 고를 수 있어요</div>}
                <div className="chat-ask-options" role={q.multi ? 'group' : 'radiogroup'} aria-label={q.question}>
                  {q.options.map((o, oi) => {
                    const on = q.multi ? (multi[b.id]?.[qi] ?? []).includes(oi) : (picks[b.id]?.[qi] ?? 0) === oi
                    return (
                      <button
                        key={oi}
                        type="button"
                        role={q.multi ? 'checkbox' : 'radio'}
                        aria-checked={on}
                        disabled={b.answer !== null}
                        className={`chat-ask-option${on ? ' on' : ''}`}
                        onClick={() => pickOption(b, qi, oi)}
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
                <span className="dim">
                  1~{Math.min(9, b.questions[0]?.options.length ?? 0)} {b.questions[0]?.multi ? '켜고 끄기' : '고르기'} · ↩ 보내기 · 직접 써도 돼요
                </span>
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
        return (
          <Band
            key={b.key}
            b={b}
            agent={agent}
            onRetry={() => lastSent.current && !running && void dispatchSend(lastSent.current)}
            canRetry={lastSent.current !== null}
            onToTerminal={p.onToTerminal}
            onOpenLogin={p.onOpenLogin}
          />
        )
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
    <div
      className="chat-pane"
      data-testid="chat-pane"
      data-pane-id={p.paneId}
      data-agent={agent}
      data-state={status.state}
      onKeyDown={onKey}
      onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()}
      onDrop={onDrop}
    >
      <header className="chat-head">
        <span className={`chat-agent ${agent}`} data-testid="chat-agent">
          {name}
        </span>
        <span className="chat-where" title={p.cwd}>
          {shortPath(p.cwd)}
        </span>
        {p.permission === 'auto' && <span className="chat-auto">자동</span>}
        <span className={`chat-status ${statusChip.cls}`} data-testid="chat-status">
          {statusChip.text}
        </span>
        <button type="button" className="chat-switch" onClick={p.onShell} title="이 일감 폴더의 셸을 대화 아래에 꺼내요 (⌘J)" data-testid="chat-shell">
          셸 ⌘J
        </button>
        {/* 27단계: '셸' 과 '터미널' 이 같은 뜻으로 읽혀 — 이쪽은 이 대화를 터미널 화면(TUI)으로 바꾸는 것 */}
        <button type="button" className="chat-switch" onClick={p.onToTerminal} title="이 대화를 같은 세션 그대로 터미널 화면(TUI)으로 바꿔요 (⇧⌘J)" data-testid="chat-to-tui">
          TUI 로 ⇧⌘J
        </button>
      </header>
      <div className="chat-list" ref={listRef}>
        {loaded && events.length === 0 && (
          <div className="chat-empty" data-testid="chat-empty">
            <div className="chat-empty-title">{name} 와 대화를 시작해요</div>
            <div className="dim" title={p.cwd}>
              이 일감 폴더(<code>{shortPath(p.cwd)}</code>)에서 일해요. 예시를 눌러도 돼요.
            </div>
            <div className="chat-examples">
              {EXAMPLES.map((x, i) => (
                <button key={x} type="button" onClick={() => send(x)}>
                  <span className="chat-ask-key">{i + 1}</span> {x}
                </button>
              ))}
            </div>
            <div className="dim small">⌘J 셸 · ⌘V 로 그림 붙이기 · ‘TUI 로’ 단추로 같은 대화를 터미널 화면에서</div>
          </div>
        )}
        {blocks.map(renderBlock)}
        {confirm && (
          <div className="chat-band acc" data-testid="rewind-confirm">
            <div className="chat-card-title">여기로 되돌릴까요?</div>
            <div className="chat-band-body">
              이후 메시지 {confirm.removed}개가 대화에서 사라져요. 파일은 그대로예요 — 바뀐 파일은 git 으로 되돌려 주세요.
              {'\n'}되감은 내 메시지는 입력창에 다시 넣어 드려요. 앞 대화는 그대로 두고 그 자리에서 갈라진 새 세션으로 이어 가요.
            </div>
            <div className="chat-card-actions">
              <button type="button" className="primary" onClick={() => void doRewind()}>
                되돌리기 ↩
              </button>
              <button type="button" onClick={() => setConfirm(null)}>
                닫기 Esc
              </button>
            </div>
          </div>
        )}
      </div>
      <footer className="chat-input-box">
        {hint && (
          <div className="chat-hint" data-testid="chat-hint">
            {hint}
          </div>
        )}
        {queue.length > 0 && (
          <div className={`chat-queue${queuePaused ? ' paused' : ''}`} data-testid="chat-queue">
            <span className="chat-queue-label">
              대기 {queue.length}
              {queuePaused ? ' · 멈춤' : ''}
            </span>
            <span className="chat-queue-text" title={queue[0]!.text}>
              {queue[0]!.text.split('\n')[0]}
              {queue[0]!.images.length > 0 ? ` · 🖼 ${queue[0]!.images.length}` : ''}
            </span>
            <button
              type="button"
              onClick={() => {
                const [first, ...rest] = queue
                setQueue(rest)
                if (first) {
                  setText((t) => (t ? `${first.text}\n${t}` : first.text))
                  setImages((im) => [...first.images, ...im].slice(0, IMAGE_MAX_COUNT))
                }
                inputRef.current?.focus()
              }}
            >
              고치기
            </button>
            <button type="button" aria-label="대기열에서 빼기" onClick={() => setQueue((q) => q.slice(1))}>
              ×
            </button>
            {queuePaused && !running ? (
              <button type="button" className="primary" data-testid="chat-queue-resume" onClick={resumeQueue}>
                이어 보내기
              </button>
            ) : (
              <button type="button" className="primary" data-testid="chat-send-now" onClick={sendNowKey}>
                지금 보내기 ⌘↩
              </button>
            )}
          </div>
        )}
        {images.length > 0 && (
          <div className="chat-images" data-testid="chat-images">
            {images.map((im, i) => (
              <span key={i} className="chat-image-chip">
                🖼 {im.name}
                <button type="button" aria-label={`${im.name} 빼기`} onClick={() => setImages((xs) => xs.filter((_, j) => j !== i))}>
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={inputRef}
          className="chat-input"
          data-testid="chat-input"
          aria-label="대화 입력"
          rows={2}
          value={text}
          placeholder={pending ? (pending.kind === 'question' ? '카드에서 고르거나 직접 써도 돼요' : '허락하거나, 다른 방법을 말해 주세요') : running ? '돌고 있는 동안 쓰면 대기열에 들어가요 (↩) · ⌘↩ 지금 보내기' : '무엇을 할까요?'}
          onChange={(e) => setText(e.target.value)}
          onPaste={onPaste}
        />
        <div className="chat-input-row">
          <button type="button" className="chat-attach" data-testid="chat-attach" onClick={() => void pickImages()} title="그림 붙이기 (⌘V · 끌어 놓기도 돼요)">
            📎 그림
          </button>
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
          {model && (
            <span className="dim small chat-model" data-testid="chat-model">
              {name} · {model}
            </span>
          )}
          <span className="dim small chat-keys" title="↩ 보내기 · ⇧↩ 줄바꿈 · ⌘↩ 지금 보내기 · ⌘. 멈춤 · ⌘J 셸">⇧↩ 줄바꿈 · ⌘J 셸</span>
          {running ? (
            <button type="button" className="chat-send stop" onClick={() => window.taskminal.chat.interrupt(p.paneId)}>
              멈춤 ⌘.
            </button>
          ) : (
            <button type="button" className="chat-send" data-testid="chat-send" disabled={!text.trim()} onClick={() => send()}>
              보내기 ↩
            </button>
          )}
        </div>
      </footer>
    </div>
  )
}

function Band({
  b,
  agent,
  onRetry,
  canRetry,
  onToTerminal,
  onOpenLogin,
}: {
  b: Extract<ChatBlock, { kind: 'band' }>
  agent: ChatAgent
  onRetry(): void
  canRetry: boolean
  onToTerminal(): void
  onOpenLogin(): void
}) {
  const name = AGENT_NAME[agent]
  let title: string
  let body: string
  let actions: { label: string; run(): void }[] = []
  switch (b.error) {
    case 'login':
      title = `${name} 에 로그인되어 있지 않아요`
      body = agent === 'codex' ? '터미널에서 codex login 을 실행해 주세요. 로그인하면 이 대화를 바로 이어 써요.' : '터미널에서 claude 를 열어 /login 해 주세요. 로그인하면 이 대화를 바로 이어 써요.'
      actions = [{ label: '터미널 열기', run: onOpenLogin }, ...(canRetry ? [{ label: '다시 시도', run: onRetry }] : [])]
      break
    case 'missing':
      title = `${agent} 명령을 찾지 못했어요`
      body = `${agent === 'codex' ? 'Codex CLI' : 'Claude Code'} 를 설치하면 대화를 쓸 수 있어요. 설치한 뒤 다시 시도하면 다시 찾아요.`
      actions = [
        { label: '설치 명령 복사', run: () => void navigator.clipboard.writeText(INSTALL[agent]) },
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
      body = `${b.error === 'crash' ? `${name} 가 갑자기 끝났어요. ` : ''}지금까지의 대화와 파일은 그대로예요. 다시 시도해도 같으면 터미널로 열어 보세요.${code}`
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
