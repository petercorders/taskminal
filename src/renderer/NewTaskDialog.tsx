import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Modal } from './Modal'
import type { NewTaskInput, Settings } from '../shared/types'

export const TASK_COLORS = ['#5b9cf5', '#7ccf8a', '#e5b567', '#e07a7a', '#b48ef0', '#5ec4c4']

/** 팔레트에서 열 때 미리 채우는 값: 맞는 게 없던 찾기 글자(이름) · 고른 템플릿 */
export interface NewTaskInitial {
  name?: string
  templateId?: string
}

interface Props {
  settings: Settings
  initial?: NewTaskInitial
  onCreate(input: NewTaskInput): void
  onCancel(): void
}

/** 새 일감: 이름 · 작업 폴더 · 상태 · 묶음 · 색. 템플릿 카드는 12단계, 새 묶음 만들기는 11단계. */
export function NewTaskDialog({ settings, initial, onCreate, onCancel }: Props) {
  const [name, setName] = useState(initial?.name ?? '')
  const template = settings.templates.find((t) => t.id === initial?.templateId)
  const [cwd, setCwd] = useState('~')
  const [statusId, setStatusId] = useState(settings.statuses[0]?.id ?? '')
  const [groupId, setGroupId] = useState<string>('')
  const [color, setColor] = useState<string | null>(TASK_COLORS[0]!)
  const nameRef = useRef<HTMLInputElement>(null)
  const submitted = useRef(false)

  useEffect(() => nameRef.current?.focus(), [])

  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    if (submitted.current) return // Enter 와 ⌘↩ 가 겹쳐도 한 번만
    submitted.current = true
    onCreate({ name, cwd, templateId: template?.id ?? null, statusId, groupId: groupId || null, color })
  }

  const onKeyDown = (e: KeyboardEvent) => {
    // 한글 조합 중의 Enter 는 글자를 확정하는 키다 — 만들기로 보내지 않는다.
    if (e.key === 'Enter' && e.metaKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  const pickFolder = async () => {
    const picked = await window.taskminal.pickFolder()
    if (picked) setCwd(picked)
  }

  return (
    <Modal role="dialog" labelledBy="new-task-title" onCancel={onCancel}>
      <form className="dialog-form" onSubmit={submit} onKeyDown={onKeyDown}>
        <h1 id="new-task-title">새 일감</h1>
        {template && (
          <p className="dialog-message" data-testid="new-task-template">
            템플릿: {template.name} — 탭 · 분할 · 시작 명령(한 번만)이 이 템플릿대로 만들어집니다
          </p>
        )}

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
          <button type="button" className="button" onClick={onCancel}>
            취소
          </button>
          <button type="submit" className="button primary">
            만들기 <kbd>⌘↩</kbd>
          </button>
        </footer>
      </form>
    </Modal>
  )
}
