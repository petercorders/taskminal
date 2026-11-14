import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { RemoteApi, RemoteConnection, RemoteWorkspace, RemoteGit } from '../shared/remote-workspace'
import type { EditableFile } from '../shared/workspace'
import { foldBlocks, chatStatus, type ChatBlock, type ChatDecision } from '../shared/chat'
import { ConfirmDialog } from './ConfirmDialog'
import './RemotePanel.css'

type Tab = 'files' | 'terminal' | 'chat' | 'git'
interface FileDraft { base: EditableFile; text: string; conflict?: EditableFile; busy?: boolean; uncertain?: boolean }
interface PanelState {
  url: string; connection: RemoteConnection | null; workspaces: RemoteWorkspace[]; workspace: string
  relative: string; tab: Tab; directory: string; file: string; terminal: string; chat: string
  lastResource?: string; lastRequest?: string
}
let panel: PanelState = { url: '', connection: null, workspaces: [], workspace: '', relative: '.', tab: 'files', directory: '', file: '', terminal: '', chat: '' }
const files = new Map<string, FileDraft>()
const inputs = new Map<string, string>()
const requestIds = new Map<string, string>()
const listeners = new Set<() => void>()
let revision = 0
let writing = false
const fileReads = new Set<string>()
const remoteReads = new Map<string, Promise<void>>()
const emit = () => { revision++; listeners.forEach((notify) => notify()) }
const subscribe = (notify: () => void) => { listeners.add(notify); return () => { listeners.delete(notify) } }
const patch = (change: Partial<PanelState>) => { panel = { ...panel, ...change }; emit() }
function request(key: string) { const id = requestIds.get(key) ?? crypto.randomUUID(); requestIds.set(key, id); panel = { ...panel, lastRequest: id }; emit(); return id }
function input(key: string, text: string) { inputs.set(key, text); emit() }

function RemoteQuestion({ block, busy, onAnswer }: { block: Extract<ChatBlock, { kind: 'question' }>; busy: boolean; onAnswer(decision: ChatDecision): void }) {
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({})
  return <form className="remote-card" onSubmit={(event) => { event.preventDefault(); onAnswer({ how: 'answer', answers }) }}>
    {block.questions.map((question, index) => <fieldset key={index} disabled={busy || !!block.answer}>
      <legend>{question.question}</legend>
      {question.options.map((option) => {
        const chosen = answers[question.question]
        const selected = Array.isArray(chosen) ? chosen.includes(option.label) : chosen === option.label
        return <label key={option.label}><input type={question.multi ? 'checkbox' : 'radio'} name={`${block.id}-${index}`} checked={selected} onChange={(event) => {
          const previous = Array.isArray(chosen) ? chosen : []
          setAnswers({ ...answers, [question.question]: question.multi ? event.target.checked ? [...previous, option.label] : previous.filter((label) => label !== option.label) : option.label })
        }} /> {option.label} {option.description}</label>
      })}
      {!question.multi && <label className="field"><span>직접 답변</span><input value={typeof answers[question.question] === 'string' && !question.options.some((option) => option.label === answers[question.question]) ? answers[question.question] as string : ''} onChange={(event) => setAnswers({ ...answers, [question.question]: event.target.value })} /></label>}
    </fieldset>)}
    {block.answer ? <p>응답 처리: {block.answer}</p> : <button className="button" disabled={busy || block.questions.some((question) => { const value = answers[question.question]; return Array.isArray(value) ? !value.length : !value?.trim() })}>질문에 답하기</button>}
  </form>
}

export function RemotePanel({ api }: { api: RemoteApi }) {
  useSyncExternalStore(subscribe, () => revision)
  const [token, setToken] = useState('')
  const busy = writing
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [entries, setEntries] = useState<Awaited<ReturnType<RemoteApi['files']>>>([])
  const [output, setOutput] = useState('')
  const [events, setEvents] = useState<Awaited<ReturnType<RemoteApi['history']>>['events']>([])
  const [git, setGit] = useState<RemoteGit | null>(null)
  const [loadedChat, setLoadedChat] = useState('')
  const [stop, setStop] = useState<{ connection: string; workspace: string; session: string } | null>(null)
  const [retry, setRetry] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const mounted = useRef(false)
  const scope = JSON.stringify([panel.connection?.id, panel.workspace, panel.tab, panel.directory, panel.file, panel.terminal, panel.chat])
  const current = useRef(scope)
  const displayScope = useRef(scope)
  current.current = scope
  const mutation = useRef(0)
  const workspace = panel.workspaces.find((item) => item.id === panel.workspace)
  const server = panel.connection?.url ?? panel.url.trim()
  const fileKey = JSON.stringify([server, panel.workspace, panel.file])
  const terminalKey = JSON.stringify([server, panel.workspace, 'terminal', panel.terminal])
  const chatKey = JSON.stringify([server, panel.workspace, 'chat', panel.chat])
  const draft = files.get(fileKey)
  const historyKey = JSON.stringify([panel.connection?.id, panel.workspace, panel.chat])
  const historyReady = loadedChat === historyKey
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const relevant = (snapshot: string) => mounted.current && current.current === snapshot
  function report(message: string) { if (mounted.current) setStatus(message) }
  async function write(job: () => Promise<void>) {
    if (writing) return
    writing = true
    mutation.current++
    emit(); setError(''); setStatus('요청 처리 중…')
    try { await job() }
    catch { if (mounted.current) { setError('요청 결과를 확인하지 못했어요. 다시 읽어 확인한 뒤 같은 입력으로 재시도하세요.'); setStatus('') } }
    finally {
      mutation.current++
      writing = false
      emit()
      if (mounted.current) setRefresh((value) => value + 1)
    }
  }
  async function loadWorkspaces(connection = panel.connection) {
    if (!connection) return
    const result = await api.workspaces(connection.id)
    if (panel.connection?.id !== connection.id) return
    patch({ workspaces: result })
  }
  useEffect(() => {
    const connection = panel.connection
    if (!connection) return
    let alive = true
    const snapshot = scope
    const version = mutation.current
    const valid = () => alive && relevant(snapshot) && version === mutation.current && !writing
    let timer: ReturnType<typeof setTimeout> | undefined
    const readKey = JSON.stringify([connection.id, panel.workspace, panel.tab, panel.directory, panel.terminal, panel.chat])
    const selected = { workspace: panel.workspace, tab: panel.tab, directory: panel.directory, terminal: panel.terminal, chat: panel.chat }
    const read = async () => {
      if (!alive || document.hidden || writing || !selected.workspace || (selected.tab === 'terminal' && !selected.terminal) || (selected.tab === 'chat' && !selected.chat)) return
      const pending = remoteReads.get(readKey)
      if (pending) { await pending; if (valid()) timer = setTimeout(() => { void read() }, 0); return }
      const operation = Promise.resolve().then(async () => {
        try {
          if (!selected.workspace) return
          if (selected.tab === 'files') { const result = await api.files(connection.id, selected.workspace, selected.directory); if (valid()) setEntries(result) }
          if (selected.tab === 'git') { const result = await api.git(connection.id, selected.workspace); if (valid()) setGit(result) }
          if (selected.tab === 'terminal' && selected.terminal) { const result = await api.tail(connection.id, selected.workspace, selected.terminal); if (valid()) { setOutput(result.data); if (result.exited !== undefined) setStatus(`셸이 끝났어요. 종료 코드 ${result.exited}`) } }
          if (selected.tab === 'chat' && selected.chat) { const result = await api.history(connection.id, selected.workspace, selected.chat); if (valid()) { setEvents(result.events); setLoadedChat(JSON.stringify([connection.id, selected.workspace, selected.chat])) } }
        } catch { if (valid()) setError('원격 내용을 읽지 못했어요. 연결과 서버 상태를 확인하고 다시 읽어 주세요.') }
        finally { remoteReads.delete(readKey) }
      })
      remoteReads.set(readKey, operation)
      await operation
      if (alive && (selected.tab === 'terminal' || selected.tab === 'chat')) timer = setTimeout(() => { void read() }, 1500)
    }
    if (displayScope.current !== scope) {
      displayScope.current = scope
      setEntries([]); setOutput(''); setEvents([]); setLoadedChat(''); setGit(null)
    }
    void read()
    const visible = () => { if (!document.hidden && !remoteReads.has(readKey)) { clearTimeout(timer); void read() } }
    document.addEventListener('visibilitychange', visible)
    return () => { alive = false; clearTimeout(timer); document.removeEventListener('visibilitychange', visible) }
  }, [api, scope, refresh, busy])
  async function connect() {
    const url = panel.url.trim(), secret = token
    setToken('')
    await write(async () => {
      const connection = await api.connect(url, secret)
      if (!mounted.current) { await api.disconnect(connection.id); return }
      patch({ connection, url: connection.url, workspaces: [], workspace: '', directory: '', file: '', terminal: '', chat: '' })
      await loadWorkspaces(connection)
      report('연결했어요. 서버의 작업 공간과 세션을 선택하세요.')
    })
  }
  function chooseWorkspace(id: string) {
    const selected = panel.workspaces.find((item) => item.id === id)
    patch({ workspace: id, directory: '', file: '', terminal: selected?.sessions[0]?.id ?? '', chat: selected?.chats[0]?.id ?? '' })
    setError(''); setStatus('')
  }
  async function openFile(path: string) {
    const connection = panel.connection, selected = panel.workspace
    if (!connection || writing) return
    patch({ file: path })
    const identity = JSON.stringify([connection.url, selected, path])
    if (files.has(identity) || fileReads.has(identity)) return
    fileReads.add(identity)
    const snapshot = JSON.stringify([connection.id, selected, path])
    try {
      const result = await api.read(connection.id, selected, path)
      // A late read populates its own draft only, never the newly selected file.
      if (!files.has(identity)) { files.set(identity, { base: result, text: result.text }); emit() }
    } catch { if (mounted.current && JSON.stringify([panel.connection?.id, panel.workspace, panel.file]) === snapshot) setError('파일을 읽지 못했어요. 경로·권한·크기를 확인해 주세요.') }
    finally { fileReads.delete(identity) }
  }
  async function reloadFile() {
    const connection = panel.connection, selected = panel.workspace, path = panel.file, identity = fileKey
    if (!connection || !path) return
    await write(async () => {
      const latest = await api.read(connection.id, selected, path)
      const existing = files.get(identity)
      if (existing && existing.text !== existing.base.text) files.set(identity, { ...existing, conflict: latest, uncertain: false })
      else files.set(identity, { base: latest, text: latest.text })
      emit(); report('최신 파일을 읽었어요. 초안이 있으면 비교한 뒤 선택하세요.')
    })
  }
  async function saveFile() {
    const connection = panel.connection, selected = panel.workspace, path = panel.file, identity = fileKey, snapshot = files.get(fileKey)
    if (writing || !connection || !snapshot || snapshot.busy || snapshot.conflict || snapshot.uncertain || snapshot.text === snapshot.base.text) return
    const operation = JSON.stringify(['save', connection.url, selected, path, snapshot.base.signature, snapshot.text])
    files.set(identity, { ...snapshot, busy: true }); emit()
    await write(async () => {
      try {
        const result = await api.save(connection.id, selected, path, { signature: snapshot.base.signature, text: snapshot.text }, request(operation))
        const latest = files.get(identity)!
        if (result.ok) { files.set(identity, { ...latest, base: result.file }); requestIds.delete(operation); report('파일을 저장했어요. 이후 입력은 초안으로 남아요.') }
        else { files.set(identity, { ...latest, conflict: result.current }); report('파일이 바뀌어 저장하지 않았어요. 초안을 보존했어요.') }
      } catch (reason) { files.set(identity, { ...files.get(identity)!, uncertain: true }); throw reason }
      finally { files.set(identity, { ...files.get(identity)!, busy: false }); emit() }
    })
  }
  async function create(kind: 'terminal' | 'claude' | 'codex') {
    const connection = panel.connection, selected = panel.workspace
    if (!connection || !selected) return
    const operation = JSON.stringify([kind, connection.url, selected])
    await write(async () => {
      const result = kind === 'terminal' ? await api.terminal(connection.id, selected, request(operation)) : await api.chat(connection.id, selected, kind, request(operation))
      patch({ lastResource: `${kind} · ${result.id}` })
      await loadWorkspaces(connection)
      requestIds.delete(operation)
      if (panel.connection?.id === connection.id && panel.workspace === selected) patch(kind === 'terminal' ? { terminal: result.id } : { chat: result.id })
      report('서버 세션을 준비했어요. 연결을 끊어도 계속 실행됩니다.')
    })
  }
  async function terminalWrite(data: string, clear = false) {
    const connection = panel.connection, selected = panel.workspace, session = panel.terminal, identity = terminalKey
    if (!connection || !session || !data) return
    const snapshot = inputs.get(identity) ?? ''
    const operation = JSON.stringify(['write', connection.url, selected, session, data])
    await write(async () => {
      await api.write(connection.id, selected, session, { requestId: request(operation), data })
      requestIds.delete(operation)
      if (clear && inputs.get(identity) === snapshot) input(identity, '')
      report('입력을 전달했어요.')
    })
  }
  async function sendChat() {
    const connection = panel.connection, selected = panel.workspace, chat = panel.chat, identity = chatKey, text = inputs.get(chatKey) ?? ''
    if (!connection || !chat || !text.trim()) return
    const operation = JSON.stringify(['send', connection.url, selected, chat, text])
    await write(async () => {
      await api.send(connection.id, selected, chat, text, request(operation))
      requestIds.delete(operation)
      if (inputs.get(identity) === text) input(identity, '')
      report('대화 지시를 전달했어요.')
    })
  }
  function answer(id: string, decision: ChatDecision) {
    const connection = panel.connection, selected = panel.workspace, chat = panel.chat
    if (!connection || !chat) return
    void write(async () => { const accepted = await api.answer(connection.id, selected, chat, id, decision); report(accepted ? '응답을 전달했어요.' : '이미 응답했거나 종료된 요청이에요. 다시 읽어 주세요.') })
  }
  const connected = !!panel.connection
  return <section className="remote-panel" aria-label="원격 작업 공간" data-testid="remote-panel" onKeyDown={(event) => { if (panel.tab === 'files' && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); void saveFile() } }}>
    <p className="dim small">서버가 파일과 세션을 관리합니다. HTTP는 SSH 터널의 loopback 주소에, 원격 주소는 HTTPS로 연결하세요. 연결 해제·패널 닫기는 서버 작업을 끝내지 않습니다.</p>
    <form onSubmit={(event) => { event.preventDefault(); void connect() }}>
      <label className="field"><span>원격 서버 주소</span><input type="url" required placeholder="http://127.0.0.1:4821" value={panel.url} disabled={connected || busy} onChange={(event) => patch({ url: event.target.value })} /></label>
      {!connected && <label className="field"><span>원격 서버 토큰</span><input type="password" autoComplete="off" required value={token} disabled={busy} onChange={(event) => setToken(event.target.value)} /></label>}
      <div className="remote-actions">{!connected ? <button className="button primary" disabled={busy}>연결</button> : <><span>{panel.connection!.url}</span><button type="button" className="button" disabled={busy} onClick={() => { const connection = panel.connection!; void write(async () => { await api.disconnect(connection.id); patch({ connection: null, workspaces: [], workspace: '', file: '', terminal: '', chat: '' }); report('연결을 해제했어요. 서버 세션은 계속 실행됩니다.') }) }}>연결 해제</button></>}</div>
    </form>
    {error && <p role="alert">{error}</p>}{status && <p role="status">{status}</p>}
    {error && panel.lastRequest && <button className="button" disabled={busy} onClick={() => setRetry(panel.lastRequest!)}>결과 확인 후 새 요청 번호로 준비…</button>}
    {panel.lastRequest && <p className="dim small">최근 요청 번호: {panel.lastRequest}</p>}
    {panel.lastResource && <p className="dim small">최근 서버 자원: {panel.lastResource}</p>}
    {connected && <>
      <div className="remote-actions"><label className="field"><span>서버 작업 공간</span><select value={panel.workspace} disabled={busy} onChange={(event) => chooseWorkspace(event.target.value)}><option value="">선택하세요</option>{panel.workspaces.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.path}</option>)}</select></label><button className="button" disabled={busy} onClick={() => void write(() => loadWorkspaces())}>작업 공간 다시 읽기</button></div>
      <form onSubmit={(event) => { event.preventDefault(); const connection = panel.connection!, path = panel.relative.trim(); const operation = JSON.stringify(['open', connection.url, path]); void write(async () => { const result = await api.open(connection.id, path, request(operation)); patch({ lastResource: `작업 공간 · ${result.id} · ${result.path}` }); await loadWorkspaces(connection); requestIds.delete(operation); if (panel.connection?.id === connection.id) chooseWorkspace(result.id); report('서버 작업 공간을 열었어요.') }) }}>
        <label className="field"><span>서버 허용 루트 안의 상대 경로</span><input required value={panel.relative} disabled={busy} onChange={(event) => patch({ relative: event.target.value })} /></label><button className="button" disabled={busy}>작업 공간 열기</button>
      </form>
      {workspace && <>
        <p className="remote-path">{workspace.name} · {workspace.path}</p>
        <nav className="remote-actions" aria-label="원격 도구">{([['files', '파일'], ['terminal', '터미널'], ['chat', '대화'], ['git', 'Git']] as const).map(([tab, label]) => <button className="button" key={tab} aria-pressed={panel.tab === tab} onClick={() => { patch({ tab }); setError(''); setStatus('') }}>{label}</button>)}<button className="button" disabled={busy} onClick={() => { setError(''); setRefresh((value) => value + 1) }}>현재 도구 다시 읽기</button></nav>
        {panel.tab === 'files' && <div className="remote-files">
          <div className="remote-actions"><button className="button" disabled={!panel.directory || busy} onClick={() => patch({ directory: panel.directory.split('/').slice(0, -1).join('/'), file: '' })}>상위 폴더</button><span className="remote-path">{panel.directory || '.'}</span></div>
          <div className="remote-file-list" aria-label="원격 파일 목록">{entries.map((entry) => <button className="button" key={entry.path} disabled={busy} onClick={() => entry.directory ? patch({ directory: entry.path, file: '' }) : void openFile(entry.path)}>{entry.directory ? '▸ ' : ''}{entry.name}</button>)}</div>
          {panel.file && <div className="remote-editor">
            <strong className="remote-path">{panel.file}</strong><p className="dim small">가리지 않은 원문입니다. 초안은 메모리에만 유지되며 앱 종료·새로고침 때 사라집니다.</p>
            {!draft ? <><p>파일 내용을 다시 읽어 주세요.</p><button className="button" disabled={busy} onClick={() => void reloadFile()}>원격 파일 읽기</button></> : <>
              <label className="field"><span>원격 파일 편집 내용</span><textarea spellCheck={false} value={draft.text} onChange={(event) => { files.set(fileKey, { ...files.get(fileKey)!, text: event.target.value }); emit() }} /></label>
              <div className="remote-actions"><span>{draft.text !== draft.base.text ? '저장하지 않은 초안' : '저장된 내용'}</span><button className="button primary" disabled={busy || draft.busy || !!draft.conflict || draft.uncertain || draft.text === draft.base.text} onClick={() => void saveFile()}>원격 파일 저장</button><button className="button" disabled={busy} onClick={() => void reloadFile()}>원격 파일 다시 읽기</button><button className="button" disabled={busy} onClick={() => { files.set(fileKey, { base: draft.base, text: draft.base.text }); emit() }}>초안 버리고 되돌리기</button></div>
              {draft.uncertain && <p role="alert">저장 결과를 확인하지 못했어요. 다시 읽기로 디스크를 확인하세요.</p>}
              {draft.conflict && <div className="remote-card"><p>파일이 바뀌었어요. 내 초안을 유지했어요.</p><label className="field"><span>원격 디스크 최신 내용</span><textarea readOnly value={draft.conflict.text} /></label><div className="remote-actions"><button className="button" disabled={busy} onClick={() => { files.set(fileKey, { base: draft.conflict!, text: draft.text }); emit(); setStatus('최신 버전 기준으로 준비했어요. 내용을 확인한 뒤 저장하세요.') }}>초안 유지하고 최신 기준으로 준비</button><button className="button" disabled={busy} onClick={() => { files.set(fileKey, { base: draft.conflict!, text: draft.conflict!.text }); emit() }}>초안 버리고 최신 내용 사용</button></div></div>}
            </>}
          </div>}
        </div>}
        {panel.tab === 'terminal' && <div className="remote-terminal">
          <div className="remote-actions"><label className="field"><span>서버 셸 세션</span><select value={panel.terminal} disabled={busy} onChange={(event) => patch({ terminal: event.target.value })}><option value="">선택하세요</option>{workspace.sessions.map((session) => <option key={session.id} value={session.id}>{session.title} · {session.id}{session.exited !== undefined ? ` · 종료 ${session.exited}` : ''}</option>)}</select></label><button className="button" disabled={busy} onClick={() => void create('terminal')}>새 서버 셸</button></div>
          {panel.terminal && <><pre className="remote-output" aria-label="원격 셸 출력">{output || '출력을 기다리는 중…'}</pre><form onSubmit={(event) => { event.preventDefault(); void terminalWrite((inputs.get(terminalKey) ?? '') + '\n', true) }}><label className="field"><span>원격 셸 입력</span><input value={inputs.get(terminalKey) ?? ''} onChange={(event) => input(terminalKey, event.target.value)} /></label><div className="remote-actions"><button className="button primary" disabled={busy}>입력 보내기 ↵</button><button type="button" className="button" disabled={busy} onClick={() => void terminalWrite('\x03')}>Ctrl+C 보내기</button><button type="button" className="button" disabled={busy} onClick={() => setStop({ connection: panel.connection!.id, workspace: panel.workspace, session: panel.terminal })}>서버 셸 종료…</button></div></form></>}
        </div>}
        {panel.tab === 'chat' && <div className="remote-chat">
          <div className="remote-actions"><label className="field"><span>서버 에이전트 대화</span><select value={panel.chat} disabled={busy} onChange={(event) => patch({ chat: event.target.value })}><option value="">선택하세요</option>{workspace.chats.map((chat) => <option key={chat.id} value={chat.id}>{chat.agent} · {chat.id}</option>)}</select></label><button className="button" disabled={busy} onClick={() => void create('claude')}>새 Claude 대화</button><button className="button" disabled={busy} onClick={() => void create('codex')}>새 Codex 대화</button></div>
          {panel.chat && <><div className="remote-chat-history" aria-label="원격 대화 기록">{foldBlocks(events).map((block) => {
            if (block.kind === 'question') return <RemoteQuestion key={panel.chat + block.key} block={block} busy={busy} onAnswer={(decision) => answer(block.id, decision)} />
            if (block.kind === 'permission') return <div className="remote-card" key={block.key}><strong>{block.tool} 사용 허락{block.danger ? ' · 주의가 필요한 명령' : ''}</strong><pre>{block.summary}</pre><p>{block.why}</p>{block.answer ? <p>응답 처리: {block.answer}</p> : <div className="remote-actions"><button className="button" disabled={busy} onClick={() => answer(block.id, { how: 'allow' })}>이번만 허락</button><button className="button" disabled={busy} onClick={() => answer(block.id, { how: 'deny' })}>거절</button></div>}</div>
            if (block.kind === 'user' || block.kind === 'text') return <pre key={block.key}>{block.kind === 'user' ? '나: ' : ''}{block.text}</pre>
            if (block.kind === 'tools') return <details key={block.key}><summary>도구 {block.items.length}개</summary>{block.items.map((item) => <pre key={item.id}>{item.name} · {item.state}\n{item.summary}\n{item.tail}</pre>)}</details>
            if (block.kind === 'band') return <p key={block.key} role="status">{block.message}</p>
            return <p key={block.key}>{block.kind === 'done' ? '대화 완료' : '대화 중지됨'}</p>
          })}</div><form onSubmit={(event) => { event.preventDefault(); void sendChat() }}><label className="field"><span>원격 대화 지시</span><textarea value={inputs.get(chatKey) ?? ''} onChange={(event) => input(chatKey, event.target.value)} /></label><div className="remote-actions"><button className="button primary" disabled={busy || !historyReady || !inputs.get(chatKey)?.trim() || ['run', 'wait'].includes(chatStatus(events).state)}>지시 보내기</button><button type="button" className="button" disabled={busy} onClick={() => { const connection = panel.connection!, selected = panel.workspace, chat = panel.chat; void write(async () => { await api.interrupt(connection.id, selected, chat); report('대화 중단을 요청했어요.') }) }}>현재 턴 중단</button></div></form></>}
        </div>}
        {panel.tab === 'git' && <div className="remote-git">{git ? <><p>브랜치: {git.branch}</p><h3>Git 상태</h3><pre>{git.status || '변경 없음'}</pre><h3>Git diff</h3><pre>{git.diff || '표시할 diff 없음'}</pre></> : <p>Git 정보를 다시 읽어 주세요.</p>}</div>}
      </>}
    </>}
    {stop && <ConfirmDialog title="서버 셸 종료" message={`서버의 셸 세션 ${stop.session}을 끝냅니다. 연결 해제와 달리 실행 중인 명령도 종료됩니다.`} confirmLabel="서버 셸 종료" onCancel={() => setStop(null)} onConfirm={() => { const snapshot = stop; setStop(null); void write(async () => { await api.stop(snapshot.connection, snapshot.workspace, snapshot.session); await loadWorkspaces(); report('서버 셸을 종료했어요.') }) }} />}
    {retry && <ConfirmDialog title="새 요청 번호로 준비" message="이전 요청이 이미 실행됐을 수 있습니다. 파일·출력·대화 기록을 확인한 경우에만 새 번호로 준비하세요. 이 버튼은 요청을 자동으로 보내지 않습니다." confirmLabel="결과 확인했음 · 새 번호로 준비" onCancel={() => setRetry(null)} onConfirm={() => { for(const [key,id] of requestIds) if(id===retry) requestIds.delete(key); setRetry(null); setError(''); report('새 요청 번호를 사용할 준비가 됐어요. 내용을 확인한 뒤 실행 버튼을 누르세요.'); patch({lastRequest:undefined}) }} />}
  </section>
}
