// 64단계 Jira 쓰기(상태 전환 · 댓글) — main · renderer 가 함께 쓰는 순수 규칙.
// Jira REST 에는 멱등 키가 없다 — 요청 번호로 한 번만 보내는 것은 main 의 쓰기 기록(src/main/jira.ts)이 지킨다.
import { JIRA_ERROR, jiraHttpError } from './jira'
import { redact } from './redact'

/** 댓글 글자 상한 */
export const JIRA_COMMENT_MAX = 8000
/** 메뉴에 보일 전환 수 상한 */
export const JIRA_TRANSITION_CAP = 50
/** main 쓰기 기록 상한 — 이번 실행 동안 · 메모리 */
export const JIRA_WRITE_LOG = 200
/** 다시 시도 전 확인에서 읽는 최근 댓글 수 */
export const JIRA_COMMENT_CHECK = 20
/** '요청 시작 뒤' 를 볼 때 이 컴퓨터와 Jira 서버 시계가 어긋난 만큼 봐주는 폭 */
export const JIRA_CLOCK_SKEW_MS = 60_000

export interface JiraTransition { id: string; name: string; to: { id: string; name: string; category: string } }
export type JiraWriteKind = 'transition' | 'comment'
/** pending 보내는 중 · done 됨 · failed 안 됨(확정) · unknown 됐는지 모름(자동으로 다시 보내지 않는다) */
export type JiraWriteStatus = 'pending' | 'done' | 'failed' | 'unknown'
export interface JiraWriteState { requestId: string; kind: JiraWriteKind; key: string; status: JiraWriteStatus; message: string }
export interface JiraTransitionInput { key: string; transitionId: string; requestId: string }
export interface JiraCommentInput { key: string; text: string; requestId: string }
export interface JiraRefreshInput { taskId: string; key: string }

const fail = (text: string) => new Error(`${JIRA_ERROR} ${text}`)
const label = (v: string) => redact(v).replace(/[\r\n]+/g, ' ').slice(0, 100)

export const isJiraTransitionId = (v: unknown): v is string => typeof v === 'string' && /^\d{1,10}$/.test(v)
export const isJiraRequestId = (v: unknown): v is string => typeof v === 'string' && /^[\w-]{1,100}$/.test(v)

/** GET …/transitions 응답 → 메뉴 줄. 이름은 비신뢰 자료라 가린 글자로, 모양이 다른 줄은 버린다 */
export function jiraTransitions(data: unknown): JiraTransition[] {
  const rows = (data as { transitions?: unknown } | null)?.transitions
  if (!Array.isArray(rows)) throw fail('Jira 전환 목록 응답을 확인하지 못했어요.')
  const out = new Map<string, JiraTransition>()
  for (const row of rows.slice(0, 500)) {
    if (out.size >= JIRA_TRANSITION_CAP) break
    const r = row as { id?: unknown; name?: unknown; to?: { id?: unknown; name?: unknown; statusCategory?: { key?: unknown } } } | null
    if (!r || !isJiraTransitionId(r.id) || out.has(r.id) || typeof r.name !== 'string' || typeof r.to?.id !== 'string' || !/^\d{1,20}$/.test(r.to.id) || typeof r.to.name !== 'string') continue
    const category = r.to.statusCategory?.key
    out.set(r.id, { id: r.id, name: label(r.name), to: { id: r.to.id, name: label(r.to.name), category: typeof category === 'string' && /^[a-z]{1,20}$/.test(category) ? category : '' } })
  }
  return [...out.values()]
}

/** 보낼 댓글 글 — 앞뒤 빈 줄 · 끝 공백을 떼고, 비었거나 길면 거절 */
export function jiraCommentText(v: unknown): string {
  if (typeof v !== 'string' || v.includes('\0')) throw fail('댓글 글을 확인해 주세요.')
  if (v.length > JIRA_COMMENT_MAX) throw fail(`댓글은 ${JIRA_COMMENT_MAX.toLocaleString('en-US')}자까지 보낼 수 있어요.`)
  const text = plain(v.replace(/\r\n?/g, '\n'))
  if (!text.trim()) throw fail('댓글이 비어 있어요.')
  return text
}
/** 줄 끝 공백 · 앞뒤 빈 줄을 뗀 글 — 보낸 글과 Jira 가 돌려준 글을 같은 모양으로 견준다 */
const plain = (text: string) => text.split('\n').map((line) => line.trimEnd()).join('\n').replace(/^\n+|\n+$/g, '')

/** 글 → ADF 문서. 줄바꿈은 문단을 나누고 빈 줄은 빈 문단 */
export function jiraAdf(text: string): { type: 'doc'; version: 1; content: Array<{ type: 'paragraph'; content: Array<{ type: 'text'; text: string }> }> } {
  return { type: 'doc', version: 1, content: text.split('\n').map((line) => ({ type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [] })) }
}
/** ADF 문서 → 글(문단마다 한 줄). 비신뢰 응답이라 깊이 · 개수에 상한을 둔다 */
export function jiraAdfText(doc: unknown): string {
  const blocks = (doc as { content?: unknown } | null)?.content
  return Array.isArray(blocks) ? blocks.slice(0, 2000).map((block) => inline(block, 0)).join('\n') : ''
}
function inline(node: unknown, depth: number): string {
  const n = node as { type?: unknown; text?: unknown; content?: unknown } | null
  if (!n || typeof n !== 'object' || depth > 8) return ''
  if (n.type === 'text') return typeof n.text === 'string' ? n.text : ''
  if (n.type === 'hardBreak') return '\n'
  return Array.isArray(n.content) ? n.content.slice(0, 2000).map((child) => inline(child, depth + 1)).join('') : ''
}

/** 최근 댓글 응답에 '내 계정이 요청 시작 뒤에 쓴 같은 글' 이 있는가 — 다시 보내기 전 확인 */
export function jiraCommentPosted(data: unknown, accountId: string, text: string, startedAt: number): boolean {
  const rows = (data as { comments?: unknown } | null)?.comments
  if (!Array.isArray(rows)) throw fail('Jira 댓글 응답을 확인하지 못했어요.')
  const want = plain(text)
  return rows.slice(0, 100).some((row) => {
    const r = row as { author?: { accountId?: unknown }; created?: unknown; body?: unknown } | null
    const at = typeof r?.created === 'string' ? Date.parse(r.created) : NaN
    return r?.author?.accountId === accountId && at >= startedAt - JIRA_CLOCK_SKEW_MS && plain(jiraAdfText(r.body)) === want
  })
}

/** 이슈 하나에 보낸 요청(전환 목록 · 상태 · 댓글 읽기와 쓰기)의 HTTP 상태 → 사용자 글. 응답 본문은 싣지 않는다 */
export function jiraIssueError(about: 'issue' | JiraWriteKind, status: number, retryAfter: string | null, now = Date.now()): string {
  if (status === 400) return about === 'transition' ? 'Jira 가 요청을 거절했어요(400). 전환 목록이 바뀌었을 수 있어요 — 다시 골라 주세요.' : about === 'comment' ? 'Jira 가 댓글을 거절했어요(400). 글을 확인해 주세요.' : 'Jira 가 요청을 거절했어요(400).'
  if (status === 403) return '권한이 없어요(403). 이 이슈를 보거나 바꿀 권한을 확인해 주세요.'
  if (status === 404) return '이슈를 찾지 못했어요(404). 지워졌거나 볼 권한이 없어요.'
  return jiraHttpError(status, retryAfter, now)
}
