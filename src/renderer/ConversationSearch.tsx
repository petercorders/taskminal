import { useEffect, useId, useRef, useState } from 'react'
import type { Task } from '../shared/types'
import type { ConversationHit, ConversationQuery, ConversationResult } from '../shared/conversation-search'
import { Modal } from './Modal'
import './conversation-search.css'

interface Props {
  tasks: Task[]
  activeTaskId: string | null
  onOpen(hit: ConversationHit, signal: AbortSignal): Promise<void> | void
  onClose(): void
}

export function ConversationSearch({ tasks, activeTaskId, onOpen, onClose }: Props) {
  const titleId = useId()
  const input = useRef<HTMLInputElement>(null)
  const generation = useRef(0)
  const mounted = useRef(false)
  const opening = useRef(false)
  const pendingOpen=useRef<AbortController|null>(null)
  const cancel=()=>{pendingOpen.current?.abort();onClose()}
  const [text, setText] = useState('')
  const [taskId, setTaskId] = useState('')
  const [agent, setAgent] = useState<ConversationQuery['agent']>()
  const [archived, setArchived] = useState(false)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<ConversationResult | null>(null)

  useEffect(() => {
    const previous = document.activeElement
    mounted.current = true
    input.current?.focus()
    return () => {
      pendingOpen.current?.abort()
      mounted.current = false
      generation.current++
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])

  const invalidate = () => {
    generation.current++
    setResult(null)
    setError('')
    setLoading(true)
  }
  useEffect(() => {
    const request = ++generation.current
    setResult(null)
    setError('')
    if (!text.trim()) { setLoading(false); return }
    setLoading(true)
    const timer = setTimeout(() => {
      void window.taskminal.conversations.search({ text: text.trim(), taskId: taskId || undefined, agent, archived })
        .then((value) => { if (generation.current === request) setResult(value) })
        .catch((reason: unknown) => {
          if (generation.current === request) setError(reason instanceof Error ? reason.message : '대화를 찾지 못했습니다.')
        })
        .finally(() => { if (generation.current === request) setLoading(false) })
    }, 150)
    return () => { clearTimeout(timer); generation.current++ }
  }, [text, taskId, agent, archived])

  const open = async (hit: ConversationHit) => {
    if (opening.current) return
    opening.current = true
    setBusy(true)
    setError('')
    const snapshot = { ...hit }
    try {
      const controller=new AbortController()
      pendingOpen.current=controller
      await onOpen(snapshot,controller.signal)
      if (mounted.current) onClose()
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : '대상 대화가 사라졌거나 열 수 없습니다.')
    } finally {
      opening.current = false
      if (mounted.current) setBusy(false)
    }
  }

  return <Modal role="dialog" labelledBy={titleId} className="conversation-search" onCancel={cancel}>
    <div className="conversation-search-head"><h1 id={titleId}>대화 찾기</h1><button type="button" className="button" onClick={cancel}>닫기</button></div>
    <label className="field"><span>검색어</span><input ref={input} type="search" value={text} maxLength={500} placeholder="대화 내용 검색" onChange={(e) => { invalidate(); setText(e.target.value) }} /></label>
    <div className="conversation-search-filters">
      <label className="field"><span>일감</span><select value={taskId} onChange={(e) => { invalidate(); setTaskId(e.target.value) }}>
        <option value="">모든 일감</option>
        {tasks.map((task) => <option key={task.id} value={task.id}>{task.name}{task.id === activeTaskId ? ' (현재 일감)' : ''}</option>)}
        {taskId && !tasks.some((task) => task.id === taskId) && <option value={taskId}>사라진 일감</option>}
      </select></label>
      <label className="field"><span>에이전트</span><select value={agent ?? ''} onChange={(e) => { invalidate(); setAgent(e.target.value === 'claude' || e.target.value === 'codex' ? e.target.value : undefined) }}>
        <option value="">모두</option><option value="claude">Claude</option><option value="codex">Codex</option>
      </select></label>
    </div>
    <label className="conversation-search-archived"><input type="checkbox" checked={archived} onChange={(e) => { invalidate(); setArchived(e.target.checked) }} />보관한 일감 포함</label>
    {error && <div role="alert" className="field-error">{error}</div>}
    {result?.errors.map((message, index) => <div role="alert" className="field-error" key={index}>{message}</div>)}
    <div role="status" className="conversation-search-status">{loading ? '검색 중…' : !text.trim() ? '찾을 내용을 입력하세요.' : result ? result.hits.length ? `${result.hits.length}개 결과${result.more ? ' · 결과가 더 있습니다. 검색 범위를 좁혀 주세요.' : ''}` : result.errors.length ? '일부 기록을 읽지 못했습니다. 검색 범위를 바꾸어 다시 시도하세요.' : '검색 결과가 없습니다.' : error ? '검색하지 못했습니다. 검색어를 바꾸어 다시 시도하세요.' : ''}</div>
    <ul className="conversation-search-results" aria-label="대화 검색 결과" aria-busy={loading || busy}>
      {result?.hits.map((hit, index) => <li key={`${hit.paneId}:${hit.fingerprint}:${index}`}><button type="button" disabled={busy} onClick={() => { void open(hit) }}>
        <span className="conversation-search-meta">{hit.taskName} · {hit.agent === 'claude' ? 'Claude' : 'Codex'} · {hit.role === 'user' ? '나' : '응답'}{hit.archived ? ' · 보관됨' : ''} · {new Date(hit.at).toLocaleString()}</span>
        <span className="conversation-search-snippet">{hit.snippet}</span>
      </button></li>)}
    </ul>
  </Modal>
}
