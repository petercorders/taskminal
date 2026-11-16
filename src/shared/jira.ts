// 55단계 Jira 읽기 연동 — main · renderer 가 함께 쓰는 순수 규칙. 쓰기(상태 전환 · 댓글)는 없다.
import type { IssueLink, IssueRecord } from './issues'
import { redact } from './redact'

export const JIRA_DEFAULT_JQL = 'assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC'
export const JIRA_FIELDS = ['summary', 'status', 'duedate', 'assignee', 'project', 'issuetype', 'priority', 'updated'] as const
/** 한 번 읽기의 상한 — 넘으면 truncated 로 'JQL 을 좁혀 주세요' */
export const JIRA_LIST_CAP = 100
export const JIRA_PAGE_SIZE = 50
/** 연결 확인 · 목록 읽기 전체(여러 페이지 포함)의 한도 */
export const JIRA_TIMEOUT_MS = 15_000
/** IPC 는 Error 의 message 만 옮긴다 — 이 표시 뒤의 글만 화면에 그대로 보인다 */
export const JIRA_ERROR = '[jira]'

export interface JiraStatus {
  site: string
  email: string
  /** 토큰이 있는지만 — 토큰 값은 renderer 로 보내지 않는다 */
  token: boolean
  storage: 'encrypted' | 'memory' | 'env' | 'none'
  encryption: boolean
  notice?: string
}
export interface JiraSaveInput { site: string; email: string; token: string }
export interface JiraCheck { ok: boolean; message: string }
export interface JiraAttachInput { requestId: string; id: string; taskId: string }
export interface JiraApi {
  status(): Promise<JiraStatus>
  /** 저장한 뒤 연결을 확인한다 — 확인이 실패해도 저장한 토큰은 남는다 */
  save(input: JiraSaveInput): Promise<{ status: JiraStatus; check: JiraCheck }>
  clear(): Promise<JiraStatus>
  /** 기존 일감에 Jira 이슈 연결 */
  attach(input: JiraAttachInput): Promise<IssueLink>
}

const fail = (text: string) => new Error(`${JIRA_ERROR} ${text}`)

/** 사이트 주소 → origin. https 만, 시험용 http://127.0.0.1 은 allowLoopback 일 때만 */
export function jiraSite(value: unknown, allowLoopback: boolean): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) throw fail('Jira 사이트 주소를 적어 주세요 (예: https://회사.atlassian.net)')
  let url: URL
  try { url = new URL(value.trim()) } catch { throw fail('Jira 사이트 주소를 확인해 주세요 (예: https://회사.atlassian.net)') }
  const loopback = allowLoopback && url.protocol === 'http:' && url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !loopback) throw fail('Jira 사이트는 https 주소만 쓸 수 있어요')
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw fail('사이트 주소만 적어 주세요 (예: https://회사.atlassian.net)')
  return url.origin
}

const KEY = /^[A-Za-z][A-Za-z0-9_]{0,49}-[1-9]\d{0,9}$/
const text = (v: unknown, max = 200) => (typeof v === 'string' ? redact(v).replace(/[\r\n]+/g, ' ').slice(0, max) : '')

/** 검색 · 이슈 응답의 행 → IssueRecord. 제목 · 이름은 비신뢰 자료라 가린 뒤 글자로만 쓴다 */
export function jiraIssue(row: unknown, site: string): IssueRecord {
  const r = row as { id?: unknown; key?: unknown; fields?: Record<string, any> } | null
  const f = r?.fields
  if (!r || typeof r.id !== 'string' || !/^\d{1,20}$/.test(r.id) || typeof r.key !== 'string' || !KEY.test(r.key) || !f || typeof f.summary !== 'string' || typeof f.status?.name !== 'string') throw fail('Jira 이슈 응답을 확인하지 못했어요')
  const due = typeof f.duedate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(f.duedate) ? f.duedate : undefined
  const meta: Array<[string, string]> = [['프로젝트', text(f.project?.name) || text(f.project?.key)], ['유형', text(f.issuetype?.name)], ['우선순위', text(f.priority?.name)], ['담당', text(f.assignee?.displayName) || '없음'], ['마감', due ?? '없음'], ['갱신', text(f.updated, 40)]]
  const status = text(f.status.name, 100)
  return {
    provider: 'jira', id: r.id, key: r.key, title: redact(f.summary).slice(0, 256),
    body: meta.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n'),
    url: `${site}/browse/${r.key}`,
    state: f.status.statusCategory?.key === 'done' ? `closed (${status})` : status,
    ...(due ? { due } : {}),
  }
}

/** Retry-After(초 또는 HTTP 날짜) → 남은 초 */
export function retrySeconds(value: string | null, now = Date.now()): number | null {
  if (!value) return null
  const v = value.trim()
  if (/^\d{1,6}$/.test(v)) return Number(v)
  const at = Date.parse(v)
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now) / 1000))
}

/** HTTP 상태 → 사용자 글. 응답 본문은 싣지 않는다(토큰 · 비신뢰 글이 섞일 수 있다) */
export function jiraHttpError(status: number, retryAfter: string | null, now = Date.now()): string {
  if (status === 401) return '인증에 실패했어요(401). 이메일과 API 토큰을 확인해 다시 저장해 주세요.'
  if (status === 403) return '권한이 없어요(403). 이 계정의 Jira 접근 · 검색 권한을 확인해 주세요.'
  if (status === 404) return '사이트나 API 를 찾지 못했어요(404). 사이트 주소를 확인해 주세요.'
  if (status === 410) return '이 Jira 검색 API 는 더 이상 쓸 수 없어요(410). 앱을 업데이트해 주세요.'
  if (status === 429) {
    const s = retrySeconds(retryAfter, now)
    return `요청 한도에 걸렸어요(429). ${s === null ? '잠시 뒤' : `${s}초 뒤`} 다시 시도해 주세요.`
  }
  if (status === 400) return 'Jira 가 요청을 거절했어요(400). JQL 을 확인해 주세요.'
  if (status >= 500) return `Jira 서버 오류예요(${status}). 잠시 뒤 다시 시도해 주세요.`
  return `Jira 요청이 거절됐어요(${status}).`
}

/** IPC 로 온 오류에서 Jira 글만 꺼낸다 — 표시가 없으면 기본 글 */
export function jiraMessage(reason: unknown, fallback: string): string {
  const m = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : ''
  const i = m.indexOf(JIRA_ERROR)
  return i >= 0 ? m.slice(i + JIRA_ERROR.length).trim().slice(0, 300) || fallback : fallback
}

/** 마감 글 — 색만이 아니라 글자로도 '마감 지남' */
export function jiraDue(due: string | undefined, now: Date): { text: string; overdue: boolean } | null {
  if (!due || !/^\d{4}-\d{2}-\d{2}$/.test(due)) return null
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const [, m, d] = due.split('-')
  const day = `${Number(m)}월 ${Number(d)}일`
  if (due < today) return { text: `마감 지남 · ${day}`, overdue: true }
  if (due === today) return { text: `오늘 마감 · ${day}`, overdue: false }
  return { text: `마감 ${day}`, overdue: false }
}
