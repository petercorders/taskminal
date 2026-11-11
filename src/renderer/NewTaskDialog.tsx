import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Modal } from './Modal'
import { defaultTaskCwd } from '../shared/model'
import { cwdLike } from '../shared/cwd'
import { checkBranchName } from '../shared/worktree'
import { isRemotePath, isSshHost } from '../shared/remote'
import { runtime } from './runtime'
import type { AppState, NewTaskInput, NewTaskStart } from '../shared/types'

const START_CHOICES: readonly (readonly [NewTaskStart, string])[] = [
  ['chat-claude', 'Claude 대화'],
  ['chat-codex', 'Codex 대화'],
  ['terminal', '터미널'],
]

export const TASK_COLORS = ['#5b9cf5', '#7ccf8a', '#e5b567', '#e07a7a', '#b48ef0', '#5ec4c4']

/** 팔레트에서 열 때 미리 채우는 값: 맞는 게 없던 찾기 글자(이름) · 고른 템플릿 */
export interface NewTaskInitial {
  name?: string
  templateId?: string
  /** 빈 화면의 '터미널로 시작' — 없으면 설정의 새 일감 시작 */
  start?: NewTaskStart
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
  // 확인이 끝난 저장소 폴더 — 폴더를 바꾼 직후(확인 전)에는 worktree 로 만들지 않는다 (15f 리뷰)
  const [repoDir, setRepoDir] = useState<string | null>(null)
  const [useWorktree, setUseWorktree] = useState(false)
  const [branch, setBranch] = useState('')
  const [busy, setBusy] = useState(false) // git 이 도는 동안 만들기 · 취소 · Esc 를 막는다
  const [error, setError] = useState<string | null>(null)
  // 25단계 원격: 어디서 — 이 Mac ⌥1 / 원격 (SSH) ⌥2. 호스트 목록은 열 때마다 ~/.ssh/config 를 다시 읽는다(main 이 읽기만)
  const [where, setWhere] = useState<'local' | 'remote'>('local')
  const [host, setHost] = useState('')
  const [remoteDir, setRemoteDir] = useState('~')
  const [tmux, setTmux] = useState(true)
  const [hosts, setHosts] = useState<string[]>([])
  const remote = where === 'remote'
  // 26단계: 무엇으로 시작 — 처음 값은 설정(일반 › 새 일감 시작)을 연 순간에 떠 둔다. 템플릿을 고르면 템플릿대로.
  const [start, setStart] = useState<NewTaskStart>(initial?.start ?? settings.newTaskStart)

  useEffect(() => nameRef.current?.focus(), [])
  useEffect(() => {
    let alive = true
    window.taskminal.sshHosts().then(
      (h) => alive && setHosts(h),
      () => {},
    )
    return () => void (alive = false)
  }, [])
  useEffect(() => {
    let alive = true
    const dir = cwd.trim()
    const timer = setTimeout(() => {
      if (!dir) return setRepoDir(null)
      window.taskminal.gitBranches([dir]).then(
        (found) => alive && setRepoDir(found[dir] != null ? dir : null),
        () => alive && setRepoDir(null),
      )
    }, 300)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [cwd])

  const isRepo = repoDir !== null
  const worktreeOn = useWorktree && repoDir === cwd.trim()
  const submit = async (e?: FormEvent) => {
    e?.preventDefault()
    if (submitted.current) return // Enter 와 ⌘↩ 가 겹쳐도 한 번만
    if (remote) {
      const h = host.trim()
      const dir = remoteDir.trim() || '~'
      if (!isSshHost(h)) return setError('호스트를 확인하세요 — ~/.ssh/config 의 Host 이름이나 user@host (포트는 ~/.ssh/config 의 Port 로)')
      if (!isRemotePath(dir)) return setError('원격 폴더를 확인하세요')
      submitted.current = true
      return onCreate({ name: name.trim() || h, cwd: dir, templateId: null, statusId, groupId: groupId || null, color, host: h, remoteTmux: tmux })
    }
    const input = { name, cwd, templateId: template?.id ?? null, statusId, groupId: groupId || null, color, start }
    if (!worktreeOn) {
      submitted.current = true
      return onCreate(input)
    }
    const bad = checkBranchName(branch)
    if (bad) return setError(bad)
    submitted.current = true
    setBusy(true)
    setError(null)
    const made = await window.taskminal.gitWorktreeAdd(cwd.trim(), branch).catch((err: unknown) => ({ ok: false as const, error: String(err) }))
    setBusy(false)
    if (!made.ok) {
      submitted.current = false // 이름을 고쳐 다시
      return setError(made.error)
    }
    onCreate({ ...input, cwd: cwdLike(made.path, cwd.trim(), runtime.home) })
  }

  const onKeyDown = (e: KeyboardEvent) => {
    // 한글 조합 중의 Enter 는 글자를 확정하는 키다 — 만들기로 보내지 않는다.
    if (e.key === 'Enter' && e.metaKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void submit()
    }
    // ⌥1 · ⌥2 — 글쇠 자리(code)로 본다: ⌥ 를 누르면 key 는 '¡' · '™' 가 된다
    if (e.altKey && !e.metaKey && (e.code === 'Digit1' || e.code === 'Digit2')) {
      e.preventDefault()
      setWhere(e.code === 'Digit1' ? 'local' : 'remote')
      setError(null)
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
        {/* git 이 도는 동안 모든 칸을 막는다 — 잡아 둔 값으로 만들므로 그 사이 고친 값이 말없이 버려지지 않게 (15f 리뷰) */}
        <fieldset className="dialog-body" disabled={busy}>
          <label className="field">
            <span>이름</span>
            <input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 찍계부 서버" />
          </label>

          <div className="field">
            <span>어디서</span>
            <div className="new-task-where" role="group" aria-label="어디서">
              <button type="button" className="button" aria-pressed={!remote} onClick={() => (setWhere('local'), setError(null))} data-testid="where-local">
                이 Mac <kbd>⌥1</kbd>
              </button>
              <button type="button" className="button" aria-pressed={remote} onClick={() => (setWhere('remote'), setError(null))} data-testid="where-remote">
                원격 (SSH) <kbd>⌥2</kbd>
              </button>
            </div>
          </div>

          {remote ? (
            <>
              <div className="field">
                <label htmlFor="new-task-host">호스트</label>
                <input
                  id="new-task-host"
                  list="new-task-hosts"
                  value={host}
                  onChange={(e) => (setHost(e.target.value), setError(null))}
                  placeholder={hosts[0] ? `예: ${hosts[0]}` : '예: nas 또는 peter@192.168.0.10'}
                  spellCheck={false}
                  autoCapitalize="off"
                />
                <datalist id="new-task-hosts">
                  {hosts.map((h) => (
                    <option key={h} value={h} />
                  ))}
                </datalist>
                <p className="field-hint">
                  {hosts.length ? `~/.ssh/config 의 Host ${hosts.length}개 — ↑↓ 로 고르기. ` : ''}
                  앱은 비밀번호 · 키를 갖지 않아요 — ssh 설정 · ssh-agent 를 그대로 써요.
                </p>
              </div>
              <label className="field">
                <span>원격 폴더</span>
                <input aria-label="원격 폴더" value={remoteDir} onChange={(e) => (setRemoteDir(e.target.value), setError(null))} spellCheck={false} />
              </label>
              <label className="check-row">
                <input type="checkbox" checked={tmux} onChange={(e) => setTmux(e.target.checked)} data-testid="new-task-tmux" />
                끊겨도 계속 돌게 (서버의 tmux 사용 — 없으면 그냥 셸)
              </label>
            </>
          ) : (
            <div className="field">
              <label htmlFor="new-task-cwd">작업 폴더</label>
              <div className="field-row">
                <input id="new-task-cwd" value={cwd} onChange={(e) => setCwd(e.target.value)} spellCheck={false} />
                <button type="button" className="button" onClick={pickFolder}>
                  폴더 선택…
                </button>
              </div>
            </div>
          )}

          {!remote && isRepo && (
            <div className="field" data-testid="new-task-worktree">
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={useWorktree}
                  onChange={(e) => {
                    setUseWorktree(e.target.checked)
                    setError(null)
                  }}
                />
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
                  />
                  <p className="field-hint">저장소 옆 ‘저장소이름-브랜치’ 폴더에 새 브랜치로 만들고, 일감은 그 폴더에서 열어요. 일감을 지워도 폴더 · 브랜치는 남아요.</p>
                </>
              )}
            </div>
          )}
          {error && (
            <p className="field-error" role="alert" data-testid="new-task-error">
              {error}
            </p>
          )}

          {!remote && !template && (
            <div className="field">
              <span>시작</span>
              <div className="new-task-start" role="group" aria-label="시작">
                {START_CHOICES.map(([value, label]) => (
                  <button key={value} type="button" className="button" aria-pressed={start === value} onClick={() => setStart(value)} data-testid={`start-${value}`}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {!remote && (
            <label className="field">
              <span>템플릿</span>
              <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} data-testid="new-task-template">
                <option value="">없음 — 위 ‘시작’ 대로</option>
                {settings.templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
          )}

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
