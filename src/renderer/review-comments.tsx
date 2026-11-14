import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { fileSig, type DiffFile, type DiffLine } from '../shared/review'
import './review-comments.css'

export interface ReviewCommentTarget {
  path: string
  sig: string
  lines: Array<{ key: string; line: DiffLine }>
}
interface Comment extends ReviewCommentTarget {
  id: string
  body: string
  resolved: boolean
}
interface Drafts {
  comments: Comment[]
  composer: { target: ReviewCommentTarget; body: string } | null
}
// Renderer-memory drafts survive panel recreation; app reload ends them.
// Repository/base drafts are shared through subscriptions and atomic functional updates.
const drafts = new Map<string, Drafts>()
const scopeKey = (root: string, base: string | null) => JSON.stringify([root, base])
const listeners = new Set<() => void>()
function subscribe(notify: () => void) {
  listeners.add(notify)
  return () => { listeners.delete(notify) }
}
const location = (target: ReviewCommentTarget): string => {
  const labels = target.lines.map(({ line }) => `${line.t === '-' ? '이전 ' : '현재 '}${line.t === '-' ? line.oldNo ?? '?' : line.newNo ?? '?'}`)
  return `${target.path} · ${labels.join(', ')}`
}
const excerpt = (target: ReviewCommentTarget) => target.lines.map(({ line }) => `${line.t}${line.text}`).join('\n')

interface Props {
  visible: boolean
  root: string
  base: string | null
  files: DiffFile[]
  target: ReviewCommentTarget | null
  selection: ReviewCommentTarget | null
  onTargetTaken(): void
  onAskChat(text: string): void
}
export function ReviewComments(p: Props) {
  const scope = scopeKey(p.root, p.base)
  if (!drafts.has(scope)) drafts.set(scope, { comments: [], composer: null })
  const state = useSyncExternalStore(subscribe, () => drafts.get(scope)!)
  const [open, setOpen] = useState(state.comments.length > 0 || !!state.composer)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState('')
  const [invalid, setInvalid] = useState<ReadonlySet<string>>(new Set())
  const input = useRef<HTMLTextAreaElement>(null)
  const mounted = useRef(true)
  const available = useRef(p.visible)
  const generation = useRef(0)
  const attaching = useRef(false)
  // Invalidate immediately during render, including hide → return before reply.
  if (available.current !== p.visible) {
    available.current = p.visible
    generation.current++
  }
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const update = (apply: (latest: Drafts) => Drafts) => {
    drafts.set(scope, apply(drafts.get(scope)!))
    listeners.forEach((notify) => notify())
  }
  useEffect(() => {
    if (!p.target) return
    // Do not overwrite a half-written comment when another line is chosen.
    if (!drafts.get(scope)!.composer) update((latest) => ({ ...latest, composer: { target: p.target!, body: '' } }))
    else setError('작성 중인 의견을 추가하거나 버린 뒤 다른 줄을 골라 주세요.')
    setOpen(true)
    p.onTargetTaken()
    const epoch = generation.current
    requestAnimationFrame(() => {
      if (mounted.current && available.current && generation.current === epoch) input.current?.focus()
    })
  }, [p.target]) // eslint-disable-line react-hooks/exhaustive-deps
  const stale = (c: ReviewCommentTarget) => invalid.has(c.sig) || !p.files.some((f) => f.path === c.path && fileSig(f) === c.sig)
  const active = state.comments.filter((c) => !c.resolved)
  const change = (id: string, fn: (c: Comment) => Comment | null) => {
    // Resolve the id against the latest shared state, never a render snapshot.
    update((latest) => ({ ...latest, comments: latest.comments.flatMap((c) => c.id === id ? fn(c) ?? [] : [c]) }))
  }
  const attach = async () => {
    if (attaching.current || !available.current || !active.length || active.some(stale)) return
    attaching.current = true
    const epoch = generation.current
    const stillCurrent = () => mounted.current && available.current && generation.current === epoch
    setChecking(true)
    setError('')
    const snapshot = active.map((c) => ({ ...c }))
    try {
      const latest = await window.taskminal.review.load(p.root, p.base)
      if (!stillCurrent()) return
      if (latest.state !== 'ok' || latest.root !== p.root) throw new Error('review unavailable')
      const outdated = snapshot.filter((c) => !latest.files.some((f) => f.path === c.path && fileSig(f) === c.sig))
      if (outdated.length) {
        setInvalid(new Set(outdated.map((c) => c.sig)))
        setError('변경이 달라졌어요. 현재 diff를 다시 검토하고 줄을 다시 연결해 주세요.')
        return
      }
      const latestComments = drafts.get(scope)!.comments.filter((c) => !c.resolved)
      if (JSON.stringify(latestComments) !== JSON.stringify(snapshot)) {
        setError('확인하는 동안 의견이 바뀌었어요. 현재 의견을 확인하고 다시 넣어 주세요.')
        return
      }
      // Existing callback only fills the conversation composer. No agent send occurs here.
      p.onAskChat(`리뷰 의견 ${snapshot.length}개 — 저장소 ${p.root}\n\n${snapshot.map((c) => `${location(c)}\n변경 서명: ${c.sig}\n${c.body}\n\`\`\`diff\n${excerpt(c)}\n\`\`\``).join('\n\n')}\n`)
    } catch {
      if (stillCurrent()) setError('최신 변경을 읽지 못했어요. 의견은 보존했어요. 다시 시도해 주세요.')
    } finally {
      attaching.current = false
      if (mounted.current) setChecking(false)
    }
  }
  const composer = state.composer
  return (
    <details className="review-comments" open={open} onToggle={(e) => setOpen(e.currentTarget.open)} data-testid="review-comments">
      <summary>리뷰 의견 {active.length}개 · 초안은 이 창에서 보존해요</summary>
      <div className="review-comments-content">
        {error && <div role="status" className="review-band warn">{error}</div>}
        {composer && <div className="review-comment-composer">
          <div>{location(composer.target)}</div>
          {stale(composer.target) && <div className="warn">변경이 달라졌어요. 의견 추가 후 현재 줄을 다시 연결해 주세요.</div>}
          <textarea ref={input} aria-label="줄 리뷰 의견" value={composer.body} maxLength={10000} onChange={(e) => {
            const body = e.target.value
            update((latest) => latest.composer ? { ...latest, composer: { ...latest.composer, body } } : latest)
          }} />
          <div className="review-comment-actions">
            <button type="button" disabled={!composer.body.trim() || checking} onClick={() => {
              update((latest) => latest.composer?.body.trim() ? {
                comments: [...latest.comments, { ...latest.composer.target, body: latest.composer.body.trim(), id: crypto.randomUUID(), resolved: false }], composer: null,
              } : latest)
              setError('')
            }}>의견 추가</button>
            <button type="button" disabled={checking} onClick={() => update((latest) => ({ ...latest, composer: null }))}>작성 중인 의견 버리기</button>
          </div>
        </div>}
        {state.comments.map((c) => <div className="review-comment" data-testid="review-comment" data-stale={stale(c)} data-resolved={c.resolved} key={c.id}>
          <div>{location(c)} {c.resolved ? '· 해결됨' : ''}</div>
          <p>{c.body}</p>
          <details><summary>고른 diff 보기</summary><pre>{excerpt(c)}</pre></details>
          {stale(c) && <div className="warn">변경이 달라졌어요 · 다시 검토하고 현재 줄을 골라 주세요.</div>}
          <div className="review-comment-actions">
            {stale(c) && <button type="button" disabled={checking || !p.selection || p.selection.path !== c.path || invalid.has(p.selection.sig)} onClick={() => {
              const target = p.selection
              if (target && target.path === c.path) change(c.id, (saved) => ({ ...saved, ...target }))
            }}>현재 고른 줄로 다시 연결</button>}
            <button type="button" disabled={checking} onClick={() => change(c.id, (saved) => ({ ...saved, resolved: !saved.resolved }))}>{c.resolved ? '다시 열기' : '해결됨으로 표시'}</button>
            <button type="button" disabled={checking} aria-label={`${c.path} 의견 삭제`} onClick={() => change(c.id, () => null)}>삭제</button>
          </div>
        </div>)}
        <button type="button" disabled={checking || !active.length || active.some(stale)} onClick={() => void attach()} data-testid="review-comments-attach">{checking ? '최신 변경 확인 중…' : '리뷰 의견을 대화에 넣기'}</button>
        <span className="dim"> 대화 입력칸에 넣어요. 보내기는 직접 눌러 주세요.</span>
      </div>
    </details>
  )
}
