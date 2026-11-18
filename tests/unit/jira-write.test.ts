import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JIRA_COMMENT_MAX, JIRA_WRITE_LOG, jiraAdf, jiraAdfText, jiraCommentPosted, jiraCommentText, jiraIssueError, jiraTransitions } from '../../src/shared/jira-write'
import { Jira, type Cipher } from '../../src/main/jira'

// 가짜 Jira — 실제 Atlassian 에 접속하지 않는다(127.0.0.1 · 주입한 가짜 인증만). 실제 워크플로 · 권한 · ADF 정리는 흉내 내지 않는다.
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
const json = (res: ServerResponse, status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
const cipher: Cipher = { available: () => true, encrypt: (t) => Buffer.from('ENC:' + t), decrypt: (b) => b.toString().slice(4) }
const SECRET = 'ATATT3xFfGF0' + 'Q'.repeat(60)
const OTHER = 'ATATT3xFfGF0' + 'Z'.repeat(60)
const EMAIL = 'me@example.com'
const basic = (token: string) => 'Basic ' + Buffer.from(`${EMAIL}:${token}`).toString('base64')
function dir() { const d = realpathSync(mkdtempSync(join(tmpdir(), 'tm-jira-write-'))); dirs.push(d); return d }
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))
const TRANSITIONS = [
  { id: '21', name: '진행 시작', to: { id: '20', name: 'In Progress', statusCategory: { key: 'indeterminate' } } },
  { id: '31', name: 'Done', to: { id: '30', name: 'Done', statusCategory: { key: 'done' } } },
]
type Post = 'ok' | 'drop' | 'landed-drop' | 'hang' | number
type Read = 'ok' | 'drop' | number
interface World { status: string; comments: Array<{ id: string; author: { accountId: string }; created: string; body: unknown }>; posts: number; release(): void }
/** 상태가 있는 가짜 Jira — post · read 로 쓰기 · 읽기 요청마다 어떻게 답할지 정한다 */
async function world(o: { post?: (n: number) => Post; read?: (path: string) => Read; gate?: boolean } = {}) {
  let release!: () => void
  const gate = o.gate ? new Promise<void>((r) => { release = r }) : Promise.resolve()
  const w: World = { status: '10', comments: [], posts: 0, release: () => release?.() }
  const f = await fake((req, body, res) => {
    const path = req.url ?? ''
    if (req.method === 'GET') {
      const how = o.read?.(path) ?? 'ok'
      if (how === 'drop') return void req.socket.destroy()
      if (typeof how === 'number') return json(res, how, { errorMessages: [SECRET] })
      if (path === '/rest/api/3/myself') return json(res, 200, { accountId: 'me-1', displayName: '나' })
      if (/^\/rest\/api\/3\/issue\/[A-Z]+-\d+\/transitions$/.test(path)) return json(res, 200, { transitions: TRANSITIONS })
      if (/^\/rest\/api\/3\/issue\/[A-Z]+-\d+\?fields=status$/.test(path)) return json(res, 200, { id: '10007', key: 'PROJ-7', fields: { status: { id: w.status, name: w.status === '30' ? 'Done' : 'To Do' } } })
      if (/^\/rest\/api\/3\/issue\/[A-Z]+-\d+\/comment\?orderBy=-created&maxResults=20$/.test(path)) return json(res, 200, { comments: w.comments })
      return json(res, 404, {})
    }
    const n = ++w.posts
    const how = o.post?.(n) ?? 'ok'
    const land = () => {
      if (path.endsWith('/transitions')) w.status = TRANSITIONS.find((t) => t.id === JSON.parse(body).transition.id)!.to.id
      else w.comments.unshift({ id: String(n), author: { accountId: 'me-1' }, created: new Date().toISOString(), body: JSON.parse(body).body })
    }
    if (how === 'hang') return
    if (how === 'drop') return void req.socket.destroy()
    if (how === 'landed-drop') { land(); return void req.socket.destroy() }
    if (typeof how === 'number') return json(res, how, { errorMessages: [SECRET] })
    void gate.then(() => {
      land()
      if (path.endsWith('/transitions')) { res.writeHead(204); res.end() } else json(res, 201, { id: String(n) })
    })
  })
  const j = new Jira({ dir: dir(), cipher, env: { JIRA_SITE: f.url, JIRA_EMAIL: EMAIL, JIRA_API_TOKEN: SECRET }, allowLoopback: true, timeoutMs: 1500 })
  const posts = () => f.requests.filter((r) => r.method === 'POST')
  return { f, j, w, posts }
}
const adf = (...lines: string[]) => ({ type: 'doc', version: 1, content: lines.map((line) => ({ type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [] })) })

describe('Jira 쓰기 순수 규칙', () => {
  it('전환 목록 — 이름을 가리고 · 모양이 다른 줄은 버리고 · 50개에서 멈춘다', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ id: String(100 + i), name: `전환 ${i}`, to: { id: String(i), name: `상태 ${i}`, statusCategory: { key: 'new' } } }))
    const list = jiraTransitions({ transitions: [
      { id: '21', name: '토큰 ghp_' + 'a'.repeat(36) + ' 로', to: { id: '20', name: 'In\nProgress', statusCategory: { key: 'indeterminate' } } },
      { id: 'x', name: '번호가 아님', to: { id: '1', name: 'a' } },
      { id: '22', name: '목표 없음' },
      { id: '21', name: '같은 번호 다시', to: { id: '20', name: 'In Progress' } },
      ...many,
    ] })
    expect(list).toHaveLength(50)
    expect(list[0]).toEqual({ id: '21', name: expect.not.stringContaining('ghp_aaaa'), to: { id: '20', name: 'In Progress', category: 'indeterminate' } })
    expect(list[1]).toEqual({ id: '100', name: '전환 0', to: { id: '0', name: '상태 0', category: 'new' } })
    expect(() => jiraTransitions({ nope: [] })).toThrow(/\[jira\]/)
  })
  it('댓글 글 — 빈 글 · 긴 글은 거절하고 줄바꿈은 문단, 빈 줄은 빈 문단인 ADF 로', () => {
    expect(() => jiraCommentText('')).toThrow(/비어/)
    expect(() => jiraCommentText('  \n \n')).toThrow(/비어/)
    expect(() => jiraCommentText(42)).toThrow()
    expect(() => jiraCommentText('가'.repeat(JIRA_COMMENT_MAX + 1))).toThrow(/8,000/)
    expect(jiraCommentText('가'.repeat(JIRA_COMMENT_MAX))).toHaveLength(JIRA_COMMENT_MAX)
    const text = jiraCommentText('\n첫 줄\r\n\r\n셋째 줄  \n\n')
    expect(text).toBe('첫 줄\n\n셋째 줄')
    expect(jiraAdf(text)).toEqual(adf('첫 줄', '', '셋째 줄'))
    expect(jiraAdfText(jiraAdf(text))).toBe(text)
    expect(jiraAdfText({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }, { type: 'hardBreak' }, { type: 'text', text: 'b', marks: [{ type: 'strong' }] }] }] })).toBe('a\nb')
    expect(jiraAdfText(null)).toBe('')
  })
  it('남긴 댓글 찾기 — 내 계정 · 요청 시작 뒤 · 같은 글이 모두 맞아야 한다', () => {
    const at = Date.parse('2026-11-18T10:00:00.000+0900')
    const row = (author: string, created: string, text: string) => ({ author: { accountId: author }, created, body: adf(...text.split('\n')) })
    const found = (rows: unknown[]) => jiraCommentPosted({ comments: rows }, 'me-1', '확인했어요\n\n배포는 내일', at)
    expect(found([row('me-1', '2026-11-18T10:00:03.000+0900', '확인했어요\n\n배포는 내일')])).toBe(true)
    expect(found([row('other', '2026-11-18T10:00:03.000+0900', '확인했어요\n\n배포는 내일')])).toBe(false)
    expect(found([row('me-1', '2026-11-18T09:40:00.000+0900', '확인했어요\n\n배포는 내일')])).toBe(false)
    expect(found([row('me-1', '2026-11-18T10:00:03.000+0900', '확인했어요')])).toBe(false)
    expect(found([row('me-1', '날짜 아님', '확인했어요\n\n배포는 내일')])).toBe(false)
    expect(() => jiraCommentPosted({}, 'me-1', 'x', at)).toThrow(/\[jira\]/)
  })
  it('이슈 요청의 거절 글 — 전환 400 은 목록을 다시 고르게, 404 는 이슈를 못 찾음', () => {
    expect(jiraIssueError('transition', 400, null)).toMatch(/전환 목록.*다시 골라/)
    expect(jiraIssueError('comment', 400, null)).toMatch(/댓글/)
    expect(jiraIssueError('issue', 404, null)).toMatch(/이슈를 찾지 못했어요\(404\)/)
    expect(jiraIssueError('comment', 401, null)).toMatch(/401/)
    expect(jiraIssueError('transition', 429, '30')).toContain('30초 뒤')
  })
})

describe('Jira 전환 목록 · 쓰기 한 번', () => {
  it('전환 목록은 GET /rest/api/3/issue/{key}/transitions — 잘못된 키는 보내지 않는다', async () => {
    const { f, j } = await world()
    expect(await j.transitions('PROJ-7')).toEqual([
      { id: '21', name: '진행 시작', to: { id: '20', name: 'In Progress', category: 'indeterminate' } },
      { id: '31', name: 'Done', to: { id: '30', name: 'Done', category: 'done' } },
    ])
    expect(f.requests).toEqual([{ method: 'GET', path: '/rest/api/3/issue/PROJ-7/transitions', auth: basic(SECRET), body: '' }])
    await expect(j.transitions('PROJ-7/../../x')).rejects.toThrow(/\[jira\]/)
    await expect(j.transitions('proj 7')).rejects.toThrow(/\[jira\]/)
    expect(f.requests).toHaveLength(1)
  })
  it('전환은 POST …/transitions 에 {"transition":{"id"}} 를 한 번 보내고 204 면 됨', async () => {
    const { j, w, posts } = await world()
    await j.transitions('PROJ-7')
    expect(await j.transition('PROJ-7', '31', 'req-1')).toEqual({ requestId: 'req-1', kind: 'transition', key: 'PROJ-7', status: 'done', message: '' })
    expect(posts()).toEqual([{ method: 'POST', path: '/rest/api/3/issue/PROJ-7/transitions', auth: basic(SECRET), body: '{"transition":{"id":"31"}}' }])
    expect(w.status).toBe('30')
    expect(j.writeState('req-1')).toMatchObject({ status: 'done' })
    expect(j.writeState('never')).toBeNull()
  })
  it('댓글은 POST …/comment 에 ADF 로 — 줄바꿈은 문단, 빈 줄은 빈 문단', async () => {
    const { j, posts } = await world()
    expect(await j.comment('PROJ-7', '확인했어요\n\n배포는 내일', 'req-c')).toMatchObject({ kind: 'comment', key: 'PROJ-7', status: 'done' })
    expect(posts()).toHaveLength(1)
    expect(posts()[0]).toMatchObject({ method: 'POST', path: '/rest/api/3/issue/PROJ-7/comment', auth: basic(SECRET) })
    expect(JSON.parse(posts()[0]!.body)).toEqual({ body: adf('확인했어요', '', '배포는 내일') })
  })
  it('잘못된 키 · 전환 · 요청 번호 · 빈 글 · 긴 글 · 목록에 없던 전환은 보내기 전에 거절한다', async () => {
    const { f, j } = await world()
    await j.transitions('PROJ-7')
    const before = f.requests.length
    await expect(j.transition('bad key', '31', 'r1')).rejects.toThrow(/\[jira\]/)
    await expect(j.transition('PROJ-7', '31; drop', 'r1')).rejects.toThrow(/\[jira\]/)
    await expect(j.transition('PROJ-7', '31', 'r 1')).rejects.toThrow(/\[jira\]/)
    await expect(j.transition('PROJ-7', '99', 'r1')).rejects.toThrow(/전환 목록/)
    await expect(j.transition('PROJ-8', '31', 'r1')).rejects.toThrow(/전환 목록/)
    await expect(j.comment('bad key', '글', 'r2')).rejects.toThrow(/\[jira\]/)
    await expect(j.comment('PROJ-7', '  \n ', 'r2')).rejects.toThrow(/비어/)
    await expect(j.comment('PROJ-7', '가'.repeat(JIRA_COMMENT_MAX + 1), 'r2')).rejects.toThrow(/8,000/)
    await expect(j.comment('PROJ-7', '글', '')).rejects.toThrow(/\[jira\]/)
    expect(() => j.writeState('r 1')).toThrow(/\[jira\]/)
    expect(f.requests).toHaveLength(before)
    // 거절된 번호는 기록에 없다 — 고쳐서 같은 번호로 보낼 수 있다
    expect(j.writeState('r1')).toBeNull()
    expect(await j.transition('PROJ-7', '31', 'r1')).toMatchObject({ status: 'done' })
  })
  it('토큰 없이 쓰면 저장 안내 — 기록을 만들지 않는다', async () => {
    const j = new Jira({ dir: dir(), cipher, env: {}, allowLoopback: true })
    await expect(j.comment('PROJ-7', '글', 'r1')).rejects.toThrow(/먼저 저장/)
    expect(j.writeState('r1')).toBeNull()
  })
})

describe('Jira 쓰기 — 요청 번호로 한 번만', () => {
  it('이중 입력: 같은 번호를 동시에 두 번 → 서버는 한 번만 받는다', async () => {
    const { j, w, posts } = await world({ gate: true })
    await j.transitions('PROJ-7')
    const a = j.transition('PROJ-7', '31', 'req-1'), b = j.transition('PROJ-7', '31', 'req-1')
    const c = j.comment('PROJ-7', '같은 글', 'req-2'), d = j.comment('PROJ-7', '같은 글', 'req-2')
    await pause(100)
    expect(j.writeState('req-1')).toMatchObject({ status: 'pending' })
    w.release()
    expect(await Promise.all([a, b, c, d])).toMatchObject([{ status: 'done' }, { status: 'done' }, { status: 'done' }, { status: 'done' }])
    expect(posts().map((r) => r.path)).toEqual(['/rest/api/3/issue/PROJ-7/transitions', '/rest/api/3/issue/PROJ-7/comment'])
  })
  it('끝난 번호를 다시 부르면 저장된 결과만 돌려주고 서버에 가지 않는다 · 내용이 다르면 거절', async () => {
    const { f, j } = await world()
    await j.transitions('PROJ-7')
    const first = await j.transition('PROJ-7', '31', 'req-1')
    await j.comment('PROJ-7', '글 하나', 'req-2')
    const before = f.requests.length
    expect(await j.transition('PROJ-7', '31', 'req-1')).toEqual(first)
    expect(await j.comment('PROJ-7', '글 하나', 'req-2')).toMatchObject({ status: 'done' })
    await expect(j.transition('PROJ-7', '21', 'req-1')).rejects.toThrow(/다른 요청/)
    await expect(j.comment('PROJ-7', '다른 글', 'req-2')).rejects.toThrow(/다른 요청/)
    await expect(j.comment('PROJ-7', '글 하나', 'req-1')).rejects.toThrow(/다른 요청/)
    expect(f.requests).toHaveLength(before)
  })
  it('결과를 모를 때: 서버가 받고 응답 전에 끊으면 unknown — 자동으로 다시 보내지 않는다', async () => {
    const { j, posts } = await world({ post: (n) => (n === 1 ? 'drop' : 'ok') })
    await j.transitions('PROJ-7')
    expect(await j.transition('PROJ-7', '31', 'req-1')).toMatchObject({ status: 'unknown', message: expect.stringMatching(/끊겼어요/) })
    await pause(150)
    expect(posts()).toHaveLength(1)
    expect(j.writeState('req-1')).toMatchObject({ status: 'unknown' })
  })
  it('5xx · 답 없음(한도)도 unknown 이고 다시 보내지 않는다', async () => {
    const five = await world({ post: () => 503 })
    const lost = await five.j.comment('PROJ-7', '글', 'req-5')
    expect(lost).toMatchObject({ status: 'unknown', message: expect.stringContaining('503') })
    expect(JSON.stringify(lost)).not.toContain(SECRET)
    const hang = await world({ post: () => 'hang' })
    const j = new Jira({ dir: dir(), cipher, env: { JIRA_SITE: hang.f.url, JIRA_EMAIL: EMAIL, JIRA_API_TOKEN: SECRET }, allowLoopback: true, timeoutMs: 300 })
    expect(await j.comment('PROJ-7', '글', 'req-h')).toMatchObject({ status: 'unknown', message: expect.stringMatching(/응답이 없어요/) })
    await pause(100)
    expect(five.posts()).toHaveLength(1)
    expect(hang.posts()).toHaveLength(1)
  })
  it('4xx 는 안 됨으로 확정 — 같은 번호는 다시 보내지 않고 토큰 · 이메일이 글에 없다', async () => {
    const { f, j, posts } = await world({ post: (n) => (n === 1 ? 403 : 400) })
    await j.transitions('PROJ-7')
    const denied = await j.comment('PROJ-7', '글', 'req-1')
    expect(denied).toMatchObject({ status: 'failed', message: expect.stringContaining('403') })
    const stale = await j.transition('PROJ-7', '31', 'req-2')
    expect(stale).toMatchObject({ status: 'failed', message: expect.stringMatching(/400.*전환 목록/) })
    const before = f.requests.length
    expect(await j.comment('PROJ-7', '글', 'req-1')).toEqual(denied)
    expect(await j.transition('PROJ-7', '31', 'req-2')).toEqual(stale)
    expect(f.requests).toHaveLength(before)
    expect(posts()).toHaveLength(2)
    for (const s of [denied, stale, j.writeState('req-1')]) { expect(JSON.stringify(s)).not.toContain(SECRET); expect(JSON.stringify(s)).not.toContain(EMAIL) }
  })
})

describe('Jira 쓰기 — 됐는지 모를 때 같은 번호로 다시', () => {
  it('전환: 상태가 이미 목표면 다시 보내지 않고 됨', async () => {
    const { f, j, posts } = await world({ post: (n) => (n === 1 ? 'landed-drop' : 'ok') })
    await j.transitions('PROJ-7')
    expect(await j.transition('PROJ-7', '31', 'req-1')).toMatchObject({ status: 'unknown' })
    expect(await j.transition('PROJ-7', '31', 'req-1')).toMatchObject({ status: 'done', message: '' })
    expect(posts()).toHaveLength(1)
    expect(f.requests.at(-1)).toMatchObject({ method: 'GET', path: '/rest/api/3/issue/PROJ-7?fields=status' })
  })
  it('전환: 아직 목표가 아니면 그때만 다시 보낸다', async () => {
    const { j, w, posts } = await world({ post: (n) => (n === 1 ? 'drop' : 'ok') })
    await j.transitions('PROJ-7')
    expect(await j.transition('PROJ-7', '31', 'req-1')).toMatchObject({ status: 'unknown' })
    expect(await j.transition('PROJ-7', '31', 'req-1')).toMatchObject({ status: 'done' })
    expect(posts()).toHaveLength(2)
    expect(w.status).toBe('30')
  })
  it('댓글: 내가 요청 시작 뒤에 쓴 같은 글이 있으면 다시 보내지 않는다', async () => {
    const { f, j, w, posts } = await world({ post: (n) => (n === 1 ? 'landed-drop' : 'ok') })
    expect(await j.comment('PROJ-7', '확인했어요\n\n배포는 내일', 'req-1')).toMatchObject({ status: 'unknown' })
    expect(await j.comment('PROJ-7', '확인했어요\n\n배포는 내일', 'req-1')).toMatchObject({ status: 'done' })
    expect(posts()).toHaveLength(1)
    expect(w.comments).toHaveLength(1)
    expect(f.requests.slice(-2).map((r) => r.path)).toEqual(['/rest/api/3/myself', '/rest/api/3/issue/PROJ-7/comment?orderBy=-created&maxResults=20'])
  })
  it('댓글: 남의 같은 글 · 내 옛 같은 글 · 내 다른 글만 있으면 다시 보낸다', async () => {
    const { j, w, posts } = await world({ post: (n) => (n === 1 ? 'drop' : 'ok') })
    w.comments.push(
      { id: 'a', author: { accountId: 'other' }, created: new Date().toISOString(), body: adf('확인했어요') },
      { id: 'b', author: { accountId: 'me-1' }, created: new Date(Date.now() - 600_000).toISOString(), body: adf('확인했어요') },
      { id: 'c', author: { accountId: 'me-1' }, created: new Date().toISOString(), body: adf('다른 글') },
    )
    expect(await j.comment('PROJ-7', '확인했어요', 'req-1')).toMatchObject({ status: 'unknown' })
    expect(await j.comment('PROJ-7', '확인했어요', 'req-1')).toMatchObject({ status: 'done' })
    expect(posts()).toHaveLength(2)
    expect(w.comments).toHaveLength(4)
  })
  it('확인 요청이 실패하면 unknown 그대로 — 보내지 않는다. 확인이 되면 그때 정한다', async () => {
    let broken: Read = 'drop'
    const { j, posts } = await world({ post: (n) => (n <= 2 ? 'landed-drop' : 'ok'), read: (path) => (path.includes('fields=status') || path.includes('/comment?') ? broken : 'ok') })
    await j.transitions('PROJ-7')
    expect(await j.transition('PROJ-7', '31', 'req-1')).toMatchObject({ status: 'unknown' })
    expect(await j.comment('PROJ-7', '글', 'req-2')).toMatchObject({ status: 'unknown' })
    expect(await j.transition('PROJ-7', '31', 'req-1')).toMatchObject({ status: 'unknown', message: expect.stringMatching(/끊겼어요/) })
    broken = 404
    expect(await j.comment('PROJ-7', '글', 'req-2')).toMatchObject({ status: 'unknown', message: expect.stringContaining('404') })
    expect(posts()).toHaveLength(2)
    broken = 'ok'
    expect(await j.transition('PROJ-7', '31', 'req-1')).toMatchObject({ status: 'done' })
    expect(await j.comment('PROJ-7', '글', 'req-2')).toMatchObject({ status: 'done' })
    expect(posts()).toHaveLength(2)
  })
  it('다시 시도가 도는 중에 같은 번호가 또 오면 그 확인에 합친다', async () => {
    const { f, j, posts } = await world({ post: (n) => (n === 1 ? 'landed-drop' : 'ok') })
    await j.transitions('PROJ-7')
    await j.transition('PROJ-7', '31', 'req-1')
    const before = f.requests.length
    const [a, b] = await Promise.all([j.transition('PROJ-7', '31', 'req-1'), j.transition('PROJ-7', '31', 'req-1')])
    expect([a.status, b.status]).toEqual(['done', 'done'])
    expect(f.requests).toHaveLength(before + 1)
    expect(posts()).toHaveLength(1)
  })
})

describe('Jira 쓰기 기록 · 인증 바뀜', () => {
  it(`기록은 ${JIRA_WRITE_LOG}개까지 — 오래된 끝난 것부터 지우고 진행 중은 지우지 않는다`, async () => {
    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    const f = await fake((req, _b, res) => {
      const reply = () => json(res, 201, { id: '1' })
      if (req.url === '/rest/api/3/issue/HOLD-1/comment') void held.then(reply)
      else reply()
    })
    const j = new Jira({ dir: dir(), cipher, env: { JIRA_SITE: f.url, JIRA_EMAIL: EMAIL, JIRA_API_TOKEN: SECRET }, allowLoopback: true })
    const pending = j.comment('HOLD-1', '붙잡힌 글', 'held')
    for (let i = 0; i < JIRA_WRITE_LOG; i++) expect((await j.comment('PROJ-7', `글 ${i}`, `r${i}`)).status).toBe('done')
    // 201번째가 들어올 때 가장 오래된 '끝난' 기록(r0)이 나가고, 더 오래된 진행 중(held)은 남는다
    expect(j.writeState('held')).toMatchObject({ status: 'pending' })
    expect(j.writeState('r0')).toBeNull()
    expect(j.writeState('r1')).toMatchObject({ status: 'done' })
    expect(j.writeState(`r${JIRA_WRITE_LOG - 1}`)).toMatchObject({ status: 'done' })
    release()
    expect(await pending).toMatchObject({ status: 'done' })
  }, 30_000)
  it('인증이 바뀌어도 진행 중 쓰기는 끝까지 가고, 같은 번호의 새 호출은 합쳐지지 않는다', async () => {
    const { f, j, w, posts } = await world({ gate: true })
    const running = j.comment('PROJ-7', '옛 인증으로 보낸 글', 'req-1')
    await pause(100)
    await j.save({ site: f.url, email: EMAIL, token: OTHER })
    await expect(j.comment('PROJ-7', '옛 인증으로 보낸 글', 'req-1')).rejects.toThrow(/인증이 바뀌/)
    expect(j.writeState('req-1')).toMatchObject({ status: 'pending' })
    w.release()
    expect(await running).toMatchObject({ status: 'done' })
    expect(posts()).toHaveLength(1)
    expect(posts()[0]!.auth).toBe(basic(SECRET))
    // 끝난 결과는 인증이 바뀐 뒤에도 그대로 돌려준다(보내지 않는다)
    expect(await j.comment('PROJ-7', '옛 인증으로 보낸 글', 'req-1')).toMatchObject({ status: 'done' })
    expect(posts()).toHaveLength(1)
  })
  it('인증이 바뀐 뒤에는 옛 인증의 unknown 을 다시 확인 · 다시 보내지 않고, 전환 목록도 새로 읽어야 한다', async () => {
    const { f, j, posts } = await world({ post: () => 'drop' })
    await j.transitions('PROJ-7')
    expect(await j.transition('PROJ-7', '31', 'req-1')).toMatchObject({ status: 'unknown' })
    await j.save({ site: f.url, email: EMAIL, token: OTHER })
    const before = f.requests.length
    await expect(j.transition('PROJ-7', '31', 'req-1')).rejects.toThrow(/인증이 바뀌/)
    await expect(j.transition('PROJ-7', '31', 'req-new')).rejects.toThrow(/전환 목록/)
    expect(f.requests).toHaveLength(before)
    expect(posts()).toHaveLength(1)
    expect(j.writeState('req-1')).toMatchObject({ status: 'unknown' })
  })
})
