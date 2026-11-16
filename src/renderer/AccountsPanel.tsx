import { useEffect, useRef, useState } from 'react'
import type { AccountStatus, AgentAccount } from '../shared/accounts'
import type { ChatAgent } from '../shared/chat'

const states = { ready: '조회됨', 'signed-out': '로그인 필요', unsupported: '한도 수치 미지원', unavailable: '조회 불가', missing: 'CLI 없음' }
export function AccountsPanel() {
  const api = window.taskminal.accounts
  const [list, setList] = useState<AgentAccount[]>([]),
    [id, setId] = useState(''),
    [status, setStatus] = useState<AccountStatus | null>(null)
  const [name, setName] = useState(''),
    [agent, setAgent] = useState<ChatAgent>('codex'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [refresh, setRefresh] = useState(0)
  const sequence = useRef(0),
    writing = useRef(false)
  useEffect(() => {
    let alive = true
    void api
      .list()
      .then((rows) => {
        if (alive) {
          setList(rows)
          setId((old) => (rows.some((a) => a.id === old) ? old : (rows.find((a) => a.selected)?.id ?? '')))
        }
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : '계정 목록을 읽지 못했어요.')
      })
    return () => {
      alive = false
    }
  }, [refresh])
  useEffect(() => {
    if (!id) return
    let alive = true,
      inFlight = false
    const n = ++sequence.current
    setStatus(null)
    const load = async () => {
      if (inFlight || document.hidden) return
      inFlight = true
      try {
        const value = await api.status(id)
        if (alive && n === sequence.current) setStatus(value)
      } catch {
        if (alive && n === sequence.current) setError('계정 정보를 읽지 못했어요.')
      } finally {
        inFlight = false
      }
    }
    void load()
    const timer = setInterval(() => void load(), 30000)
    const focus = () => void load()
    window.addEventListener('focus', focus)
    return () => {
      alive = false
      clearInterval(timer)
      window.removeEventListener('focus', focus)
    }
  }, [id, refresh])
  const write = async (fn: () => Promise<void>) => {
    if (writing.current) return
    writing.current = true
    setBusy(true)
    setError('')
    try {
      await fn()
      setRefresh((n) => n + 1)
    } catch (e) {
      setError(e instanceof Error ? e.message : '계정 작업을 완료하지 못했어요.')
    } finally {
      writing.current = false
      setBusy(false)
    }
  }
  const chosen = list.find((a) => a.id === id)
  return (
    <section className="work-accounts" data-testid="accounts-panel">
      <h2>사용량·계정</h2>
      <p>계정을 선택하면 새 대화부터 적용됩니다. 진행 중인 대화는 원래 계정을 유지합니다.</p>
      <label>
        확인할 계정
        <select aria-label="확인할 계정" value={id} onChange={(e) => setId(e.target.value)}>
          {list.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
              {a.selected ? ' · 새 대화 기본' : ''}
            </option>
          ))}
        </select>
      </label>
      <div className="work-tools-row">
        <button className="button" disabled={!id || busy || chosen?.selected} onClick={() => void write(() => api.select(id))}>
          새 대화 기본으로 선택
        </button>
        <button className="button" disabled={busy} onClick={() => setRefresh((n) => n + 1)}>
          사용량 새로고침
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {!status ? (
        <p role="status">계정·사용량을 읽는 중…</p>
      ) : (
        <div className="work-usage" role="status">
          <strong>{status.display}</strong>
          <p>
            {states[status.state]}
            {status.message ? ` · ${status.message}` : ''}
          </p>
          {status.windows.map((w, i) => (
            <div key={i}>
              <label>
                {w.label} · {w.used}% 사용{w.used >= 80 ? ' · 한도가 가까워요' : ''}
                <progress max={100} value={w.used} />
              </label>
              {w.resetsAt && <p>초기화 {new Date(w.resetsAt).toLocaleString()}</p>}
            </div>
          ))}
          <p className="dim small">확인 {new Date(status.updatedAt).toLocaleTimeString()} · 30초마다 갱신</p>
          {status.login && (
            <>
              <pre className="work-source">{status.login.output || '로그인 안내를 기다리는 중…'}</pre>
              {status.login.running && (
                <button className="button" onClick={() => void write(() => api.cancel(id))}>
                  로그인 중단
                </button>
              )}
            </>
          )}
        </div>
      )}
      {id && !id.startsWith('default-') && (
        <button className="button" disabled={busy || status?.login?.running} onClick={() => void write(() => api.login(id))}>
          이 추가 계정 로그인
        </button>
      )}
      <form
        className="work-account-create"
        onSubmit={(e) => {
          e.preventDefault()
          void write(async () => {
            await api.add(agent, name)
            setName('')
          })
        }}
      >
        <h3>추가 계정</h3>
        <label>
          에이전트
          <select value={agent} onChange={(e) => setAgent(e.target.value as ChatAgent)}>
            <option value="codex">Codex</option>
            <option value="claude">Claude</option>
          </select>
        </label>
        <label>
          계정 이름
          <input value={name} maxLength={80} required onChange={(e) => setName(e.target.value)} />
        </label>
        <button className="button" disabled={busy || !name.trim()}>
          계정 추가
        </button>
      </form>
      <p className="dim small">
        기본 계정 로그인은 기존 CLI에서 진행하세요. 추가 계정은 앱 전용 폴더를 사용합니다. Claude 추가 계정은 Claude.ai 로그인을 사용합니다. Codex 인증은 계정
        폴더에 저장됩니다.
      </p>
    </section>
  )
}
