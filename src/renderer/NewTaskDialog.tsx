import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Modal } from './Modal'
import { defaultTaskCwd } from '../shared/model'
import { cwdLike } from '../shared/cwd'
import { checkBranchName } from '../shared/worktree'
import { runtime } from './runtime'
import type { AppState, NewTaskInput } from '../shared/types'

export const TASK_COLORS = ['#5b9cf5', '#7ccf8a', '#e5b567', '#e07a7a', '#b48ef0', '#5ec4c4']

/** 팔레트에서 열 때 미리 채우는 값: 맞는 게 없던 찾기 글자(이름) · 고른 템플릿 */
export interface NewTaskInitial {
  name?: string
  templateId?: string
}

interface Props {
  state: AppState
  initial?: NewTaskInitial
  onCreate(input: NewTaskInput): void
  onCancel(): void
}

/** 새 일감: 이름 · 작업 폴더 · 템플릿 · 상태 · 묶음 · 색. 폴더 · 템플릿의 처음 값은 설정(일반). 템플릿 카드는 12단계. */
export function NewTaskDialog({ state, initial, onCreate, onCancel }: Props) {
  const { settings } = state
  const [name, setName] = useState(initial?.name ?? '')
  const [templateId, setTemplateId] = useState<string>(initial?.templateId ?? settings.defaultTemplateId ?? '')
  const template = settings.templates.find((t) => t.id === templateId)
  const [cwd, setCwd] = useState(() => defaultTaskCwd(state))
  const [statusId, setStatusId] = useState(settings.statuses[0]?.id ?? '')
  const [groupId, setGroupId] = useState<string>('')
  const [color, setColor] = useState<string | null>(TASK_COLORS[0]!)
  const nameRef = useRef<HTMLInputElement>(null)
  const submitted = useRef(false)
  // 15f: 작업 폴더가 git 저장소면 '새 worktree 에서' — 입력이 멈추고 300ms 뒤 확인
  const [isRepo, setIsRepo] = useState(false)
  const [useWorktree, setUseWorktree] = useState(false)
  const [branch, setBranch] = useState('')
  const [busy, setBusy] = useState(false) // git 이 도는 동안 만들기 · 취소 · Esc 를 막는다
  const [error, setError] = useState<string | null>(null)

  useEffect(() => nameRef.current?.focus(), [])
  useEffect(() => {
    let alive = true
    const dir = cwd.trim()
    const timer = setTimeout(() => {
      if (!dir) return setIsRepo(false)
      window.taskminal.gitBranches([dir]).then(
        (found) => alive && setIsRepo(found[dir] != null),
        () => alive && setIsRepo(false),
      )
    }, 300)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [cwd])

  const worktreeOn = useWorktree && isRepo
  const submit = async (e?: FormEvent) => {
    e?.preventDefault()
    if (submitted.current) return // Enter 와 ⌘↩ 가 겹쳐도 한 번만
    const input = { name, cwd, templateId: template?.id ?? null, statusId, groupId: groupId || null, color }
    if (!worktreeOn) {
      submitted.current = true
      return onCreate(input)
    }
    const bad = checkBranchName(branch)
    if (bad) return setError(bad)
    submitted.current = true
    setBusy(true)
    setError(null)
    const made = await window.taskminal.gitWorktreeAdd(cwd, branch).catch((err: unknown) => ({ ok: false as const, error: String(err) }))
    setBusy(false)
    if (!made.ok) {
      submitted.current = false // 이름을 고쳐 다시
      return setError(made.error)
    }
    onCreate({ ...input, cwd: cwdLike(made.path, cwd, runtime.home) })
  }

  const onKeyDown = (e: KeyboardEvent) => {
    // 한글 조합 중의 Enter 는 글자를 확정하는 키다 — 만들기로 보내지 않는다.
    if (e.key === 'Enter' && e.metaKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void submit()
    }
  }

  const pickFolder = async () => {
    const picked = await window.taskminal.pickFolder()
    if (picked) setCwd(picked)
  }

  return (
    <Modal role="dialog" labelledBy="new-task-title" onCancel={busy ? () => {} : onCancel}>
      <form className="dialog-form" onSubmit={(e) => void submit(e)} onKeyDown={onKeyDown}>
        <h1 id="new-task-title">새 일감</h1>

        <label className="field">
          <span>이름</span>
          <input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 찍계부 서버" />
        </label>

        <div className="field">
          <label htmlFor="new-task-cwd">작업 폴더</label>
          <div className="field-row">
            <input id="new-task-cwd" value={cwd} onChange={(e) => setCwd(e.target.value)} spellCheck={false} />
            <button type="button" className="button" onClick={pickFolder}>
              폴더 선택…
            </button>
          </div>
        </div>

        {isRepo && (
          <div className="field" data-testid="new-task-worktree">
            <label className="check-row">
              <input type="checkbox" checked={useWorktree} onChange={(e) => setUseWorktree(e.target.checked)} disabled={busy} />
              새 git worktree 에서 시작
            </label>
            {useWorktree && (
              <>
                <input
                  aria-label="새 브랜치 이름"
                  value={branch}
                  onChange={(e) => {
                    setBranch(e.target.value)
                    setError(null)
                  }}
                  placeholder="예: feat/영수증-주소"
                  spellCheck={false}
                  disabled={busy}
                />
                <p className="field-hint">저장소 옆 ‘저장소이름-브랜치’ 폴더에 새 브랜치로 만들고, 일감은 그 폴더에서 열어요. 일감을 지워도 폴더 · 브랜치는 남아요.</p>
              </>
            )}
          </div>
        )}
        {(worktreeOn || error) && (
          <p className="field-error" role="alert" data-testid="new-task-error">
            {error}
          </p>
        )}

        <label className="field">
          <span>템플릿</span>
          <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} data-testid="new-task-template">
            <option value="">없음 — 셸 하나</option>
            {settings.templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>

        <div className="field-pair">
          <label className="field">
            <span>상태</span>
            <select value={statusId} onChange={(e) => setStatusId(e.target.value)}>
              {settings.statuses.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>묶음</span>
            <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
              <option value="">없음</option>
              {settings.groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <fieldset className="field">
          <legend>색</legend>
          <div className="swatches">
            {TASK_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={`swatch${color === c ? ' selected' : ''}`}
                style={{ background: c }}
                onClick={() => setColor(c)}
                aria-label={`색 ${c}`}
                aria-pressed={color === c}
              />
            ))}
            <button
              type="button"
              className={`swatch none${color === null ? ' selected' : ''}`}
              onClick={() => setColor(null)}
              aria-label="색 없음"
              aria-pressed={color === null}
            />
          </div>
        </fieldset>

        <footer className="dialog-actions">
          <button type="button" className="button" onClick={onCancel} disabled={busy}>
            취소
          </button>
          <button type="submit" className="button primary" disabled={busy}>
            {busy ? 'worktree 만드는 중…' : '만들기'} <kbd>⌘↩</kbd>
          </button>
        </footer>
      </form>
    </Modal>
  )
}
