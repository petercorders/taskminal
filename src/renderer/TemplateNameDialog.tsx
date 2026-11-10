import { useEffect, useRef, useState } from 'react'
import { templateNameError } from '../shared/model'
import { Modal } from './Modal'

interface Props {
  /** 무엇을 저장하는지 — '탭' · '일감' */
  what: string
  initialName: string
  onSave(name: string): void
  onCancel(): void
}

/** "이 탭/일감을 템플릿으로 저장" — 이름만 묻는다. 저장은 한 번만(같은 프레임의 두 번 클릭 · Enter 가 템플릿을 둘 만들지 않게). */
export function TemplateNameDialog({ what, initialName, onSave, onCancel }: Props) {
  const [name, setName] = useState(initialName)
  const inputRef = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  // 빈 이름 · 예약어(저장 파일 검증이 버린다)는 저장을 막고 이유를 보인다 — 빈 칸은 이미 알 만하니 이유를 띄우지 않는다
  const error = templateNameError(name)
  const save = () => {
    if (done.current || error) return
    done.current = true
    onSave(name)
  }

  return (
    <Modal role="dialog" labelledBy="template-name-title" className="narrow" onCancel={onCancel}>
      <form
        className="dialog-form"
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <h1 id="template-name-title">{what}을 템플릿으로 저장</h1>
        <p className="dialog-message">탭 · 분할 · 시작 명령 · 폴더(일감 폴더 기준)를 저장해요. 새 일감이나 탭 줄의 ▾ 에서 고를 수 있어요.</p>
        <label className="field">
          <span>템플릿 이름</span>
          <input
            ref={inputRef}
            value={name}
            maxLength={60}
            spellCheck={false}
            aria-invalid={!!error && !!name.trim()}
            aria-describedby="template-name-error"
            onChange={(e) => setName(e.target.value)}
            data-testid="template-name"
          />
        </label>
        <p id="template-name-error" className="field-error" role="alert" data-testid="template-name-error">
          {name.trim() ? error : null}
        </p>
        <footer className="dialog-actions">
          <button type="button" className="button" onClick={onCancel}>
            취소
          </button>
          <button type="submit" className="button primary" disabled={!!error} data-testid="template-name-save">
            저장
          </button>
        </footer>
      </form>
    </Modal>
  )
}
