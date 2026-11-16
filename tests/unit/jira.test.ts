import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JIRA_DEFAULT_JQL, JIRA_LIST_CAP, jiraDue, jiraHttpError, jiraIssue, jiraMessage, jiraSite } from '../../src/shared/jira'
import { Jira, type Cipher } from '../../src/main/jira'

// 가짜 Jira — 실제 Atlassian 에 접속하지 않는다. 실제 필드 · 권한 · 한도는 흉내 내지 않는다.
type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void
interface Fake { url: string; requests: Array<{ method: string; path: string; auth: string; body: string }>; close(): Promise<void> }
const servers: Fake[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
async function fake(handler: Handler): Promise<Fake> {
  const requests: Fake['requests'] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => { requests.push({ method: req.method ?? '', path: req.url ?? '', auth: req.headers.authorization ?? '', body }); handler(req, body, res) })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const f: Fake = { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()) }) }
  servers.push(f)
  return f
}
const json = (res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(value)) }
const row = (n: number, extra: Record<string, unknown> = {}) => ({ id: String(10000 + n), key: `PROJ-${n}`, fields: { summary: `이슈 ${n}`, status: { name: 'To Do', statusCategory: { key: 'new' } }, duedate: '2026-11-20', assignee: { displayName: '담당자' }, project: { key: 'PROJ', name: '프로젝트' }, issuetype: { name: 'Task' }, priority: { name: 'High' }, updated: '2026-11-15T10:00:00.000+0900', ...extra } })
// 평문이 파일에 남지 않는지 보려고 글자를 뒤집고 표시를 붙이는 가짜 암호기
const cipher = (available = true): Cipher => ({ available: () => available, encrypt: (t) => Buffer.from('ENC:' + [...t].reverse().join('')), decrypt: (b) => { const s = b.toString(); if (!s.startsWith('ENC:')) throw new Error('bad'); return [...s.slice(4)].reverse().join('') } })
const SECRET = 'ATATT3xFfGF0' + 'Q'.repeat(60)
const OTHER = 'ATATT3xFfGF0' + 'Z'.repeat(60)
function dir() { const d = realpathSync(mkdtempSync(join(tmpdir(), 'tm-jira-'))); dirs.push(d); return d }
const jira = (d: string, o: Partial<ConstructorParameters<typeof Jira>[0]> = {}) => new Jira({ dir: d, cipher: cipher(), env: {}, allowLoopback: true, ...o })
const basic = (token: string) => 'Basic ' + Buffer.from(`me@example.com:${token}`).toString('base64')

describe('Jira 순수 규칙', () => {
  it('사이트는 https 만 — 시험용 http://127.0.0.1 은 허용할 때만, 계정 · 경로 · 질의는 거절', () => {
    expect(jiraSite('https://acme.atlassian.net/', false)).toBe('https://acme.atlassian.net')
    expect(() => jiraSite('http://acme.atlassian.net', false)).toThrow(/https/)
    expect(() => jiraSite('http://127.0.0.1:8080', false)).toThrow(/https/)
    expect(jiraSite('http://127.0.0.1:8080', true)).toBe('http://127.0.0.1:8080')
    expect(() => jiraSite('http://localhost:8080', true)).toThrow(/https/)
    expect(() => jiraSite('https://u:p@acme.atlassian.net', false)).toThrow()
    expect(() => jiraSite('https://acme.atlassian.net/jira?x=1', false)).toThrow()
  })
  it('이슈 행을 가려서 읽고 · 끝난 상태는 closed 로 · 마감은 날짜만', () => {
    const issue = jiraIssue(row(3, { summary: '토큰 ghp_' + 'a'.repeat(36) + ' 노출', status: { name: 'Done', statusCategory: { key: 'done' } } }), 'https://acme.atlassian.net')
    expect(issue).toMatchObject({ provider: 'jira', id: '10003', key: 'PROJ-3', url: 'https://acme.atlassian.net/browse/PROJ-3', state: 'closed (Done)', due: '2026-11-20' })
    expect(issue.title).not.toContain('ghp_aaaa')
    expect(issue.body).toContain('담당: 담당자')
    expect(() => jiraIssue({ id: '1', key: 'bad key', fields: {} }, 'https://a.atlassian.net')).toThrow()
    expect(jiraIssue(row(4, { duedate: '<b>x</b>' }), 'https://a.atlassian.net').due).toBeUndefined()
  })
  it('마감 지남 · 오늘 · 앞으로를 글자로 나눈다', () => {
    const now = new Date(2026, 10, 16, 9)
    expect(jiraDue('2026-11-15', now)).toEqual({ text: '마감 지남 · 11월 15일', overdue: true })
    expect(jiraDue('2026-11-16', now)).toEqual({ text: '오늘 마감 · 11월 16일', overdue: false })
    expect(jiraDue('2026-12-01', now)).toEqual({ text: '마감 12월 1일', overdue: false })
    expect(jiraDue(undefined, now)).toBeNull()
  })
  it('HTTP 상태를 글자로 구별하고 429 는 Retry-After 를 안내한다', () => {
    const texts = [401, 403, 404, 410, 400, 503].map((s) => jiraHttpError(s, null))
    expect(new Set(texts).size).toBe(texts.length)
    expect(jiraHttpError(429, '30')).toContain('30초 뒤')
    expect(jiraHttpError(429, new Date(Date.UTC(2026, 0, 1, 0, 1)).toUTCString(), Date.UTC(2026, 0, 1))).toContain('60초 뒤')
    expect(jiraHttpError(429, null)).toContain('잠시 뒤')
    expect(jiraMessage(new Error("Error invoking remote method 'x': Error: [jira] 인증 실패"), '기본')).toBe('인증 실패')
    expect(jiraMessage(new Error('다른 오류'), '기본')).toBe('기본')
  })
})

describe('Jira 인증 저장', () => {
  it('토큰은 암호화해 0600 파일로 원자적으로 저장하고 상태 · 오류에는 싣지 않는다', async () => {
    const f = await fake((_q, _b, res) => json(res, 200, { displayName: '김개발' }))
    const d = dir()
    const j = jira(d)
    const { status, check } = await j.save({ site: f.url, email: 'me@example.com', token: SECRET })
    expect(check).toEqual({ ok: true, message: expect.stringContaining('김개발') })
    expect(status).toMatchObject({ site: f.url, email: 'me@example.com', token: true, storage: 'encrypted' })
    expect(JSON.stringify(status)).not.toContain(SECRET)
    const file = join(d, 'jira-auth.bin')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readFileSync(file, 'utf8')).not.toContain(SECRET)
    expect(readdirSync(d)).toEqual(['jira-auth.bin'])
    expect(f.requests[0]).toMatchObject({ method: 'GET', path: '/rest/api/3/myself', auth: basic(SECRET) })
    // 다시 켠 앱이 파일에서 읽는다
    expect((await jira(d).status()).token).toBe(true)
    await j.clear()
    expect(existsSync(file)).toBe(false)
    expect((await j.status()).token).toBe(false)
  })
  it('safeStorage 를 못 쓰면 이번 실행 메모리에만 두고 안내한다', async () => {
    const f = await fake((_q, _b, res) => json(res, 200, { displayName: 'x' }))
    const d = dir()
    const j = jira(d, { cipher: cipher(false) })
    const { status } = await j.save({ site: f.url, email: 'me@example.com', token: SECRET })
    expect(status).toMatchObject({ token: true, storage: 'memory', encryption: false })
    expect(status.notice).toMatch(/이번 실행/)
    expect(readdirSync(d)).toEqual([])
    expect((await jira(d, { cipher: cipher(false) }).status()).token).toBe(false)
  })
  it('환경 변수 JIRA_SITE · JIRA_EMAIL · JIRA_API_TOKEN 도 받는다', async () => {
    const f = await fake((_q, _b, res) => json(res, 200, { issues: [row(1)] }))
    const j = jira(dir(), { env: { JIRA_SITE: f.url, JIRA_EMAIL: 'me@example.com', JIRA_API_TOKEN: SECRET } })
    expect(await j.status()).toMatchObject({ storage: 'env', token: true })
    expect((await j.list(JIRA_DEFAULT_JQL)).items).toHaveLength(1)
    expect(f.requests[0]!.auth).toBe(basic(SECRET))
  })
  it('연결 확인이 실패해도 저장한 토큰은 남기고 오류를 돌려준다', async () => {
    const f = await fake((_q, _b, res) => json(res, 401, { errorMessages: [SECRET] }))
    const d = dir()
    const j = jira(d)
    const { status, check } = await j.save({ site: f.url, email: 'me@example.com', token: SECRET })
    expect(check.ok).toBe(false)
    expect(check.message).toContain('401')
    expect(check.message).not.toContain(SECRET)
    expect(status.token).toBe(true)
    expect(existsSync(join(d, 'jira-auth.bin'))).toBe(true)
  })
  it('연결 확인이 답하지 않으면 한도 뒤 응답이 없어요 — 토큰은 남는다', async () => {
    const hang = await fake(() => {})
    const j = jira(dir(), { timeoutMs: 300 })
    const started = Date.now()
    const { status, check } = await j.save({ site: hang.url, email: 'me@example.com', token: SECRET })
    expect(check).toEqual({ ok: false, message: '응답이 없어요. 다시 시도해 주세요.' })
    expect(Date.now() - started).toBeLessThan(3000)
    expect(status.token).toBe(true)
  })
  it('잘못된 사이트 · 줄바꿈 든 토큰은 저장 전에 거절', async () => {
    const j = jira(dir(), { allowLoopback: false })
    await expect(j.save({ site: 'http://127.0.0.1:1', email: 'me@example.com', token: SECRET })).rejects.toThrow(/https/)
    await expect(j.save({ site: 'https://acme.atlassian.net', email: 'me@example.com', token: 'a\nb' })).rejects.toThrow()
    expect((await j.status()).token).toBe(false)
  })
})

describe('Jira 목록 읽기', () => {
  it('POST /rest/api/3/search/jql 을 nextPageToken 으로 이어 읽고 100개에서 멈춘다', async () => {
    const f = await fake((q, body, res) => {
      if (q.url === '/rest/api/3/myself') return json(res, 200, { displayName: 'x' })
      const b = JSON.parse(body)
      const start = b.nextPageToken ? Number(b.nextPageToken) : 0
      // 한 페이지 30개 — 상한이 페이지 경계가 아닌 넷째 페이지 중간에서 잘라야 한다
      json(res, 200, { issues: Array.from({ length: 30 }, (_, i) => row(start + i + 1)), nextPageToken: String(start + 30) })
    })
    const j = jira(dir())
    await j.save({ site: f.url, email: 'me@example.com', token: SECRET })
    const page = await j.list(JIRA_DEFAULT_JQL)
    expect(JIRA_LIST_CAP).toBe(100)
    expect(page.items).toHaveLength(100)
    expect(page.items.at(-1)!.key).toBe('PROJ-100')
    expect(page.truncated).toBe(true)
    const searches = f.requests.filter((r) => r.path === '/rest/api/3/search/jql')
    expect(searches).toHaveLength(4)
    expect(JSON.parse(searches[0]!.body)).toEqual({ jql: JIRA_DEFAULT_JQL, fields: ['summary', 'status', 'duedate', 'assignee', 'project', 'issuetype', 'priority', 'updated'], maxResults: 50 })
    expect(JSON.parse(searches[1]!.body).nextPageToken).toBe('30')
  })
  it('마지막 페이지에서 멈추고 잘림 표시가 없다', async () => {
    const f = await fake((_q, body, res) => { const b = JSON.parse(body); json(res, 200, b.nextPageToken ? { issues: [row(3)], isLast: true } : { issues: [row(1), row(2)], nextPageToken: 'n2' }) })
    const j = jira(dir(), { env: { JIRA_SITE: f.url, JIRA_EMAIL: 'me@example.com', JIRA_API_TOKEN: SECRET } })
    const page = await j.list('project = PROJ')
    expect(page.items.map((i) => i.key)).toEqual(['PROJ-1', 'PROJ-2', 'PROJ-3'])
    expect(page.truncated).toBeUndefined()
  })
  it('진행 중 다시 읽으면 같은 요청을 기다린다(동시 요청 1)', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const f = await fake((_q, _b, res) => { void gate.then(() => json(res, 200, { issues: [row(1)] })) })
    const j = jira(dir(), { env: { JIRA_SITE: f.url, JIRA_EMAIL: 'me@example.com', JIRA_API_TOKEN: SECRET } })
    const a = j.list(JIRA_DEFAULT_JQL), b = j.list(JIRA_DEFAULT_JQL)
    await new Promise((r) => setTimeout(r, 100))
    release()
    expect((await a).items).toEqual((await b).items)
    expect(f.requests).toHaveLength(1)
  })
  it('401 뒤 토큰을 바꿔 저장하면 새 토큰으로 처음부터 읽는다', async () => {
    const f = await fake((req, _b, res) => {
      if (req.headers.authorization !== basic(OTHER)) return json(res, 401, {})
      if (req.url === '/rest/api/3/myself') return json(res, 200, { displayName: 'x' })
      json(res, 200, { issues: [row(1)] })
    })
    const j = jira(dir())
    await j.save({ site: f.url, email: 'me@example.com', token: SECRET })
    await expect(j.list(JIRA_DEFAULT_JQL)).rejects.toThrow(/401/)
    const saved = await j.save({ site: f.url, email: 'me@example.com', token: OTHER })
    expect(saved.check.ok).toBe(true)
    expect((await j.list(JIRA_DEFAULT_JQL)).items.map((i) => i.key)).toEqual(['PROJ-1'])
    const last = f.requests.at(-1)!
    expect(last.auth).toBe(basic(OTHER))
    expect(JSON.parse(last.body).nextPageToken).toBeUndefined()
  })
  it('401 · 403 · 404 · 410 · 429 · 끊김 · 응답 유실 · 15초 한도를 글자로 구별한다', async () => {
    const messages: string[] = []
    for (const status of [401, 403, 404, 410]) {
      const f = await fake((_q, _b, res) => json(res, status, { errorMessages: [SECRET] }))
      const e = await jira(dir(), { env: { JIRA_SITE: f.url, JIRA_EMAIL: 'me@example.com', JIRA_API_TOKEN: SECRET } }).list('x').catch((r: Error) => r.message)
      messages.push(String(e))
    }
    const limited = await fake((_q, _b, res) => json(res, 429, {}, { 'retry-after': '42' }))
    messages.push(String(await jira(dir(), { env: { JIRA_SITE: limited.url, JIRA_EMAIL: 'me@example.com', JIRA_API_TOKEN: SECRET } }).list('x').catch((r: Error) => r.message)))
    expect(messages.at(-1)).toContain('42초 뒤')
    // 끊김: 아무도 듣지 않는 포트
    const gone = await fake(() => {}); await gone.close(); servers.splice(servers.indexOf(gone), 1)
    messages.push(String(await jira(dir(), { env: { JIRA_SITE: gone.url, JIRA_EMAIL: 'me@example.com', JIRA_API_TOKEN: SECRET } }).list('x').catch((r: Error) => r.message)))
    expect(messages.at(-1)).toContain('연결하지 못했어요')
    // 응답 유실: 머리만 보내고 본문 중간에 소켓을 끊는다
    const lost = await fake((_q, _b, res) => { res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' }); res.write('{"issues":['); setTimeout(() => res.socket?.destroy(), 20) })
    messages.push(String(await jira(dir(), { env: { JIRA_SITE: lost.url, JIRA_EMAIL: 'me@example.com', JIRA_API_TOKEN: SECRET } }).list('x').catch((r: Error) => r.message)))
    expect(messages.at(-1)).toContain('중간에 끊겼어요')
    // 붙는 중 한도: 답하지 않는 서버 → 한도(시험은 300ms) 뒤 '응답이 없어요'
    const hang = await fake(() => {})
    const started = Date.now()
    messages.push(String(await jira(dir(), { timeoutMs: 300, env: { JIRA_SITE: hang.url, JIRA_EMAIL: 'me@example.com', JIRA_API_TOKEN: SECRET } }).list('x').catch((r: Error) => r.message)))
    expect(messages.at(-1)).toContain('응답이 없어요')
    expect(Date.now() - started).toBeLessThan(3000)
    expect(new Set(messages).size).toBe(messages.length)
    for (const m of messages) { expect(m.startsWith('[jira] ')).toBe(true); expect(m).not.toContain(SECRET) }
  })
  it('토큰 없이 읽으면 저장 안내, 이슈 하나 다시 읽기는 GET /rest/api/3/issue/{id}', async () => {
    await expect(jira(dir()).list('x')).rejects.toThrow(/먼저 저장/)
    const f = await fake((_q, _b, res) => json(res, 200, row(7)))
    const issue = await jira(dir(), { env: { JIRA_SITE: f.url, JIRA_EMAIL: 'me@example.com', JIRA_API_TOKEN: SECRET } }).issue('10007')
    expect(issue.key).toBe('PROJ-7')
    expect(f.requests[0]!.path).toBe('/rest/api/3/issue/10007?fields=summary,status,duedate,assignee,project,issuetype,priority,updated')
  })
})
