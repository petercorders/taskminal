// 55단계 Jira 읽기 — 인증 저장(safeStorage 암호화 파일 · 못 쓰면 이번 실행 메모리 · 환경 변수)과 REST 읽기.
// 토큰은 이 파일 밖(renderer · state.json · 오류 글 · 로그)으로 나가지 않는다. 쓰는 요청은 없다.
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync, chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { IssuePage, IssueRecord } from '../shared/issues'
import { JIRA_ERROR, JIRA_FIELDS, JIRA_LIST_CAP, JIRA_PAGE_SIZE, JIRA_TIMEOUT_MS, jiraHttpError, jiraIssue, jiraSite, type JiraCheck, type JiraSaveInput, type JiraStatus } from '../shared/jira'
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
  private changed() { this.gen++; this.inflight.clear() }
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
  private async request(c: Credentials, method: 'GET' | 'POST', path: string, body: unknown, signal: AbortSignal): Promise<any> {
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
      throw fail(jiraHttpError(response.status, response.headers.get('retry-after')))
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
