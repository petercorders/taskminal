// 23단계 변경 검토 pane — 파일별 diff · 줄 골라 되돌리기 · 체크한 파일만 커밋 · 되돌린 것 7일. git 은 main(review-git) 이 부른다.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react'
import {
  MANY_FILES,
  resolveReviewPath,
  commitWarnings,
  fileSig,
  filterFiles,
  folderGroups,
  foldReason,
  lineKey,
  type CommitResult,
  type DiffFile,
  type DiffLine,
  type ReviewLoad,
  type ReviewOk,
  type RevertedView,
} from '../shared/review'
import type { ToastSpec } from './Toast'
import { ConfirmDialog } from './ConfirmDialog'

export type ReviewMode = 'diff' | 'commit' | 'reverted'
/** App 이 보내는 요청 — ⇧⌘G · ⌘P · 대화 카드 'diff 열기'. n 이 바뀔 때마다 한 번 */
export interface ReviewRequest {
  mode: ReviewMode
  file?: string
  n: number
}

interface Props {
  paneId: string
  /** 일감 폴더 — 저장소 뿌리는 main 이 찾는다 */
  dir: string
  active: boolean
  visible: boolean
  focusSignal: number
  request: ReviewRequest | null
  /** '리뷰 중으로 옮기기' — 이름에 '리뷰' 가 든 상태가 있을 때만 */
  toReview: { name: string; run(): void } | null
  onAskChat(text: string): void
  onInsertTerminal(command: string): void
  onToast(t: Omit<ToastSpec, 'id'>): void
  /** 요청을 받았다 — App 이 지워 두어야 pane 이 다시 그려질 때 같은 요청을 또 받지 않는다(리뷰) */
  onRequestTaken(n: number): void
}

type CommitView =
  | { s: 'idle' }
  | { s: 'running'; started: number }
  | { s: 'failed'; reason: Exclude<CommitResult, { ok: true }>['reason']; tail: string }
  | { s: 'done'; hash: string; subject: string }

const KIND_NAME: Record<DiffFile['kind'], string> = { M: '고침', A: '새', D: '지움' }
const ago = (at: number, now: number): string => {
  const m = Math.max(0, Math.round((now - at) / 60_000))
  return m < 1 ? '방금' : m < 60 ? `${m}분 전` : m < 1440 ? `${Math.round(m / 60)}시간 전` : `${Math.round(m / 1440)}일 전`
}
const leftDays = (at: number, now: number): string => `${Math.max(0, Math.ceil((at + 7 * 86_400_000 - now) / 86_400_000))}일 남음`
const whenText = (at: number, now: number): string => {
  const d = new Date(at)
  const t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return new Date(now).toDateString() === d.toDateString() ? `오늘 ${t}` : `${d.getMonth() + 1}월 ${d.getDate()}일`
}

export function ReviewPane(p: Props) {
  const { paneId, dir, visible } = p
  const api = window.taskminal.review
  const [data, setData] = useState<ReviewLoad | null>(null)
  const [loading, setLoading] = useState(false)
  const [base, setBase] = useState<string | null>(null)
  const [mode, setMode] = useState<ReviewMode>('diff')
  const [cur, setCur] = useState<string | null>(null)
  const [sel, setSel] = useState<ReadonlySet<string>>(new Set())
  const [cursor, setCursor] = useState<string | null>(null)
  const [seen, setSeen] = useState<ReadonlyMap<string, string>>(new Map())
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set())
  const [message, setMessage] = useState('')
  const [commit, setCommit] = useState<CommitView>({ s: 'idle' })
  const [query, setQuery] = useState('')
  const [folderView, setFolderView] = useState<boolean | null>(null)
  const [openFolders, setOpenFolders] = useState<ReadonlySet<string>>(new Set())
  const [showBig, setShowBig] = useState<ReadonlySet<string>>(new Set())
  const [reverted, setReverted] = useState<RevertedView[]>([])
  const [revCursor, setRevCursor] = useState(0)
  const [confirm, setConfirm] = useState<{ path: string; sig: string; kind: DiffFile['kind'] } | null>(null)
  const [now, setNow] = useState(Date.now())
  const rootRef = useRef<HTMLDivElement>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const msgRef = useRef<HTMLTextAreaElement>(null)
  const diffRef = useRef<HTMLDivElement>(null)
  const focusWant = useRef<'msg' | 'root' | null>(null)
  const [focusTick, setFocusTick] = useState(0)

  // ─── 읽기: 요청 번호(옛 응답 버림) · 한 번에 하나(진행 중이면 표시해 두고 끝난 뒤 한 번 더) ───
  const reqNo = useRef(0)
  const inFlight = useRef(false)
  const again = useRef(false)
  const baseRef = useRef(base)
  baseRef.current = base
  const load = useCallback(async () => {
    if (inFlight.current) {
      again.current = true
      return
    }
    inFlight.current = true
    setLoading(true)
    const my = ++reqNo.current
    let r: ReviewLoad
    try {
      r = await api.load(dir, baseRef.current)
    } catch (e) {
      r = { state: 'error', message: String(e) }
    }
    inFlight.current = false
    if (my === reqNo.current) {
      setData(r)
      setNow(Date.now())
    }
    if (again.current) {
      again.current = false
      void load()
    } else setLoading(false)
  }, [api, dir])
  /** 쓰기 뒤 — 진행 중이던 읽기는 옛 응답이 되고, 새로 한 번 읽는다 */
  const reloadAfterWrite = useCallback(() => {
    reqNo.current++
    void load()
  }, [load])

  const ok: ReviewOk | null = data?.state === 'ok' ? data : null
  const root = ok?.root ?? null

  // 보이는 동안만: 처음 · 다시 보일 때 읽기 · 폴더 감시 · 창 포커스
  useEffect(() => {
    if (!visible) return
    void load()
    const onFocus = () => void load()
    window.addEventListener('focus', onFocus)
    const off = api.onChanged((id) => id === paneId && void load())
    return () => {
      window.removeEventListener('focus', onFocus)
      off()
    }
  }, [visible, load, api, paneId])
  useEffect(() => {
    api.watch(paneId, visible ? root : null)
  }, [api, paneId, visible, root])
  useEffect(() => () => api.watch(paneId, null), [api, paneId])
  useEffect(() => {
    if (visible) void load()
  }, [base]) // eslint-disable-line react-hooks/exhaustive-deps

  const files = useMemo(() => ok?.files ?? [], [ok])
  const viewOnly = !!ok?.base || !!ok?.merging
  const shown = useMemo(() => filterFiles(files, query), [files, query])
  const curFile = files.find((f) => f.path === cur) ?? null
  const curSig = curFile ? fileSig(curFile) : ''
  const many = folderView ?? files.length > MANY_FILES

  // 파일이 사라지면 첫 파일로 · 고른 줄은 그 파일 diff 가 바뀌면 버린다(엉뚱한 줄을 되돌리지 않게)
  useEffect(() => {
    if (!files.length) return setCur(null)
    if (!cur || !files.some((f) => f.path === cur)) setCur(files[0]!.path)
  }, [files, cur])
  // 'diff 열기' 로 온 파일 — 경로는 대화 폴더 기준이라 읽은 뒤 저장소 뿌리 기준으로 맞춘다(위의 '첫 파일로' 뒤에 와야 이긴다)
  const wantFile = useRef<string | null>(null)
  useEffect(() => {
    const want = wantFile.current
    if (!want || !ok) return
    wantFile.current = null
    const at = resolveReviewPath(files, ok.root, p.dir, want)
    if (at) setCur(at)
  }, [ok, files, focusTick]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setSel(new Set())
    setCursor(null)
  }, [cur, curSig])
  // 봤음: 파일 diff 가 바뀌면 풀린다
  useEffect(() => {
    setSeen((m) => {
      let changed = false
      const next = new Map<string, string>()
      for (const [path, sig] of m) {
        const f = files.find((x) => x.path === path)
        if (f && fileSig(f) === sig) next.set(path, sig)
        else changed = true
      }
      return changed ? next : m
    })
  }, [files])

  const refreshReverted = useCallback(async () => {
    if (root) setReverted(await api.reverted(root))
  }, [api, root])
  useEffect(() => {
    if (visible) void refreshReverted()
  }, [visible, refreshReverted, data])

  // App 의 요청(⇧⌘G · ⌘P · 'diff 열기')
  useEffect(() => {
    if (!p.request) return
    setMode(p.request.mode)
    if (p.request.file) {
      setQuery('')
      wantFile.current = p.request.file
      setFocusTick((n) => n + 1)
    }
    p.onRequestTaken(p.request.n)
    focusWant.current = p.request.mode === 'commit' ? 'msg' : 'root'
    setFocusTick((n) => n + 1)
  }, [p.request?.n]) // eslint-disable-line react-hooks/exhaustive-deps
  // 막 열린 pane 은 첫 읽기 전이라 메시지 칸이 아직 없다 — 그려진 뒤에 포커스
  useEffect(() => {
    const want = focusWant.current
    if (!want) return
    const el = want === 'msg' ? msgRef.current : rootRef.current
    if (!el) return
    focusWant.current = null
    requestAnimationFrame(() => el.focus())
  }, [focusTick, data, mode])
  useEffect(() => {
    if (p.active && !(document.activeElement instanceof HTMLTextAreaElement || document.activeElement instanceof HTMLInputElement)) rootRef.current?.focus()
  }, [p.active, p.focusSignal])

  // 커밋 진행 초(검사 중 · 서명 기다림)
  useEffect(() => {
    if (commit.s !== 'running') return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [commit.s])

  // ─── 되돌리기 ───
  const busy = useRef(false)
  const restore = useCallback(
    async (id: string) => {
      const r = await api.restore(id)
      if (r === 'ok') p.onToast({ text: '되살렸어요' })
      else if (r === 'changed') p.onToast({ text: '되살리지 못했어요', sub: '그 뒤로 같은 줄이 또 바뀌었어요' })
      else if (r === 'unknown') p.onToast({ text: '결과를 모르겠어요 — 다시 읽었어요' })
      else p.onToast({ text: '되살릴 것이 없어요' })
      reloadAfterWrite()
      void refreshReverted()
    },
    [api, p, reloadAfterWrite, refreshReverted],
  )
  const afterRevert = (r: Awaited<ReturnType<typeof api.revertLines>>) => {
    if (r.ok) {
      p.onToast({
        text: r.what === '새 파일' ? '새 파일을 지웠어요' : r.what === '파일 전체' ? '파일을 되돌렸어요' : `${r.what}를 되돌렸어요`,
        sub: '⌘Z 로 바로 취소해요 · 창을 닫아도 7일 동안 "되돌린 것" 에서 다시 살릴 수 있어요',
        action: { label: '되살리기', run: () => void restore(r.id) },
      })
      setSel(new Set())
    } else if (r.reason === 'changed') p.onToast({ text: '파일이 바뀌어 되돌리지 못했어요', sub: '다시 읽었어요 — 다시 골라 주세요' })
    else if (r.reason === 'unknown') p.onToast({ text: '결과를 모르겠어요 — 다시 읽었어요' })
    else if (r.reason === 'nothing') p.onToast({ text: r.message ?? '되돌릴 줄이 없어요' })
    else p.onToast({ text: '되돌리지 못했어요', sub: r.message ?? '' })
    reloadAfterWrite()
  }
  const revertSelected = async () => {
    if (busy.current || !curFile || !root || sel.size === 0 || viewOnly) return
    busy.current = true
    try {
      afterRevert(await api.revertLines(root, curFile.path, curSig, [...sel]))
    } finally {
      busy.current = false
    }
  }
  const revertWhole = async (c: { path: string; sig: string }) => {
    setConfirm(null)
    if (busy.current || !root) return
    busy.current = true
    try {
      afterRevert(await api.revertFile(root, c.path, c.sig)) // 연 순간의 표지 — 그 사이 바뀌었으면 main 이 거절
    } finally {
      busy.current = false
    }
  }

  // ─── 커밋 ───
  const checkedFiles = files.filter((f) => !unchecked.has(f.path))
  const warnings = ok ? commitWarnings({ branch: ok.branch, worktree: ok.worktree, files: checkedFiles }) : []
  const doCommit = async () => {
    if (!ok || commit.s === 'running' || viewOnly) return
    if (!checkedFiles.length) return p.onToast({ text: '체크한 파일이 없어요' })
    if (!message.trim()) {
      msgRef.current?.focus()
      return p.onToast({ text: '커밋 메시지를 써 주세요' })
    }
    setCommit({ s: 'running', started: Date.now() })
    let r: CommitResult
    try {
      r = await api.commit(ok.root, checkedFiles.map((f) => f.path), message, checkedFiles.map(fileSig))
    } catch {
      r = { ok: false, reason: 'unknown', tail: '' }
    }
    if (r.ok) {
      setCommit({ s: 'done', hash: r.hash, subject: r.subject })
      setMessage('')
      setUnchecked(new Set())
    } else if (r.reason === 'changed') {
      setCommit({ s: 'idle' })
      p.onToast({ text: '바뀐 파일 목록이 달라져 커밋하지 않았어요', sub: '다시 읽었어요 — 확인하고 다시 커밋해 주세요' })
    } else if (r.reason === 'unknown') {
      setCommit({ s: 'idle' })
      p.onToast({ text: '커밋 결과를 모르겠어요 — 다시 읽었어요', sub: '마지막 커밋을 확인해 주세요' })
    } else setCommit({ s: 'failed', reason: r.reason, tail: r.tail })
    reloadAfterWrite()
  }
  const undo = async () => {
    if (commit.s !== 'done' || !ok) return
    const r = await api.undoCommit(ok.root, commit.hash)
    if (r === 'ok') {
      setCommit({ s: 'idle' })
      setMode('commit')
      p.onToast({ text: '커밋을 취소했어요', sub: '바뀐 내용은 그대로 남아 있어요' })
    } else p.onToast({ text: '커밋을 취소하지 않았어요', sub: r === 'remote' ? '이미 원격 브랜치에 있어요' : r === 'moved' ? '그 뒤로 다른 커밋이 생겼어요' : r === 'root' ? '첫 커밋은 취소하지 않아요' : '' })
    reloadAfterWrite()
  }
  // 커밋 끝 이후 바뀐 것이 생기면 끝남 표시는 그대로 두되 목록은 새로

  // ─── 키 ───
  const changeKeys = useMemo(() => {
    const out: string[] = []
    curFile?.hunks.forEach((h, hi) => h.lines.forEach((l, li) => l.t !== ' ' && out.push(lineKey(hi, li))))
    return out
  }, [curFile])
  const canPick = !!curFile && curFile.kind !== 'D' && !curFile.binary && !curFile.big && !viewOnly
  const toggleLine = (k: string) => {
    if (!canPick) return
    setCursor(k)
    setSel((s) => {
      const n = new Set(s)
      if (n.has(k)) n.delete(k)
      else n.add(k)
      return n
    })
  }
  const stepFile = (d: 1 | -1) => {
    const list = shown
    if (!list.length) return
    const i = list.findIndex((f) => f.path === cur)
    setCur(list[Math.max(0, Math.min(list.length - 1, (i < 0 ? 0 : i) + d))]!.path)
  }
  const stepHunk = (d: 1 | -1) => {
    const box = diffRef.current
    if (!box) return
    const hunks = [...box.querySelectorAll<HTMLElement>('[data-testid="review-hunk"]')]
    const top = box.scrollTop
    const target = d > 0 ? hunks.find((h) => h.offsetTop > top + 4) : [...hunks].reverse().find((h) => h.offsetTop < top - 4)
    if (target) box.scrollTop = target.offsetTop
  }
  const toggleSeen = () => {
    if (!curFile) return
    setSeen((m) => {
      const n = new Map(m)
      if (n.get(curFile.path) === curSig) n.delete(curFile.path)
      else n.set(curFile.path, curSig)
      return n
    })
  }
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const t = e.target
    const typing = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement
    if (e.metaKey && e.key === 'Enter') {
      e.preventDefault()
      if (mode === 'commit') void doCommit()
      else setMode('commit'), requestAnimationFrame(() => msgRef.current?.focus())
      return
    }
    if (typing) {
      if (e.key === 'Escape') (t as HTMLElement).blur(), rootRef.current?.focus()
      return
    }
    if (e.metaKey || e.ctrlKey) return
    if (mode === 'reverted') {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setRevCursor((i) => Math.max(0, Math.min(reverted.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1))))
      } else if (e.key === 'Enter') {
        const r = reverted[revCursor]
        if (r) void restore(r.id)
      } else if (e.key === 'Escape') setMode('diff')
      return
    }
    if (e.altKey && e.key === 'Enter') return e.preventDefault(), toggleSeen()
    switch (e.key) {
      case 'j':
        return stepFile(1)
      case 'k':
        return stepFile(-1)
      case 'n':
        return stepHunk(1)
      case 'p':
        return stepHunk(-1)
      case '/':
        e.preventDefault()
        return filterRef.current?.focus()
      case 'Backspace':
      case 'Delete':
        e.preventDefault()
        return void revertSelected()
      case 'Escape':
        if (sel.size) return setSel(new Set())
        if (mode !== 'diff') return setMode('diff')
        return
      case 'ArrowDown':
      case 'ArrowUp': {
        if (!e.shiftKey || !canPick || !changeKeys.length) return
        e.preventDefault()
        const i = cursor ? changeKeys.indexOf(cursor) : -1
        const next = changeKeys[Math.max(0, Math.min(changeKeys.length - 1, i < 0 ? 0 : i + (e.key === 'ArrowDown' ? 1 : -1)))]!
        setCursor(next)
        setSel((s) => new Set([...s, ...(cursor && i >= 0 && !s.size ? [cursor] : []), next]))
        return
      }
    }
  }

  // ─── 그리기 ───
  const nSeen = files.filter((f) => seen.get(f.path) === fileSig(f)).length
  const add = files.reduce((s, f) => s + f.add, 0)
  const del = files.reduce((s, f) => s + f.del, 0)
  const summary = `파일 ${files.length}개 · ${files.length - nSeen}개 남음 · +${add} −${del}`
  const fresh = loading ? '갱신 중' : '방금 갱신'

  const fileRow = (f: DiffFile) => {
    const isSeen = seen.get(f.path) === fileSig(f)
    const checked = !unchecked.has(f.path)
    return (
      <button
        key={f.path}
        type="button"
        className={`review-file${f.path === cur && mode !== 'commit' ? ' current' : ''}`}
        data-testid="review-file"
        data-path={f.path}
        aria-current={f.path === cur}
        onClick={() => {
          if (mode === 'commit') {
            setUnchecked((u) => {
              const n = new Set(u)
              if (n.has(f.path)) n.delete(f.path)
              else n.add(f.path)
              return n
            })
          } else {
            setCur(f.path)
            setMode('diff')
          }
        }}
      >
        {mode === 'commit' && (
          <span className={`review-box${checked ? ' on' : ''}`} data-testid="review-check" data-checked={checked} aria-hidden>
            {checked ? '✓' : ''}
          </span>
        )}
        <span className={`review-kind k${f.kind}`}>{KIND_NAME[f.kind]}</span>
        <span className="review-file-name" title={f.path}>
          {f.path}
        </span>
        <span className="review-counts">
          {f.add ? <span className="add">+{f.add}</span> : null} {f.del ? <span className="del">−{f.del}</span> : null}
        </span>
        {mode !== 'commit' && (
          <span className={`review-seen${isSeen ? ' on' : ''}`} data-testid="review-seen" data-seen={isSeen}>
            {isSeen ? '✓' : '○'}
          </span>
        )}
      </button>
    )
  }

  const lineRow = (l: DiffLine, hi: number, li: number) => {
    const k = lineKey(hi, li)
    const change = l.t !== ' '
    const picked = sel.has(k)
    const no = l.t === '-' ? `${l.oldNo ?? ''}` : l.t === '+' ? `${l.newNo ?? ''}` : `${l.newNo ?? ''}`
    return (
      <div
        key={k}
        className={`review-line t${l.t === '+' ? 'add' : l.t === '-' ? 'del' : 'ctx'}${picked ? ' picked' : ''}${cursor === k ? ' cursor' : ''}`}
        data-testid="review-line"
        data-key={k}
        data-picked={picked}
        onClick={() => change && toggleLine(k)}
      >
        <span className="review-no">{no}</span>
        <span className="review-text">
          {l.t === ' ' ? ' ' : l.t} {l.text}
        </span>
        {!picked && (
          <button
            type="button"
            className="review-ask"
            data-testid="review-ask"
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation()
              askAbout([l])
            }}
          >
            ✦ 대화에 묻기
          </button>
        )}
      </div>
    )
  }
  const askAbout = (lines: DiffLine[]) => {
    if (!curFile) return
    const nos = lines.map((l) => l.newNo ?? l.oldNo ?? 0)
    const range = nos.length > 1 ? `${Math.min(...nos)}~${Math.max(...nos)}` : `${nos[0]}`
    p.onAskChat(`${curFile.path}:${range} 이 변경에 대해 —\n\`\`\`diff\n${lines.map((l) => `${l.t}${l.text}`).join('\n')}\n\`\`\`\n`)
  }

  const diffBody = () => {
    if (!curFile) return null
    const fold = foldReason(curFile)
    if (fold === 'binary') return <div className="review-fold" data-testid="review-fold">이진 파일이라 diff 를 보이지 않아요 · {curFile.path}</div>
    if (fold === 'big' && !showBig.has(curFile.path))
      return (
        <div className="review-fold" data-testid="review-fold">
          큰 파일이라 접었어요 · {curFile.path} · +{curFile.add} −{curFile.del}
          {!curFile.big && (
            <button type="button" onClick={() => setShowBig((s) => new Set([...s, curFile.path]))}>
              그래도 보기
            </button>
          )}
        </div>
      )
    let prevEnd = 1
    return curFile.hunks.map((h, hi) => {
      const gap = h.oldStart - prevEnd
      prevEnd = h.oldStart + h.oldCount
      return (
        <div key={hi} data-testid="review-hunk" className="review-hunk">
          {gap > 0 && <div className="review-gap">··· 바뀌지 않은 {gap}줄</div>}
          <div className="review-hunk-head">{h.header}</div>
          {h.lines.map((l, li) => lineRow(l, hi, li))}
        </div>
      )
    })
  }

  const empty = (tag: string, title: string, body: string, acts: Array<{ label: string; run(): void }>) => (
    <div className="review-empty" data-testid="review-empty" data-kind={tag}>
      <div className="review-empty-title">{title}</div>
      <div className="review-empty-body">{body}</div>
      <div className="review-empty-acts">
        {acts.map((a) => (
          <button key={a.label} type="button" onClick={a.run}>
            {a.label}
          </button>
        ))}
      </div>
    </div>
  )

  let main: ReactElement
  if (!data) main = <div className="review-empty dim">읽는 중…</div>
  else if (data.state === 'no-git')
    main = empty('no-git', 'git 을 찾지 못했어요', '명령줄 도구를 설치하면 써요. 설치 뒤 다시 찾으면 돼요.', [
      { label: '터미널에 xcode-select --install 넣기', run: () => p.onInsertTerminal('xcode-select --install') },
      { label: '다시 찾기', run: () => void load() },
    ])
  else if (data.state === 'not-repo')
    main = empty('not-repo', '이 폴더는 git 저장소가 아니에요', `${dir} — 바뀐 걸 보려면 저장소가 필요해요. 터미널에서 git init 을 실행해 주세요.`, [
      { label: '터미널에 git init 넣기', run: () => p.onInsertTerminal('git init') },
    ])
  else if (data.state === 'error') main = empty('error', 'git 을 읽지 못했어요', data.message, [{ label: '다시 읽기', run: () => void load() }])
  else if (mode === 'reverted')
    main = (
      <div className="review-reverted" data-testid="review-reverted">
        <div className="review-reverted-head">되돌린 것 · 창을 닫아도 7일 동안 남아요 · 이 저장소 것만</div>
        {reverted.length === 0 && <div className="review-empty dim">되돌린 것이 없어요</div>}
        {reverted.map((r, i) => (
          <div key={r.id} className={`review-rev-row${i === revCursor ? ' current' : ''}`} data-testid="review-rev-row" data-path={r.path}>
            <span className="dim">{whenText(r.at, now)}</span>
            <span className="review-file-name">{r.path}</span>
            <span>{r.what}</span>
            <span className="dim">{leftDays(r.at, now)}</span>
            <button type="button" data-testid="review-restore" onClick={() => void restore(r.id)}>
              되살리기
            </button>
          </div>
        ))}
        <div className="review-hint">그 뒤로 같은 줄이 또 바뀌었으면 되살릴 수 없어요 · ↑↓ 고르기 · ↩ 되살리기 · Esc 돌아가기</div>
      </div>
    )
  else if (!files.length && mode !== 'commit')
    main = empty('clean', '바뀐 파일이 없어요', ok?.head ? `마지막 커밋 ${ok.head.hash.slice(0, 7)} · ${ago(ok.head.at, now)}. 에이전트가 고치면 여기 바로 나타나요.` : '아직 커밋이 없어요.', [])
  else {
    const groups = many ? folderGroups(shown) : null
    main = (
      <div className="review-body">
        <div className="review-list" data-testid="review-list">
          <div className="review-list-tools">
            <input ref={filterRef} className="review-filter" placeholder="⌕ 파일 거르기 /" value={query} onChange={(e) => setQuery(e.target.value)} data-testid="review-filter" />
            <span className="review-seg">
              <button type="button" aria-pressed={!many} onClick={() => setFolderView(false)}>
                목록
              </button>
              <button type="button" aria-pressed={many} onClick={() => setFolderView(true)}>
                폴더
              </button>
            </span>
          </div>
          <div className="review-files">
            {groups
              ? groups.map((g) =>
                  g.name === '' ? (
                    g.files.map(fileRow)
                  ) : (
                    <div key={g.name}>
                      <button
                        type="button"
                        className="review-folder"
                        onClick={() => setOpenFolders((s) => (s.has(g.name) ? new Set([...s].filter((x) => x !== g.name)) : new Set([...s, g.name])))}
                      >
                        {openFolders.has(g.name) ? '▾' : '▸'} {g.name} ({g.files.length}) <span className="add">+{g.add}</span> <span className="del">−{g.del}</span>
                      </button>
                      {openFolders.has(g.name) && g.files.map(fileRow)}
                    </div>
                  ),
                )
              : shown.map(fileRow)}
          </div>
          {mode !== 'commit' && !viewOnly && (
            <button type="button" className="review-dock primary" data-testid="review-to-commit" onClick={() => (setMode('commit'), requestAnimationFrame(() => msgRef.current?.focus()))}>
              파일 {checkedFiles.length}개 커밋 ⌘↩
            </button>
          )}
        </div>
        {mode === 'commit' ? commitBox() : diffPane()}
      </div>
    )
  }

  function diffPane() {
    return (
      <div className="review-diff">
        {curFile && (
          <div className="review-file-head">
            <span className="review-file-name">{curFile.path}</span>
            {canPick && (
              <span className="dim review-pick-tip">줄을 눌러 고르면 그 줄만 되돌릴 수 있어요</span>
            )}
            <button type="button" onClick={() => root && api.openFile(root, curFile.path)} disabled={curFile.kind === 'D'}>
              편집기로 열기
            </button>
            {!viewOnly && (
              <button type="button" data-testid="review-revert-file" onClick={() => setConfirm({ path: curFile.path, sig: curSig, kind: curFile.kind })}>
                {curFile.kind === 'A' ? '새 파일 지우기…' : '파일 전체 되돌리기…'}
              </button>
            )}
          </div>
        )}
        {ok?.merging && <div className="review-band warn">병합 중이라 줄 되돌리기 · 커밋을 막았어요 — 터미널에서 병합을 마무리하면 다시 쓸 수 있어요. 보기는 그대로 돼요.</div>}
        <div className="review-lines" ref={diffRef} data-testid="review-diff">
          {diffBody()}
        </div>
        {sel.size > 0 && (
          <div className="review-revert-bar" data-testid="review-revert-bar">
            <span>고른 줄 {sel.size}개를 되돌려요 — 아직 커밋 안 한 변경에서만 빠져요</span>
            <button type="button" onClick={() => askAbout(curFile!.hunks.flatMap((h, hi) => h.lines.filter((_, li) => sel.has(lineKey(hi, li)))))}>
              ✦ 대화에 묻기
            </button>
            <button type="button" onClick={() => setSel(new Set())}>
              고른 줄 풀기
            </button>
            <button type="button" className="warn" data-testid="review-revert" onClick={() => void revertSelected()}>
              고른 줄 되돌리기 ⌫
            </button>
          </div>
        )}
        <div className="review-hint">j/k 파일 · n/p 다음 · 이전 변경 묶음 · ⇧↑↓ 줄 고르기 · ⌫ 고른 줄 되돌리기 · ⌥↩ 봤음 · ⌘↩ 커밋 · / 거르기</div>
      </div>
    )
  }

  function commitBox() {
    const left = files.length - checkedFiles.length
    const elapsed = commit.s === 'running' ? Math.floor((now - commit.started) / 1000) : 0
    const signing = commit.s === 'running' && !!ok?.gpgsign && elapsed >= 3
    const label = commit.s === 'failed' ? '다시 커밋 ⌘↩' : warnings.length ? '그래도 커밋 ⌘↩' : `커밋 ⌘↩`
    return (
      <div className="review-commit" data-testid="review-commit">
        <div className="review-commit-head">
          커밋 · 체크한 파일 {checkedFiles.length}개 <span className="dim">push 는 하지 않아요</span>
        </div>
        {commit.s === 'done' ? (
          <div className="review-done" data-testid="review-done">
            <div>
              ✓ {commit.hash.slice(0, 7)} 커밋했어요 <span className="dim">{commit.subject}</span>
            </div>
            <div className="review-commit-acts">
              <button type="button" data-testid="review-undo-commit" onClick={() => void undo()}>
                커밋 취소
              </button>
              {p.toReview && (
                <button type="button" onClick={p.toReview.run}>
                  {p.toReview.name}(으)로 옮기기
                </button>
              )}
              <button type="button" onClick={() => (setCommit({ s: 'idle' }), setMode('diff'))}>
                변경 보기로
              </button>
            </div>
          </div>
        ) : (
          <>
            <textarea
              ref={msgRef}
              className="review-msg"
              data-testid="review-msg"
              placeholder="커밋 메시지를 써 주세요"
              value={message}
              disabled={commit.s === 'running'}
              onChange={(e) => setMessage(e.target.value)}
            />
            {warnings.map((w) => (
              <div key={w.kind} className={`review-band ${w.kind === 'main' ? 'warn' : 'err'}`} data-testid="review-warning" data-kind={w.kind}>
                {w.text}
                {w.kind === 'secret' && (
                  <button type="button" onClick={() => (setCur(w.path), setMode('diff'))}>
                    그 줄 보기
                  </button>
                )}
              </div>
            ))}
            {commit.s === 'running' && (
              <div className={`review-band ${signing ? 'warn' : 'info'}`} data-testid="review-progress">
                {signing ? '서명을 기다려요 — 서명 창(1Password · pinentry)을 확인해 주세요' : `커밋 전 검사를 돌리는 중 · ${elapsed}초`}
              </div>
            )}
            {commit.s === 'failed' && (
              <div className="review-fail" data-testid="review-fail" data-reason={commit.reason}>
                <div className="err">
                  ✗{' '}
                  {commit.reason === 'sign'
                    ? '서명하지 못했어요'
                    : commit.reason === 'locked'
                      ? '터미널에서 다른 git 이 돌고 있어요'
                      : commit.reason === 'merging'
                        ? '병합 중이라 커밋하지 않았어요'
                        : commit.reason === 'empty'
                          ? '커밋 메시지가 비었어요'
                          : '커밋 전 검사가 실패했어요'}{' '}
                  — 아무것도 바꾸지 않았어요
                </div>
                {commit.tail && (
                  <details open>
                    <summary>출력 마지막 20줄</summary>
                    <pre data-testid="review-fail-tail">{commit.tail}</pre>
                  </details>
                )}
                <button type="button" data-testid="review-ask-fix" onClick={() => p.onAskChat(`커밋 전 검사가 실패했어요. 고쳐 주세요.\n\`\`\`\n${commit.tail}\n\`\`\`\n`)}>
                  ✦ 대화에 고쳐 달라고 하기
                </button>
              </div>
            )}
            {left > 0 && <div className="review-left dim">{left === 1 ? '1개는 빠져 있어요' : `${left}개는 빠져 있어요`} · 파일을 눌러 넣기</div>}
            <div className="review-commit-acts">
              <button type="button" onClick={() => setMode('diff')}>
                돌아가기
              </button>
              <button type="button" className={warnings.length ? 'warn' : 'primary'} data-testid="review-commit-btn" disabled={commit.s === 'running' || viewOnly || !checkedFiles.length} onClick={() => void doCommit()}>
                {label}
              </button>
            </div>
          </>
        )}
      </div>
    )
  }

  return (
    <div className="review-pane" ref={rootRef} tabIndex={0} data-testid="review-pane" data-pane-id={paneId} onKeyDown={onKey}>
      <div className="review-head">
        <span className="review-title">변경</span>
        {ok?.branch && <span className="review-branch">⎇ {ok.branch}</span>}
        <span className={`review-fresh${loading ? ' busy' : ''}`} data-testid="review-fresh">
          <span className="dot" aria-hidden /> {fresh}
        </span>
        {ok && files.length > 0 && (
          <span className="review-summary dim" data-testid="review-summary">
            {summary}
          </span>
        )}
        <span className="grow" />
        {ok && ok.bases.length > 0 && (
          <span className="review-seg">
            <button type="button" aria-pressed={!base} onClick={() => setBase(null)}>
              아직 커밋 안 한 것
            </button>
            <button type="button" aria-pressed={base === ok.bases[0]} onClick={() => setBase(ok.bases[0]!)}>
              {ok.bases[0]} 과 다른 것
            </button>
          </span>
        )}
        {ok && (
          <button type="button" className="review-rev-link" data-testid="review-to-reverted" onClick={() => setMode(mode === 'reverted' ? 'diff' : 'reverted')}>
            되돌린 것 {reverted.length}
          </button>
        )}
      </div>
      {main}
      {confirm && (
        <ConfirmDialog
          title={confirm.kind === 'A' ? '새 파일을 지울까요?' : '파일 전체를 되돌릴까요?'}
          message={`${confirm.path} — 아직 커밋 안 한 변경이 모두 빠져요. 7일 동안 "되돌린 것" 에서 다시 살릴 수 있어요.`}
          confirmLabel={confirm.kind === 'A' ? '지우기' : '되돌리기'}
          onConfirm={() => void revertWhole(confirm)}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  )
}
