import { useRef, useState } from 'react'
import { MAX_PR_REPORT_BYTES, parsePrVerification, type PrVerificationReport } from '../shared/pr-verification'
import type { WorktreeComparison, WorktreeCandidate } from '../shared/worktree-comparison'
import { openable, type ManagedWorktree, type WorktreeApi } from '../shared/worktree-management'
import { ipcMessage } from './ipc-message'

interface Evidence { report: PrVerificationReport; source: string; file: string }
const name = (entry: ManagedWorktree) => entry.branch?.replace(/^refs\/heads\//, '') ?? entry.path

function Candidate({ value, entry, open, busy }: { value: WorktreeCandidate; entry: ManagedWorktree; open(entry: ManagedWorktree): void; busy: boolean }) {
  const [evidence, setEvidence] = useState<Evidence | null>(null)
  const [error, setError] = useState('')
  const serial = useRef(0)
  const read = async (file: File) => {
    const request = ++serial.current
    try {
      if (file.size > MAX_PR_REPORT_BYTES) throw new Error()
      const text = await file.text()
      const { repository, pullRequest } = JSON.parse(text) as { repository?: unknown; pullRequest?: unknown }
      if (typeof repository !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repository) || typeof pullRequest !== 'number' || !Number.isSafeInteger(pullRequest) || pullRequest < 1) throw new Error()
      const report = parsePrVerification(text, { repository, number: pullRequest })
      if (!report) throw new Error()
      if (request === serial.current) {
        setEvidence({ report, source: `${repository} #${pullRequest}`, file: file.name })
        setError('')
      }
    } catch {
      if (request === serial.current) setError('검증 리포트를 읽지 못했어요. 64KiB 이하의 Taskminal JSON 파일을 골라 주세요.')
    }
  }
  const current = evidence?.report.head === value.sha
  return <article className="worktree-candidate">
    <h4>{name(entry)}</h4>
    <code title={value.sha}>{value.sha.slice(0, 12)}</code>
    <p>변경 파일 {value.total}개{value.total > value.changes.length && ` · 처음 ${value.changes.length}개 표시`}</p>
    {value.changes.length > 0 && <ul>{value.changes.map(({ path, from, status }) => <li key={path}>{status} · {from && <>{from} → </>}{path}</li>)}</ul>}
    <label>검증 리포트 <input type="file" accept=".json,application/json" onChange={event => {
      const file = event.currentTarget.files?.[0]
      event.currentTarget.value = ''
      if (file) void read(file)
    }} /></label>
    {error && <p role="alert">{error}</p>}
    {evidence ? <>
      <p>{evidence.file} · {evidence.source} · {current ? '비교 커밋과 일치' : '이 커밋의 검증 근거 미확인'}</p>
      <ul>{evidence.report.entries.map((row, index) => <li key={index}>{row.criterion} · {row.check} · {row.exitCode === null ? '미실행' : row.exitCode === 4 ? 'E2E 미실행' : row.exitCode === 3 ? '불안정' : row.exitCode === 0 ? '통과' : '실패'}{!current && ' (가져온 기록)'}</li>)}</ul>
    </> : <p>확인한 인수 조건 없음</p>}
    {openable(entry) && <button type="button" className="button" disabled={busy} onClick={() => open(entry)}>{name(entry)} 일감 열기</button>}
  </article>
}

export function WorktreeComparisonPanel({ root, entries, compare, open, busy }: {
  root: string; entries: ManagedWorktree[]; compare: WorktreeApi['compare']; open(entry: ManagedWorktree): void; busy: boolean
}) {
  const available = entries.filter(entry => !entry.bare && !entry.prunable && !!entry.head)
  const [show, setShow] = useState(false)
  const [first, setFirst] = useState('')
  const [second, setSecond] = useState('')
  const [base, setBase] = useState('')
  const [view, setView] = useState<{ key: string; result?: WorktreeComparison; error?: string } | null>(null)
  const [reading, setReading] = useState(false)
  const lock = useRef(false)
  const left = available.find(entry => entry.path === first)
  const right = available.find(entry => entry.path === second)
  const key = JSON.stringify([left?.path, left?.head, right?.path, right?.head, base.trim()])
  const read = async () => {
    if (!left?.head || !right?.head || first === second || lock.current) return
    lock.current = true
    setReading(true); setView(null)
    try {
      const requestedBase = base.trim()
      setView({ key, result: await compare(root, { left: left.head, right: right.head, ...(requestedBase ? { base: requestedBase } : {}) }) })
    } catch (error) {
      setView({ key, error: ipcMessage(error, '비교 결과를 읽지 못했어요.') })
    } finally { lock.current = false; setReading(false) }
  }
  if (available.length < 2) return null
  const result = view?.key === key ? view.result : undefined
  return <details open={show} onToggle={event => setShow(event.currentTarget.open)} className="worktree-comparison">
    <summary>두 워크트리 비교</summary>
    {show && <>
      <p className="worktree-meta">같은 작업을 맡긴 두 워크트리의 커밋을 비교합니다. 미커밋 변경은 포함되지 않아요.</p>
      <div className="worktree-comparison-inputs">
        <label>첫 워크트리 <select value={first} disabled={reading} onChange={event => setFirst(event.target.value)}>
          <option value="">선택…</option>{available.map(entry => <option key={entry.path} value={entry.path}>{name(entry)} · {entry.head?.slice(0, 12)}</option>)}
        </select></label>
        <label>둘째 워크트리 <select value={second} disabled={reading} onChange={event => setSecond(event.target.value)}>
          <option value="">선택…</option>{available.map(entry => <option key={entry.path} value={entry.path}>{name(entry)} · {entry.head?.slice(0, 12)}</option>)}
        </select></label>
        <label>작업 시작 SHA <input value={base} onChange={event => setBase(event.target.value)} maxLength={64} placeholder="비우면 Git 공통 조상" disabled={reading} /></label>
      </div>
      <button type="button" className="button" disabled={busy || reading || !left || !right || first === second} onClick={() => void read()}>변경과 병합 충돌 확인</button>
      {reading && <p role="status">커밋을 비교하는 중…</p>}
      {view?.key === key && view.error && <p role="alert">{view.error}</p>}
      {result && left && right && <>
        <p>변경 비교 기준 <code title={result.base}>{result.base.slice(0, 12)}</code> · {base.trim() ? '직접 지정' : 'Git 공통 조상'}</p>
        <p role="status">{result.merge.state === 'clean' ? 'Git이 병합 충돌을 발견하지 않았어요.' : result.merge.state === 'conflicts' ? 'Git 병합 충돌이 예상돼요.' : '병합 충돌을 확인하지 못했어요. Git의 merge-tree 지원 여부를 확인해 주세요.'}</p>
        {result.merge.paths.length > 0 && <ul aria-label="충돌 파일">{result.merge.paths.map(path => <li key={path}>{path}</li>)}</ul>}
        <div className="worktree-comparison-grid">
          <Candidate key={'left:' + key} value={result.left} entry={left} open={open} busy={busy} />
          <Candidate key={'right:' + key} value={result.right} entry={right} open={open} busy={busy} />
        </div>
      </>}
    </>}
  </details>
}
