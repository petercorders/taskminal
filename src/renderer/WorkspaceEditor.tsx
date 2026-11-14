import { useEffect, useRef, useSyncExternalStore } from 'react'
import './WorkspaceEditor.css'

type EditableFile = { path: string; text: string; signature: string }
type Draft = {
  base?: EditableFile
  text: string
  busy: boolean
  uncertain?: boolean
  conflict?: EditableFile
  error: string
  status: string
}
// Raw editable content lives only in this renderer's memory. Closing a panel or
// navigating files retains drafts; restarting/reloading the renderer clears them.
const drafts = new Map<string, Draft>()
const listeners = new Set<() => void>()
function update(key: string, patch: Partial<Draft>) {
  const old = drafts.get(key)
  if (!old) return
  drafts.set(key, { ...old, ...patch })
  listeners.forEach((notify) => notify())
}
function subscribe(notify: () => void) {
  listeners.add(notify)
  return () => { listeners.delete(notify) }
}

export function WorkspaceEditor({ root, path, onClose }: { root: string; path: string; onClose(): void }) {
  const key = JSON.stringify([root, path])
  if (!drafts.has(key)) drafts.set(key, { text: '', busy: false, error: '', status: '' })
  const draft = useSyncExternalStore(subscribe, () => drafts.get(key)!)
  const input = useRef<HTMLTextAreaElement>(null)
  const focusedKey = useRef<string | null>(null)
  const dirty = !!draft.base && draft.text !== draft.base.text
  async function read() {
    const snapshot = drafts.get(key)!
    if (snapshot.busy) return
    update(key, { busy: true, error: '', status: '원문 읽는 중…' })
    try {
      const current = await window.taskminal.workspace.edit(root, path)
      const latest = drafts.get(key)!
      if (latest.base && latest.text !== latest.base.text) {
        update(key, { conflict: current, uncertain: false, status: '초안을 보존했어요. 최신 파일과 비교해 주세요.' })
      } else update(key, { base: current, text: current.text, conflict: undefined, uncertain: false, status: '최신 파일을 읽었어요.' })
    } catch {
      update(key, { error: '파일을 읽지 못했어요. 파일·권한·크기와 경로를 확인한 뒤 다시 읽어 주세요.', status: '' })
    } finally { update(key, { busy: false }) }
  }
  async function save() {
    const snapshot = drafts.get(key)!
    if (!snapshot.base || snapshot.busy || snapshot.conflict || snapshot.uncertain || snapshot.text === snapshot.base.text) return
    update(key, { busy: true, error: '', status: '저장 중…' })
    try {
      const result = await window.taskminal.workspace.save(root, path, { signature: snapshot.base.signature, text: snapshot.text })
      if (result.ok) {
        // Keep keystrokes entered after Save. Only the captured snapshot became
        // the new disk baseline; late replies never replace the current text.
        update(key, { base: result.file, status: drafts.get(key)!.text === snapshot.text ? '저장했어요.' : '저장했어요. 이후 입력은 아직 저장하지 않았어요.' })
      } else update(key, { conflict: result.current, status: '', error: '파일이 바뀌어 저장하지 않았어요. 내 초안을 보존했어요.' })
    } catch {
      update(key, { uncertain: true, error: '저장 결과를 확인하지 못했어요. 초안을 보존했어요. 다시 읽기로 디스크 내용을 확인해 주세요.', status: '' })
    } finally { update(key, { busy: false }) }
  }
  useEffect(() => {
    if (!drafts.get(key)!.base) void read()
    // Each key owns its pending operation, including while this view is closed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  useEffect(() => {
    if (!draft.base || focusedKey.current === key) return
    focusedKey.current = key
    input.current?.focus()
  }, [key, draft.base])
  return (
    <section className="workspace-editor" aria-label={`${path} 편집`} data-testid="workspace-editor" onKeyDown={(event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        event.stopPropagation()
        void save()
      }
    }}>
      <div className="work-tools-row">
        <strong className="work-path">{path}</strong>
        <span>{dirty ? '저장하지 않은 초안' : '저장된 내용'}</span>
        <button className="button primary" disabled={!dirty || draft.busy || !!draft.conflict || draft.uncertain} onClick={() => void save()}>저장</button>
        <button className="button" disabled={draft.busy} onClick={() => void read()}>다시 읽기</button>
        <button className="button" onClick={onClose}>미리보기로 돌아가기</button>
      </div>
      <p className="dim small">편집에는 가리지 않은 원문이 표시됩니다. ⌘S / Ctrl+S로 저장하세요. 초안은 파일 이동·패널 닫기 동안 유지되며 앱 종료·새로고침 때 사라집니다.</p>
      {draft.error && <p role="alert">{draft.error}</p>}
      {draft.status && <p role="status">{draft.status}</p>}
      <label className="workspace-editor-label">
        내 편집 초안
        <textarea ref={input} aria-label="파일 편집 내용" spellCheck={false} value={draft.text} disabled={!draft.base} onChange={(event) => update(key, { text: event.target.value, status: '' })} />
      </label>
      {draft.conflict && <div className="workspace-editor-conflict">
        <p>최신 파일과 초안을 비교한 뒤 선택하세요. 준비 후에도 저장 버튼을 눌러야 파일이 바뀝니다.</p>
        <label className="workspace-editor-label">디스크 최신 내용<textarea aria-label="디스크 최신 내용" readOnly value={draft.conflict.text} /></label>
        <div className="work-tools-row">
          <button className="button" disabled={draft.busy} onClick={() => update(key, { base: draft.conflict, conflict: undefined, error: '', status: '초안을 유지하고 최신 파일 기준으로 준비했어요. 내용을 확인한 뒤 저장하세요.' })}>내 초안을 최신 파일 위에 저장하도록 준비</button>
          <button className="button" disabled={draft.busy} onClick={() => update(key, { base: draft.conflict, text: draft.conflict!.text, conflict: undefined, error: '', status: '초안을 버리고 확인한 최신 내용으로 바꿨어요.' })}>초안 버리고 최신 내용 사용</button>
        </div>
      </div>}
      {dirty && !draft.conflict && <button className="button" disabled={draft.busy} onClick={() => update(key, { text: draft.base!.text, error: '', status: '초안을 버리고 마지막으로 확인한 내용으로 되돌렸어요.' })}>초안 버리고 되돌리기</button>}
    </section>
  )
}
