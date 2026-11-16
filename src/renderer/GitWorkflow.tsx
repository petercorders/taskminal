import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitWorkflowApi, GitWorkflowResult, GitWorkflowView, MergePullRequest } from '../shared/git-workflow'
import { Modal } from './Modal'

const ghText: Record<GitWorkflowView['gh'], string> = {
  ready: 'GitHub 연결됨',
  missing: 'GitHub CLI(gh)를 설치해 주세요.',
  login: '터미널에서 gh auth login으로 로그인해 주세요.',
  'not-github': 'GitHub 원격을 선택하면 PR을 볼 수 있어요.',
  error: 'PR 상태를 읽지 못했어요. 다시 읽어 주세요.',
}
const checksText = { passed: '체크 통과', pending: '체크 진행 중', failed: '체크 실패', none: '등록된 체크 없음' }
interface Props {
  dir: string
  api: GitWorkflowApi
  onOpenUrl?(url: string): void
}

/** 33단계 변경 검토의 원격 작업. 버튼을 누르기 전 본 SHA와 실행 직전 SHA가 같아야 한다. */
export function GitWorkflow({ dir, api, onOpenUrl }: Props) {
  const [view, setView] = useState<GitWorkflowView | null>(null)
  const [remote, setRemote] = useState('')
  const [base, setBase] = useState('')
  const [baseDraft, setBaseDraft] = useState('')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [reading, setReading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<GitWorkflowResult | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<MergePullRequest | null>(null)
  const rootRef = useRef<HTMLElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!confirm) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    cancelRef.current?.focus()
    return () => {
      if (previous?.isConnected && !previous.matches(':disabled')) previous.focus()
      else rootRef.current?.focus()
    }
  }, [confirm])
  const seq = useRef(0)
  const mounted = useRef(true)
  const busyRef = useRef(false)
  const selection = useRef({ dir, remote, base })
  selection.current = { dir, remote, base }
  const load = useCallback(async () => {
    const id = ++seq.current
    setReading(true)
    setReadError(null)
    try {
      const v = await api.view(dir, { ...(remote ? { remote } : {}), ...(base ? { base } : {}) })
      if (!mounted.current || id !== seq.current) return
      setView(v)
      setTitle((old) => old || v.branch || '')
      setBaseDraft((old) => old || v.target?.base || '')
    } catch {
      if (mounted.current && id === seq.current) setReadError('상태를 읽지 못했어요. 다시 읽어 주세요.')
    } finally {
      if (mounted.current && id === seq.current) setReading(false)
    }
  }, [api, dir, remote, base])
  useEffect(() => {
    mounted.current = true
    void load()
    return () => {
      mounted.current = false
      seq.current++
    }
  }, [load])
  useEffect(() => {
    setConfirm(null)
    setView(null)
    setMessage(null)
  }, [dir, remote, base])
  const run = async (action: () => Promise<GitWorkflowResult>) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setMessage(null)
    setConfirm(null)
    seq.current++ // 쓰기 전의 읽기 결과는 버린다
    const start = selection.current
    try {
      const r = await action()
      if (!mounted.current || selection.current.dir !== start.dir || selection.current.remote !== start.remote || selection.current.base !== start.base) return
      setMessage(r)
      await load()
    } catch {
      if (mounted.current && selection.current.dir === start.dir && selection.current.remote === start.remote && selection.current.base === start.base)
        setMessage({ state: 'unknown', message: '결과를 확인하지 못했어요. 다시 읽어 주세요.' })
    } finally {
      busyRef.current = false
      if (mounted.current) setBusy(false)
    }
  }
  const target = view?.target
  const pr = view?.pr
  const disabled = busy || reading
  const selectRemote = (value: string) => {
    setRemote(value)
    setBase('')
    setBaseDraft('')
  }
  return (
    <section ref={rootRef} tabIndex={-1} className="git-workflow" data-testid="git-workflow" aria-labelledby="git-workflow-title" aria-busy={reading || busy}>
      <header className="git-workflow-head">
        <h2 id="git-workflow-title">GitHub · 원격</h2>
        <button type="button" className="button small" disabled={disabled} onClick={() => void load()}>
          다시 읽기
        </button>
      </header>
      {reading && <div role="status">상태 읽는 중…</div>}
      {readError && <div role="alert">{readError}</div>}
      {view?.state === 'no-git' && <p>Git을 설치해 주세요.</p>}
      {view?.state === 'not-repo' && <p>이 폴더는 Git 저장소가 아니에요.</p>}
      {view?.state === 'error' && <div role="alert">{view.message ?? '저장소를 읽지 못했어요.'}</div>}
      {view?.state === 'ok' && (
        <>
          <div className="git-workflow-path" title={view.root ?? ''}>
            {view.root}
          </div>
          <div>
            {view.branch ?? '브랜치에서 떨어진 HEAD'} · {view.head?.slice(0, 8) ?? '아직 커밋 없음'}
          </div>
          <div className="dim small">
            {view.upstream ? `${view.upstream} · 앞섬 ${view.ahead} · 뒤처짐 ${view.behind}` : '연결된 upstream 없음'} · 마지막 로컬 조회 기준
          </div>
          {view.remotes.length === 0 ? (
            <p>원격 저장소가 없어요. 터미널에서 git remote add로 연결해 주세요.</p>
          ) : (
            <label className="git-workflow-field">
              원격
              <select aria-label="Git 원격" value={remote || target?.remote || ''} disabled={busy} onChange={(e) => selectRemote(e.target.value)}>
                <option value="" disabled>
                  원격 선택
                </option>
                {view.remotes.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
          )}
          {target && (
            <>
              <div className="dim small">{target.remoteUrl}</div>
              <button type="button" className="button" disabled={disabled} onClick={() => void run(() => api.push(dir, target))}>
                현재 커밋 올리기
              </button>
              <div className="dim small">{ghText[view.gh]}</div>
              {view.gh === 'ready' && (
                <>
                  <label className="git-workflow-field">
                    PR base
                    <input
                      aria-label="PR base 브랜치"
                      value={baseDraft}
                      disabled={busy}
                      onChange={(e) => setBaseDraft(e.target.value)}
                      placeholder="대상 브랜치"
                    />
                    <button
                      type="button"
                      className="button small"
                      disabled={disabled || !baseDraft.trim() || baseDraft.trim() === target.base}
                      onClick={() => setBase(baseDraft.trim())}
                    >
                      base 적용
                    </button>
                  </label>
                  <div className="small">
                    {target.repo} · {target.base ?? 'base를 선택해 주세요'} ← {target.branch}
                  </div>
                  {pr ? (
                    <div className="git-workflow-pr">
                      <strong>
                        #{pr.number} {pr.title}
                      </strong>
                      <div>
                        {pr.draft ? '초안 · ' : ''}
                        {pr.state} · {checksText[pr.checks]}
                        {pr.review ? ` · ${pr.review}` : ''}
                      </div>
                      <div className="small">PR head {pr.head.slice(0, 8)}</div>
                      <button type="button" className="button small" onClick={() => onOpenUrl?.(pr.url)} disabled={!onOpenUrl}>
                        PR 열기
                      </button>
                      <button
                        type="button"
                        className="button"
                        disabled={disabled || !pr.mergeable || pr.head !== target.head}
                        onClick={() => setConfirm({ target, number: pr.number, head: pr.head })}
                      >
                        병합 검토…
                      </button>
                      {!pr.mergeable && <div className="dim small">최신 리뷰·체크·충돌을 해결한 뒤 다시 읽어 주세요.</div>}
                    </div>
                  ) : (
                    <div className="git-workflow-create">
                      <label className="git-workflow-field">
                        PR 제목
                        <input aria-label="PR 제목" maxLength={256} value={title} disabled={busy} onChange={(e) => setTitle(e.target.value)} />
                      </label>
                      <label className="git-workflow-field">
                        PR 본문
                        <textarea aria-label="PR 본문" maxLength={60000} value={body} disabled={busy} onChange={(e) => setBody(e.target.value)} />
                      </label>
                      <button
                        type="button"
                        className="button"
                        disabled={disabled || !title.trim() || !target.base || target.base === target.branch}
                        onClick={() => void run(() => api.create(dir, { target, title, body }))}
                      >
                        PR 만들기
                      </button>
                      <div className="dim small">현재 커밋을 원격에 올린 뒤 PR을 만들 수 있어요.</div>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </>
      )}
      {busy && <div role="status">원격 작업 중… 화면을 닫아도 이미 시작한 작업은 끝날 수 있어요.</div>}
      {message && (
        <div role={message.state === 'ok' ? 'status' : 'alert'}>
          {message.message}
          {message.url && onOpenUrl && (
            <button type="button" className="link" onClick={() => onOpenUrl(message.url!)}>
              PR 열기
            </button>
          )}
        </div>
      )}
      {confirm && (
        <Modal role="alertdialog" labelledBy="git-merge-title" className="narrow" onCancel={() => setConfirm(null)}>
          <h1 id="git-merge-title">PR #{confirm.number}을 병합할까요?</h1>
          <p>
            {confirm.target.repo} · {confirm.target.base} ← {confirm.target.branch}
          </p>
          <p>커밋 {confirm.head.slice(0, 12)}을 squash 병합해요. 실행 전에 PR 커밋과 체크를 다시 확인해요.</p>
          <div className="dialog-actions">
            <button ref={cancelRef} type="button" className="button" onClick={() => setConfirm(null)}>
              취소
            </button>
            <button type="button" className="button" onClick={() => void run(() => api.merge(dir, confirm))}>
              이 PR 병합
            </button>
          </div>
        </Modal>
      )}
    </section>
  )
}
