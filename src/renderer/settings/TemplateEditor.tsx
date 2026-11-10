import { useEffect, useMemo, useRef, useState } from 'react'
import { parseTemplateJson, templateToJson } from '../../shared/template-json'
import type { Template } from '../../shared/types'
import { Modal } from '../Modal'

interface Props {
  /** 고칠 템플릿. null 이면 새 템플릿 */
  template: Template | null
  onSave(value: Pick<Template, 'name' | 'tabs'>): void
  onCancel(): void
}

const NEW_TEMPLATE: Pick<Template, 'name' | 'tabs'> = {
  name: '새 템플릿',
  tabs: [{ title: '작업', layout: { split: 'right', ratio: 0.5, a: { pane: { command: 'claude' } }, b: { pane: {} } } }],
}

const HELP = `"pane": { "command": 시작 명령, "cwd": 일감 폴더 기준 폴더 } · "split": "right"(좌우) | "down"(위아래), "ratio": 0.1~0.9, "a" · "b"`

/** 템플릿 JSON 편집기 — 고칠 때마다 검사해 오류를 줄 번호와 함께 보이고, 오류가 있으면 저장을 막는다. */
export function TemplateEditor({ template, onSave, onCancel }: Props) {
  const [text, setText] = useState(() => templateToJson(template ?? NEW_TEMPLATE))
  const result = useMemo(() => parseTemplateJson(text), [text])
  const ref = useRef<HTMLTextAreaElement>(null)
  const done = useRef(false)
  useEffect(() => ref.current?.focus(), [])

  const save = () => {
    if (done.current || !result.ok) return
    done.current = true
    onSave(result.value)
  }

  // 설정 창도 Esc 로 닫히므로 편집기의 Esc 가 설정 창까지 가지 않게 여기서 멈춘다
  return (
    <div onKeyDown={(e) => e.key === 'Escape' && e.stopPropagation()}>
      <Modal role="dialog" labelledBy="template-editor-title" className="wide" onCancel={onCancel}>
        <h1 id="template-editor-title">{template ? `템플릿 편집 — ${template.name}` : '새 템플릿'}</h1>
        <p className="dialog-message template-help">{HELP}</p>
        <textarea
          ref={ref}
          className="template-json"
          value={text}
          spellCheck={false}
          aria-label="템플릿 JSON"
          aria-invalid={!result.ok}
          aria-describedby="template-errors"
          data-testid="template-json"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // ⌘↩ 로 저장
            if (e.key === 'Enter' && e.metaKey) {
              e.preventDefault()
              save()
            }
          }}
        />
        <ul id="template-errors" className="template-errors" aria-live="polite" data-testid="template-errors">
          {!result.ok &&
            result.errors.map((err, i) => (
              <li key={i}>
                <strong>{err.line}번째 줄</strong> {err.message}
              </li>
            ))}
        </ul>
        <footer className="dialog-actions">
          <button type="button" className="button" onClick={onCancel}>
            취소
          </button>
          <button type="button" className="button primary" disabled={!result.ok} onClick={save} data-testid="template-save">
            저장 ⌘↩
          </button>
        </footer>
      </Modal>
    </div>
  )
}
