import { useEffect, useRef } from 'react'
import { basicSetup } from 'codemirror'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { EditorState, StateEffect, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { gotoLine, openSearchPanel } from '@codemirror/search'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { sql } from '@codemirror/lang-sql'
import './CodeEditor.css'

// Cache immutable state only, never mounted views or DOM. Eviction discards undo,
// not WorkspaceEditor's separate drafts. CodeMirror history keeps ~100 events
// (commands/dist/index.js updateBranch); no workers, network loaders, or eval.
const models = new Map<string, EditorState>()
const MODEL_LIMIT = 8
const highlighting = syntaxHighlighting(HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--code-keyword)' },
  { tag: [tags.string, tags.regexp], color: 'var(--code-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--code-number)' },
  { tag: tags.comment, color: 'var(--muted)', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.typeName, tags.tagName], color: 'var(--code-function)' },
]))
function language(path: string): Extension {
  const extension = path.split('.').pop()?.toLowerCase()
  if (['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx'].includes(extension ?? '')) return javascript({ typescript: extension === 'ts' || extension === 'tsx', jsx: extension === 'jsx' || extension === 'tsx' })
  if (extension === 'json') return json()
  if (extension === 'css') return css()
  if (extension === 'html' || extension === 'htm') return html()
  if (extension === 'md' || extension === 'markdown') return markdown()
  if (extension === 'py') return python()
  if (extension === 'sql') return sql()
  return []
}

export function CodeEditor({ modelKey, path, value, onChange }: { modelKey: string; path: string; value: string; onChange(text: string): void }) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const change = useRef(onChange)
  change.current = onChange
  useEffect(() => {
    const extensions = [highlighting, basicSetup, language(path), EditorState.lineSeparator.of(value.includes('\r\n') ? '\r\n' : '\n'),
      EditorView.contentAttributes.of({ 'aria-label': '파일 편집 내용', spellcheck: 'false' }),
      EditorView.updateListener.of((update) => { if (update.docChanged) change.current(update.state.sliceDoc()) }),
    ]
    const cached = models.get(modelKey)
    models.delete(modelKey)
    const state = cached?.sliceDoc() === value ? cached : EditorState.create({ doc: value, extensions })
    // Cached extensions have an update callback from an older component instance.
    // Reconfigure it while retaining the document, selection, and history fields.
    const editor = new EditorView({ state: cached === state ? state.update({ effects: StateEffect.reconfigure.of(extensions) }).state : state, parent: host.current! })
    view.current = editor
    editor.focus()
    return () => {
      models.delete(modelKey)
      models.set(modelKey, editor.state)
      while (models.size > MODEL_LIMIT) models.delete(models.keys().next().value!)
      editor.destroy()
      view.current = null
    }
    // A root/path has its own state lifetime. External value changes are synced below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelKey])
  useEffect(() => {
    const editor = view.current
    if (editor && editor.state.sliceDoc() !== value) {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } })
    }
  }, [modelKey, value])
  return <div className="code-editor">
    <div className="work-tools-row">
      <button className="button" onClick={() => { if (view.current) openSearchPanel(view.current) }}>찾기 / 바꾸기</button>
      <button className="button" onClick={() => { if (view.current) gotoLine(view.current) }}>줄 이동</button>
      <span className="dim small">⌘D / Ctrl+D: 같은 단어에 커서 추가 · Alt+클릭: 커서 추가</span>
    </div>
    <div className="code-editor-host" ref={host} />
  </div>
}
