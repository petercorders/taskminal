// 55단계 Jira 읽기 — 인증 저장(safeStorage 암호화 파일 · 못 쓰면 이번 실행 메모리 · 환경 변수)과 REST 읽기.
// 토큰은 이 파일 밖(renderer · state.json · 오류 글 · 로그)으로 나가지 않는다.
// 64단계: 쓰는 요청은 상태 전환 · 댓글 둘뿐이고, 요청 번호마다 한 번만 보낸다(아래 '쓰기 기록').
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync, chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { IssuePage, IssueRecord } from '../shared/issues'
import { JIRA_ERROR, JIRA_FIELDS, JIRA_LIST_CAP, JIRA_PAGE_SIZE, JIRA_TIMEOUT_MS, isJiraKey, jiraHttpError, jiraIssue, jiraSite, type JiraCheck, type JiraSaveInput, type JiraStatus } from '../shared/jira'
import { JIRA_COMMENT_CHECK, JIRA_WRITE_LOG, isJiraRequestId, isJiraTransitionId, jiraAdf, jiraCommentPosted, jiraCommentText, jiraIssueError, jiraTransitions, type JiraTransition, type JiraWriteKind, type JiraWriteState } from '../shared/jira-write'
import { redact } from '../shared/redact'

/** Electron safeStorage 를 감싼 것 — 시험은 가짜를 넣는다 */
export interface Cipher { available(): boolean; encrypt(text: string): Buffer; decrypt(data: Buffer): string }
interface Credentials { site: string; email: string; token: string }
interface Options {
  dir: string
  cipher: Cipher
  env?: Record<string, string | undefined>
  /** 시험(TASKMINAL_USER_DATA)일 때만 http://127.0.0.1 허용 */
  allowLoopback?: boolean
  timeoutMs?: number
}
const fail = (text: string) => new Error(`${JIRA_ERROR} ${text}`)
const MAX_BODY = 4_000_000
const LOST = '응답이 중간에 끊겼어요. 다시 시도해 주세요.'
const NO_AUTH = 'Jira 사이트 · 이메일 · API 토큰을 먼저 저장해 주세요.'
/** 전환 목표를 기억해 두는 이슈 수 */
const TARGET_CAP = 100

/** 쓰기 하나를 어떻게 보내고, 다시 보내기 전에 이미 됐는지를 어떻게 확인하는가 */
interface WritePlan {
  path: string
  body: unknown
  /** 성공 상태 코드 — 전환 204 · 댓글 201 */
  ok: number
  landed(c: Credentials, signal: AbortSignal): Promise<boolean>
}
/** 쓰기 기록 한 줄 — 요청 번호마다 하나. 인증 값은 담지 않는다(세대 번호만) */
interface WriteRecord {
  state: JiraWriteState
  /** 종류 · 키 · 전환 id(또는 글) — 같은 번호에 다른 내용이 오면 거절한다 */
  content: string
  gen: number
  plan: WritePlan
  /** 보내는 중(또는 다시 확인하는 중)이면 그 요청 */
  run: Promise<JiraWriteState> | null
}

function email(v: unknown): string {
  if (typeof v !== 'string' || !/^[^\s@]{1,200}@[^\s@]{1,200}$/.test(v.trim())) throw fail('이메일을 확인해 주세요')
  return v.trim()
}
function token(v: unknown): string {
  if (typeof v !== 'string' || !v.trim() || v.length > 4096 || /[\s]/.test(v.trim())) throw fail('API 토큰을 확인해 주세요')
  return v.trim()
}

export class Jira {
  /** safeStorage 를 못 쓸 때 이번 실행 동안만 */
  private memory: Credentials | null = null
  /** 파일에서 읽은 값 — undefined 는 아직 안 읽음 */
  private stored: Credentials | null | undefined
  private notice = ''
  /** 인증이 바뀔 때마다 올린다 — 옛 인증으로 시작한 읽기에 새 읽기가 합쳐지지 않게 */
  private gen = 0
  private readonly inflight = new Map<string, Promise<IssuePage>>()
  /** 64단계 쓰기 기록 — 이번 실행 동안 · 최근 JIRA_WRITE_LOG 개. 상태 전환 · 댓글 둘만 쓴다. 인증이 바뀌어도 비우지 않는다 */
  private readonly writes = new Map<string, WriteRecord>()
  /** 마지막으로 읽은 전환 목록의 목표 상태(`세대\n이슈 키` → 전환 id → 상태) — 다시 시도 전 확인에 쓴다 */
  private readonly targets = new Map<string, Map<string, JiraTransition['to']>>()
  private readonly file: string
  private readonly timeout: number
  constructor(private readonly o: Options) {
    this.file = join(o.dir, 'jira-auth.bin')
    this.timeout = o.timeoutMs ?? JIRA_TIMEOUT_MS
  }
  private fromFile(): Credentials | null {
    if (this.stored !== undefined) return this.stored
    this.stored = null
    let data: Buffer
    try { data = readFileSync(this.file) } catch { return null }
    try {
      if (!this.o.cipher.available()) throw new Error('unavailable')
      const v = JSON.parse(this.o.cipher.decrypt(data)) as Credentials
      this.stored = { site: jiraSite(v.site, !!this.o.allowLoopback), email: email(v.email), token: token(v.token) }
    } catch { this.notice = '저장한 Jira 토큰을 풀지 못했어요. 다시 저장해 주세요.' }
    return this.stored
  }
  private fromEnv(): Credentials | null {
    const e = this.o.env ?? {}
    if (!e['JIRA_SITE'] || !e['JIRA_EMAIL'] || !e['JIRA_API_TOKEN']) return null
    try { return { site: jiraSite(e['JIRA_SITE'], !!this.o.allowLoopback), email: email(e['JIRA_EMAIL']), token: token(e['JIRA_API_TOKEN']) } }
    catch { return null }
  }
  private credentials(): { c: Credentials; storage: JiraStatus['storage'] } | null {
    if (this.memory) return { c: this.memory, storage: 'memory' }
    const f = this.fromFile()
    if (f) return { c: f, storage: 'encrypted' }
    const e = this.fromEnv()
    return e ? { c: e, storage: 'env' } : null
  }
  async status(): Promise<JiraStatus> {
    const now = this.credentials()
    const encryption = this.o.cipher.available()
    const notice = this.notice || (!encryption ? '이 컴퓨터에서 암호화 저장을 쓸 수 없어 토큰은 이번 실행 동안만 기억해요.' : '')
    return { site: now?.c.site ?? '', email: now?.c.email ?? '', token: !!now, storage: now?.storage ?? 'none', encryption, ...(notice ? { notice } : {}) }
  }
  private write(c: Credentials) {
    mkdirSync(this.o.dir, { recursive: true })
    const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`
    const fd = openSync(tmp, 'w', 0o600)
    try { writeSync(fd, this.o.cipher.encrypt(JSON.stringify(c))); fsyncSync(fd) }
    finally { closeSync(fd) }
    try { renameSync(tmp, this.file); chmodSync(this.file, 0o600) }
    catch (e) { try { unlinkSync(tmp) } catch { /* 이미 없음 */ } throw e }
  }
  private changed() { this.gen++; this.inflight.clear(); this.targets.clear() }
  async save(input: JiraSaveInput): Promise<{ status: JiraStatus; check: JiraCheck }> {
    const c: Credentials = { site: jiraSite(input?.site, !!this.o.allowLoopback), email: email(input?.email), token: token(input?.token) }
    if (this.o.cipher.available()) {
      try { this.write(c) } catch { throw fail('토큰을 저장하지 못했어요. 디스크 권한을 확인해 주세요.') }
      this.memory = null
      this.stored = c
      this.notice = ''
    } else this.memory = c
    this.changed()
    let check: JiraCheck
    try {
      const me = await this.request(c, 'GET', '/rest/api/3/myself', undefined, AbortSignal.timeout(this.timeout))
      const name = typeof me?.displayName === 'string' ? redact(me.displayName).slice(0, 100) : ''
      check = { ok: true, message: name ? `${name} 계정으로 연결했어요.` : '연결했어요.' }
    } catch (reason) {
      check = { ok: false, message: reason instanceof Error ? reason.message.replace(JIRA_ERROR, '').trim() : '연결을 확인하지 못했어요.' }
    }
    return { status: await this.status(), check }
  }
  async clear(): Promise<JiraStatus> {
    try { unlinkSync(this.file) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw fail('저장한 토큰 파일을 지우지 못했어요.') }
    this.memory = null
    this.stored = null
    this.notice = ''
    this.changed()
    return this.status()
  }
  /** JQL 목록 — 같은 인증 · 같은 JQL 을 읽는 중이면 그 요청을 기다린다 */
  list(jql: string): Promise<IssuePage> {
    if (typeof jql !== 'string' || !jql.trim() || jql.length > 2000 || jql.includes('\0')) return Promise.reject(fail('JQL 을 확인해 주세요'))
    const now = this.credentials()
    if (!now) return Promise.reject(fail('Jira 사이트 · 이메일 · API 토큰을 먼저 저장해 주세요.'))
    const key = `${this.gen}\n${jql}`
    const pending = this.inflight.get(key)
    if (pending) return pending
    const run = this.search(now.c, jql).finally(() => { if (this.inflight.get(key) === run) this.inflight.delete(key) })
    this.inflight.set(key, run)
    return run
  }
  private async search(c: Credentials, jql: string): Promise<IssuePage> {
    const signal = AbortSignal.timeout(this.timeout)
    const items: IssueRecord[] = []
    const seen = new Set<string>()
    let next: string | undefined
    let truncated = false
    for (let page = 0; page < 20; page++) {
      const data = await this.request(c, 'POST', '/rest/api/3/search/jql', { jql, fields: [...JIRA_FIELDS], maxResults: JIRA_PAGE_SIZE, ...(next ? { nextPageToken: next } : {}) }, signal)
      if (!data || !Array.isArray(data.issues) || data.issues.length > 1000) throw fail('Jira 목록 응답 형식을 확인하지 못했어요.')
      for (const row of data.issues) {
        const issue = jiraIssue(row, c.site)
        if (seen.has(issue.id)) continue
        if (items.length >= JIRA_LIST_CAP) { truncated = true; break }
        seen.add(issue.id)
        items.push(issue)
      }
      const token = typeof data.nextPageToken === 'string' && data.nextPageToken.length <= 4096 && data.isLast !== true ? data.nextPageToken : undefined
      if (truncated || !token || token === next) break
      if (items.length >= JIRA_LIST_CAP) { truncated = true; break }
      next = token
    }
    return { items, ...(truncated ? { truncated: true } : {}) }
  }
  /** 일감 준비 · 연결 전에 이슈 하나를 다시 읽는다 */
  async issue(id: string): Promise<IssueRecord> {
    if (typeof id !== 'string' || !/^\d{1,20}$/.test(id)) throw fail('Jira 이슈 번호를 확인해 주세요')
    const now = this.credentials()
    if (!now) throw fail('Jira 사이트 · 이메일 · API 토큰을 먼저 저장해 주세요.')
    return jiraIssue(await this.request(now.c, 'GET', `/rest/api/3/issue/${id}?fields=${JIRA_FIELDS.join(',')}`, undefined, AbortSignal.timeout(this.timeout)), now.c.site)
  }
  /** 64단계: 이 이슈에서 지금 할 수 있는 상태 전환 — 주기로 읽지 않는다(메뉴를 열 때) */
  async transitions(key: string): Promise<JiraTransition[]> {
    if (!isJiraKey(key)) throw fail('Jira 이슈 키를 확인해 주세요')
    const now = this.credentials()
    if (!now) throw fail(NO_AUTH)
    const gen = this.gen
    const list = jiraTransitions(await this.request(now.c, 'GET', `/rest/api/3/issue/${key}/transitions`, undefined, AbortSignal.timeout(this.timeout), 'issue'))
    // 읽는 사이 인증이 바뀌었으면 옛 계정의 목록이다 — 목표로 기억하지 않는다
    if (gen === this.gen) {
      const at = `${gen}\n${key}`
      this.targets.delete(at)
      if (this.targets.size >= TARGET_CAP) this.targets.delete(this.targets.keys().next().value!)
      this.targets.set(at, new Map(list.map((t) => [t.id, t.to])))
    }
    return list
  }
  /** 상태 전환 — POST …/transitions (성공 204). 방금 읽은 전환 목록에 있던 것만 보낸다 */
  transition(key: string, transitionId: string, requestId: string): Promise<JiraWriteState> {
    if (!isJiraKey(key) || !isJiraTransitionId(transitionId) || !isJiraRequestId(requestId)) return Promise.reject(fail('Jira 이슈 키 · 전환 · 요청 번호를 확인해 주세요'))
    return this.once('transition', key, requestId, JSON.stringify(['transition', key, transitionId]), () => {
      const to = this.targets.get(`${this.gen}\n${key}`)?.get(transitionId)
      if (!to) throw fail('전환 목록을 다시 읽은 뒤 골라 주세요.')
      return {
        path: `/rest/api/3/issue/${key}/transitions`, body: { transition: { id: transitionId } }, ok: 204,
        // 다시 보내기 전 확인: 이슈 상태가 이미 이 전환의 목표인가
        landed: async (c, signal) => {
          const data = await this.request(c, 'GET', `/rest/api/3/issue/${key}?fields=status`, undefined, signal, 'issue')
          const status = data?.fields?.status?.id
          if (typeof status !== 'string') throw fail('Jira 이슈 상태를 확인하지 못했어요.')
          return status === to.id
        },
      }
    })
  }
  /** 댓글 — POST …/comment 에 ADF 로 (성공 201) */
  comment(key: string, text: string, requestId: string): Promise<JiraWriteState> {
    if (!isJiraKey(key) || !isJiraRequestId(requestId)) return Promise.reject(fail('Jira 이슈 키 · 요청 번호를 확인해 주세요'))
    let clean: string
    try { clean = jiraCommentText(text) } catch (reason) { return Promise.reject(reason) }
    const startedAt = Date.now()
    return this.once('comment', key, requestId, JSON.stringify(['comment', key, clean]), () => ({
      path: `/rest/api/3/issue/${key}/comment`, body: { body: jiraAdf(clean) }, ok: 201,
      // 다시 보내기 전 확인: 최근 댓글에 내 계정이 요청 시작 뒤에 쓴 같은 글이 있는가
      landed: async (c, signal) => {
        const me = await this.request(c, 'GET', '/rest/api/3/myself', undefined, signal)
        if (typeof me?.accountId !== 'string' || !me.accountId) throw fail('Jira 계정을 확인하지 못했어요.')
        return jiraCommentPosted(await this.request(c, 'GET', `/rest/api/3/issue/${key}/comment?orderBy=-created&maxResults=${JIRA_COMMENT_CHECK}`, undefined, signal, 'issue'), me.accountId, clean, startedAt)
      },
    }))
  }
  /** 보낸 쓰기의 지금 상태 — 이번 실행의 기록에 없으면 null */
  writeState(requestId: string): JiraWriteState | null {
    if (!isJiraRequestId(requestId)) throw fail('Jira 요청 번호를 확인해 주세요')
    const record = this.writes.get(requestId)
    return record ? { ...record.state } : null
  }
  /**
   * 요청 번호로 한 번만 — Jira REST 에는 멱등 키가 없어 이 기록이 지킨다.
   * 진행 중이면 그 요청에 합치고, 끝났으면(됨 · 안 됨) 저장한 결과를 돌려주고, 됐는지 모르면 먼저 확인한 뒤 안 됐을 때만 다시 보낸다.
   */
  private once(kind: JiraWriteKind, key: string, requestId: string, content: string, plan: () => WritePlan): Promise<JiraWriteState> {
    try {
      const prior = this.writes.get(requestId)
      if (prior) {
        if (prior.content !== content) throw fail('다른 요청에 쓴 번호예요. 새로 골라 다시 보내 주세요.')
        if (prior.state.status === 'done' || prior.state.status === 'failed') return Promise.resolve({ ...prior.state })
        // 옛 인증으로 보낸 요청은 그 인증으로 끝까지 가고(진행 중), 새 인증의 호출과 합치거나 새 인증으로 다시 확인하지 않는다
        if (prior.gen !== this.gen) throw fail('Jira 인증이 바뀌어 이 요청은 이어서 확인할 수 없어요. Jira 에서 직접 확인해 주세요.')
        if (prior.run) return prior.run
      }
      const now = this.credentials()
      if (!now) throw fail(NO_AUTH)
      // 됐는지 모름 — 같은 번호로 다시 누름: 먼저 이미 됐는지 확인한다
      if (prior) return this.start(prior, now.c, true)
      const record: WriteRecord = { state: { requestId, kind, key, status: 'pending', message: '' }, content, gen: this.gen, plan: plan(), run: null }
      this.room()
      this.writes.set(requestId, record)
      return this.start(record, now.c, false)
    } catch (reason) { return Promise.reject(reason) }
  }
  /** 기록 상한 — 오래된 끝난 것(됨 · 안 됨)부터, 없으면 오래된 '모름' 을 지운다. 진행 중은 지우지 않는다 */
  private room() {
    if (this.writes.size < JIRA_WRITE_LOG) return
    for (const settled of [true, false]) {
      for (const [id, record] of this.writes) {
        const status = record.state.status
        if (settled ? status === 'done' || status === 'failed' : status === 'unknown') { this.writes.delete(id); return }
      }
    }
    throw fail('보내는 중인 Jira 요청이 너무 많아요. 끝난 뒤 다시 시도해 주세요.')
  }
  private start(record: WriteRecord, c: Credentials, verify: boolean): Promise<JiraWriteState> {
    record.state = { ...record.state, status: 'pending', message: '' }
    const run = this.send(record, c, verify).then((result) => {
      record.state = { ...record.state, ...result }
      record.run = null
      return { ...record.state }
    })
    record.run = run
    return run
  }
  /** 한 번 보낸다. 응답을 못 받았거나(끊김 · 한도) 5xx 면 '됐는지 모름' — 여기서 다시 보내지 않는다. 4xx 만 '안 됨' 으로 확정한다 */
  private async send(record: WriteRecord, c: Credentials, verify: boolean): Promise<Pick<JiraWriteState, 'status' | 'message'>> {
    const text = (reason: unknown) => (reason instanceof Error ? reason.message.replace(JIRA_ERROR, '').trim() : '') || '결과를 확인하지 못했어요.'
    if (verify) {
      try { if (await record.plan.landed(c, AbortSignal.timeout(this.timeout))) return { status: 'done', message: '' } }
      catch (reason) { return { status: 'unknown', message: text(reason) } }
    }
    try {
      const status = await this.request(c, 'POST', record.plan.path, record.plan.body, AbortSignal.timeout(this.timeout), record.state.kind)
      return status === record.plan.ok ? { status: 'done', message: '' } : { status: 'unknown', message: `Jira 가 예상과 다른 답을 보냈어요(${status}).` }
    } catch (reason) {
      const status = (reason as { status?: unknown } | null)?.status
      return { status: typeof status === 'number' && status >= 400 && status < 500 ? 'failed' : 'unknown', message: text(reason) }
    }
  }
  /** about: 이슈 하나에 보내는 요청이면 그 종류 — 거절 글이 달라지고, 쓰기('transition' · 'comment')는 본문을 읽지 않고 상태 코드를 돌려준다 */
  private async request(c: Credentials, method: 'GET' | 'POST', path: string, body: unknown, signal: AbortSignal, about?: 'issue' | JiraWriteKind): Promise<any> {
    let response: Response
    try {
      response = await fetch(c.site + path, {
        method,
        headers: { Authorization: 'Basic ' + Buffer.from(`${c.email}:${c.token}`).toString('base64'), Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        // 다른 곳으로 넘기는 응답에 인증 머리를 따라 보내지 않는다
        redirect: 'error',
        signal,
      })
    } catch (reason) { throw this.network(reason, signal, false) }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      const retry = response.headers.get('retry-after')
      throw Object.assign(fail(about ? jiraIssueError(about, response.status, retry) : jiraHttpError(response.status, retry)), { status: response.status })
    }
    // 쓰기는 상태 코드로 정한다 — 본문(204 는 없음)을 받다 끊겨도 이미 된 일이다
    if (about === 'transition' || about === 'comment') {
      await response.body?.cancel().catch(() => {})
      return response.status
    }
    const reader = response.body?.getReader()
    if (!reader) throw fail(LOST)
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_BODY) { await reader.cancel().catch(() => {}); throw fail('Jira 응답이 너무 커요. JQL 을 좁혀 주세요.') }
        chunks.push(value)
      }
    } catch (reason) {
      if (reason instanceof Error && reason.message.startsWith(JIRA_ERROR)) throw reason
      throw this.network(reason, signal, true)
    } finally { reader.releaseLock() }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw fail(LOST) }
  }
  /** 끊김(연결 못 함) · 응답 유실(받다가 끊김) · 한도(답 없음)를 나눈다 */
  private network(reason: unknown, signal: AbortSignal, started: boolean): Error {
    if (signal.aborted) return fail('응답이 없어요. 다시 시도해 주세요.')
    const code = (reason as { cause?: { code?: string } })?.cause?.code
    if (started || code === 'UND_ERR_SOCKET' || code === 'ECONNRESET') return fail(LOST)
    return fail('Jira 에 연결하지 못했어요. 네트워크와 사이트 주소를 확인해 주세요.')
  }
}
