import { useRef, useState } from 'react'
import { MAX_PR_REPORT_BYTES, parsePrVerification, prVerificationStatus, type PrVerificationReport, type PrVerificationStatus } from '../shared/pr-verification'

const statusText: Record<PrVerificationStatus, string> = {
  current: '현재 PR 커밋 (마지막 조회 기준)',
  previous: '이전 커밋 · 다시 확인',
  'report-unverified': '검사 대상 커밋 미확인',
  'pr-unavailable': '현재 PR 커밋을 확인하지 못했어요.',
}

function resultText(code: number | null): string {
  switch (code) {
    case null: return '미실행'
    case 0: return '통과'
    case 3: return '불안정'
    case 4: return 'e2e 미실행'
    default: return `실패 (종료 코드 ${code})`
  }
}

export function PrVerification({ repository, number, head, refreshing }: { repository: string; number: number; head: string | null; refreshing: boolean }) {
  const [report, setReport] = useState<PrVerificationReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const importing = useRef(false)
  const status = report ? prVerificationStatus(report.head, head) : null

  async function readFile(file: File) {
    if (importing.current) return
    importing.current = true
    setLoading(true)
    setError(false)
    try {
      const parsed = file.size <= MAX_PR_REPORT_BYTES ? parsePrVerification(await file.text(), { repository, number }) : null
      if (parsed) setReport(parsed)
      else setError(true)
    } catch {
      setError(true)
    } finally {
      importing.current = false
      setLoading(false)
    }
  }

  return (
    <details className="pr-verification">
      <summary>검증 근거</summary>
      <p className="small dim">로컬 보고서(JSON)는 이 패널을 닫거나 일감을 바꾸면 사라져요.</p>
      <input
        ref={fileInput}
        hidden
        type="file"
        accept=".json,application/json"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0]
          event.currentTarget.value = ''
          if (file) void readFile(file)
        }}
      />
      <button type="button" className="button small" disabled={loading || !head} onClick={() => fileInput.current?.click()}>
        검증 보고서 열기…
      </button>
      {error && <div role="alert">보고서를 읽지 못했어요. 이 PR의 검증 보고서(JSON, 64KB 이하)를 다시 골라 주세요.</div>}
      <div role="status">
        {loading && '보고서 읽는 중…'}
        {report && status && (
          <p className="small">
            로컬 보고서 · {refreshing && status === 'pr-unavailable' ? '현재 PR 커밋 확인 중…' : statusText[status]}
            {report.head && <> · 검사 커밋 <code title={report.head}>{report.head.slice(0, 12)}</code></>}
          </p>
        )}
      </div>
      {report && (
        <ul className="pr-verification-list">
          {report.entries.map((entry, index) => (
            <li key={index}>
              <strong>{entry.criterion}</strong>
              <div className="small">{entry.check} · 기록된 결과 {resultText(entry.exitCode)}</div>
            </li>
          ))}
        </ul>
      )}
    </details>
  )
}
