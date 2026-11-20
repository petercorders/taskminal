import { useRef, useState } from 'react'
import type { GitWorkflowApi } from '../shared/git-workflow'
import { dependencyOrder, parsePrLinks, type PrDependency } from '../shared/pr-dependencies'
import { ipcMessage } from './ipc-message'

const stateText = { open: '열림', closed: '닫힘', merged: '병합됨', unknown: '조회 실패' }
const checkText = { passed: '체크 통과', pending: '체크 진행 중', failed: '체크 실패', none: '체크 확인 안 됨' }
const shortLink = (url: string) => url.replace('https://github.com/', '').replace('/pull/', ' #')
function savedLinks(key: string): string {
  try { return parsePrLinks(JSON.parse(localStorage.getItem(key) ?? '[]')).map(row => row.url).join('\n') }
  catch { return '' }
}

export function PrDependencies({ taskId, dir, load, onOpenUrl }: {
  taskId: string; dir: string; load: GitWorkflowApi['dependencies']; onOpenUrl?(url: string): void
}) {
  const key = 'taskminal.pr-dependencies.' + taskId
  const [draft, setDraft] = useState(() => savedLinks(key))
  const [rows, setRows] = useState<PrDependency[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const read = async () => {
    if (lock.current) return
    lock.current = true
    setBusy(true); setError(''); setRows([])
    try {
      const urls = parsePrLinks(draft.split('\n').map(value => value.trim()).filter(Boolean)).map(row => row.url)
      try { localStorage.setItem(key, JSON.stringify(urls)) }
      catch { setError('주소를 이 일감에 보관하지 못했어요. 이번 상태 조회는 계속합니다.') }
      if (urls.length) setRows(await load(dir, urls))
    } catch (error) {
      setError(ipcMessage(error, '연결한 PR 상태를 읽지 못했어요.'))
    } finally { lock.current = false; setBusy(false) }
  }

  return <details className="git-workflow-create">
    <summary>저장소 간 PR 순서</summary>
    <p className="small dim">선행 PR부터 GitHub PR 주소를 한 줄에 하나씩 적으세요. 앞의 모든 PR이 병합되고 체크가 통과했는지 확인합니다.</p>
    <label className="git-workflow-field">PR 주소 · 위에서 아래 순서
      <textarea rows={4} value={draft} maxLength={2410} disabled={busy} onChange={event => { setDraft(event.target.value); setRows([]); setError('') }} />
    </label>
    <button type="button" className="button" disabled={busy} onClick={() => void read()}>{busy ? '상태 읽는 중…' : '목록 보관하고 상태 읽기'}</button>
    {error && <p role="alert">{error}</p>}
    {rows.length > 0 && <ol className="worktree-dependencies">{dependencyOrder(rows).map(row => <li key={row.url}>
      {onOpenUrl ? <button className="link" type="button" onClick={() => onOpenUrl(row.url)}>{shortLink(row.url)}</button> : shortLink(row.url)}
      {row.title && <> · {row.title}</>} · {stateText[row.state]} · {checkText[row.checks]}
      {row.blockedBy && <div>검토 보류 · 선행 {shortLink(row.blockedBy)} 확인 필요</div>}
    </li>)}</ol>}
  </details>
}
