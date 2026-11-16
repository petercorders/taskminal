// 54단계: PR 의 실패한 체크(로그 끝)와 리뷰 의견을 모아 대화 입력칸 초안으로. 모양은 gh 2.86 실측(공개 PR 1건):
// `gh pr view --json statusCheckRollup,reviews,comments` · `gh api repos/<repo>/pulls/<n>/comments` · `gh run view <run> --job <job> --log-failed`
import { isObj } from './guards'

/** parsePr(33단계) 와 같은 기준 — 실패로 보는 결론 */
export const FAILED_CHECK_STATES: readonly string[] = ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STALE']
export const LOG_LINES = 120
export const LOG_BYTES = 32 * 1024
export const NOTE_CHARS = 2000
export const NOTE_MAX = 50
/** 로그를 받는 체크 수 — 한 번 읽기에 내려받는 양을 묶는다 */
export const LOG_CHECKS = 3
/** 대화 보내기 한도(100,000자) 안에서 사용자가 덧붙일 자리를 남긴다 */
export const DRAFT_CHARS = 60_000

export type LogState = 'ok' | 'empty' | 'error' | 'timeout' | 'not-actions' | 'skipped'
export interface FailedCheck {
  id: string
  name: string
  workflow: string
  url: string | null
  runId: number | null
  jobId: number | null
  log: string
  logState: LogState
}
export interface ReviewNote {
  id: string
  kind: 'review' | 'comment' | 'line'
  author: string
  state?: string
  path?: string
  line?: number
  body: string
  url?: string
  /** 쓴 시각 ms */
  at: number
}
export interface PrFeedback {
  state: 'ok'
  number: number
  head: string
  checks: FailedCheck[]
  notes: ReviewNote[]
  /** 50개를 넘어 뺀 의견 수 */
  more: number
  lineComments: 'ok' | 'error'
  /** 받은 시각 ms */
  at: number
}
export type PrFeedbackResult = PrFeedback | { state: 'timeout' | 'error'; message: string }

export const LOG_STATE_TEXT: Record<LogState, string> = {
  ok: '',
  empty: '실패 로그가 비어 있어요',
  error: '로그를 받지 못했어요',
  timeout: '로그가 늦어 받지 못했어요',
  'not-actions': 'GitHub Actions 밖의 체크라 로그를 받지 않아요',
  skipped: `로그는 처음 ${LOG_CHECKS}개 체크만 받아요`,
}

type Redact = (s: string) => string
const same: Redact = (s) => s
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
function safeHttps(v: unknown): string | null {
  return typeof v === 'string' && v.length <= 2000 && /^https:\/\/[^\s\x00-\x1f\x7f]+$/.test(v) ? v : null
}

/** 같은 저장소의 Actions job 링크에서 run · job 번호(숫자만). gh 인자로 넘길 값은 여기서만 나온다 */
export function actionsIds(url: string, repo: string): { runId: number; jobId: number } | null {
  const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/actions\/runs\/(\d{1,16})\/job\/(\d{1,16})(?:[?#]\S*)?$/.exec(url)
  if (!m || m[1]!.toLowerCase() !== repo.toLowerCase()) return null
  const runId = Number(m[2])
  const jobId = Number(m[3])
  return Number.isSafeInteger(runId) && Number.isSafeInteger(jobId) && runId > 0 && jobId > 0 ? { runId, jobId } : null
}

export function failedChecks(rollup: unknown, repo: string): Array<Omit<FailedCheck, 'log' | 'logState'>> {
  if (!Array.isArray(rollup)) return []
  const out: Array<Omit<FailedCheck, 'log' | 'logState'>> = []
  for (const c of rollup) {
    if (!isObj(c) || !FAILED_CHECK_STATES.includes(String(c['conclusion'] ?? c['state']))) continue
    const name = str(c['name']) || str(c['context']) || '이름 없는 체크'
    const url = safeHttps(c['detailsUrl'] ?? c['targetUrl'])
    const ids = url ? actionsIds(url, repo) : null
    out.push({ id: `check:${name}|${url ?? ''}`, name, workflow: str(c['workflowName']), url, runId: ids?.runId ?? null, jobId: ids?.jobId ?? null })
  }
  return out
}

// CSI · OSC · 두 글자 이스케이프 (redact.ts 와 같은 모양)
const ANSI = /\x1b\[[0-9;:?<=>]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g
const LOG_PREFIX = /^[^\t\n]*\t[^\t\n]*\t/
const STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/
const bytes = (s: string): number => new TextEncoder().encode(s).length

/**
 * `--log-failed` 출력의 끝: 줄머리(job⇥step⇥시각)와 색 코드를 떼고 마지막 120줄 → 가리기 → 32KB.
 * 가리기는 줄 단위로 자른 뒤 · 바이트로 자르기 전에 — 자른 경계에 비밀이 반쯤 걸려 못 알아보는 일이 없게.
 */
export function logTail(raw: string, redact: Redact = same, maxLines = LOG_LINES, maxBytes = LOG_BYTES): string {
  // 결과는 32KB 이하라 끝 256KB 만 보면 된다(16MB 로그를 통째로 줄 나누지 않게) — 잘린 첫 줄은 버린다
  if (raw.length > 256 * 1024) {
    raw = raw.slice(-256 * 1024)
    raw = raw.slice(raw.indexOf('\n') + 1)
  }
  const lines = raw.replace(ANSI, '').replace(/\r/g, '').split('\n').map((l) => l.replace(LOG_PREFIX, '').replace(STAMP, ''))
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop()
  let out = redact(lines.slice(-maxLines).join('\n'))
  while (bytes(out) > maxBytes && out.includes('\n')) out = out.slice(out.indexOf('\n') + 1)
  if (bytes(out) > maxBytes) {
    // UTF-16 한 단위는 UTF-8 로 3바이트를 넘지 않는다
    out = out.slice(out.length - Math.floor(maxBytes / 3))
    if (/^[\udc00-\udfff]/.test(out)) out = out.slice(1)
  }
  return out
}

const cleanBody = (v: unknown): string => str(v).replace(/<!--[\s\S]*?-->/g, '').trim()
const cut = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}…` : s)
const time = (v: unknown): number => {
  const t = Date.parse(str(v))
  return Number.isFinite(t) ? t : 0
}
const login = (v: unknown): string => (isObj(v) ? str(v['login']) : '') || '알 수 없음'

/** 리뷰 · 대화 의견 · 줄 의견을 최근 것부터 50개, 글은 2000자. 본문 없는 승인 · 아직 보내지 않은 리뷰는 뺀다 */
export function reviewNotes(view: unknown, lineComments: unknown, redact: Redact = same, max = NOTE_MAX, maxChars = NOTE_CHARS): { notes: ReviewNote[]; more: number } {
  const all: ReviewNote[] = []
  const v = isObj(view) ? view : {}
  const reviews = Array.isArray(v['reviews']) ? v['reviews'] : []
  reviews.forEach((r, i) => {
    if (!isObj(r)) return
    const state = str(r['state'])
    if (state === 'PENDING') return
    const body = cleanBody(r['body'])
    if (!body && state !== 'CHANGES_REQUESTED') return
    all.push({ id: `review:${str(r['id']) || i}`, kind: 'review', author: login(r['author']), state, body: body || '(본문 없이 변경 요청)', at: time(r['submittedAt']) })
  })
  const comments = Array.isArray(v['comments']) ? v['comments'] : []
  comments.forEach((c, i) => {
    if (!isObj(c)) return
    const body = cleanBody(c['body'])
    if (!body) return
    const url = safeHttps(c['url'])
    all.push({ id: `comment:${str(c['id']) || i}`, kind: 'comment', author: login(c['author']), body, at: time(c['createdAt']), ...(url ? { url } : {}) })
  })
  const lines = Array.isArray(lineComments) ? lineComments : []
  lines.forEach((c, i) => {
    if (!isObj(c)) return
    const body = cleanBody(c['body'])
    if (!body) return
    const line = num(c['line']) ? c['line'] : num(c['original_line']) ? c['original_line'] : undefined
    const path = str(c['path']).slice(0, 1000)
    const url = safeHttps(c['html_url'])
    const id = num(c['id']) ? String(c['id']) : str(c['id']) || String(i)
    all.push({ id: `line:${id}`, kind: 'line', author: login(c['user']), ...(path ? { path } : {}), ...(line !== undefined ? { line } : {}), body, at: time(c['created_at']), ...(url ? { url } : {}) })
  })
  all.sort((a, b) => b.at - a.at)
  const notes = all.slice(0, max).map((n) => ({ ...n, author: redact(n.author), body: cut(redact(n.body), maxChars), ...(n.path ? { path: redact(n.path) } : {}) }))
  return { notes, more: Math.max(0, all.length - max) }
}

function fence(text: string): string {
  let longest = 0
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length)
  return '`'.repeat(Math.max(3, longest + 1))
}

/** 고른 항목을 대화 입력칸 초안으로. 한도를 넘는 항목은 통째로 빼고 몇 개 뺐는지 끝에 적는다 */
export function feedbackDraft(fb: PrFeedback, repo: string, selected: ReadonlySet<string>, cap = DRAFT_CHARS): { text: string; dropped: number } {
  const parts: string[] = []
  for (const c of fb.checks) {
    if (!selected.has(c.id)) continue
    let s = `## 체크 실패: ${c.name}${c.workflow ? ` · ${c.workflow}` : ''}\n`
    if (c.url) s += `${c.url}\n`
    if (c.log) {
      const f = fence(c.log)
      s += `${f}\n${c.log}\n${f}\n`
    } else s += `(${LOG_STATE_TEXT[c.logState] || '로그 없음'})\n`
    parts.push(s)
  }
  for (const n of fb.notes) {
    if (!selected.has(n.id)) continue
    const where = n.path ? ` · ${n.path}${n.line !== undefined ? `:${n.line}` : ''}` : ''
    parts.push(`## 리뷰 의견: ${n.author}${where}\n${n.body}\n`)
  }
  let text = `PR #${fb.number} (${repo}) 의 CI 실패와 리뷰 의견이에요. 원인을 찾아 고쳐 주세요.\n`
  let dropped = 0
  for (const p of parts) {
    if (text.length + 1 + p.length > cap) dropped++
    else text += `\n${p}`
  }
  if (dropped > 0) text += `\n(고른 것 중 ${dropped}개는 길이 때문에 뺐어요)`
  return { text, dropped }
}
