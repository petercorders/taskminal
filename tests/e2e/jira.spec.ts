import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { captureWindow, firstWindow, seedState, waitLoaded } from './helpers'

// 55단계 Jira 읽기 — 가짜 Jira(이 파일 안의 node http)만 부른다. 실제 Atlassian 의 필드 · 권한 · 한도는 흉내 내지 않는다.
// safeStorage 는 실제 키체인을 건드리지 않게 TASKMINAL_JIRA_NO_SAFE_STORAGE 로 끄고 '이번 실행 메모리' 길을 본다(암호화 파일 길은 단위 시험).
const GOOD = 'ATATT3xGood0' + 'G'.repeat(50)
const BAD = 'ATATT3xBad00' + 'B'.repeat(50)
const basic = (token: string) => 'Basic ' + Buffer.from(`me@example.com:${token}`).toString('base64')
const day = (offset: number) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const row = (n: number, due: string, summary: string) => ({ id: String(10000 + n), key: `PROJ-${n}`, fields: { summary, status: { name: '할 일', statusCategory: { key: 'new' } }, duedate: due, assignee: { displayName: '가짜 담당' }, project: { key: 'PROJ', name: '가짜 프로젝트' }, issuetype: { name: 'Task' }, priority: { name: 'High' }, updated: '2026-11-15T10:00:00.000+0900' } })
const rows = () => [row(7, day(-1), '마감 지난 이슈 <b>굵게</b>'), row(8, day(5), '앞으로 마감 이슈')]
const fake = { mode: 'ok' as 'ok' | 'hang' | 'drop', slowJql: '', requests: [] as Array<{ path: string; auth: string; body: string }> }
let server: Server, site: string
let data: string, app: ElectronApplication, win: Page

test.beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      fake.requests.push({ path: req.url ?? '', auth: req.headers.authorization ?? '', body })
      const send = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
      if (req.headers.authorization !== basic(GOOD)) return send(401, { errorMessages: ['가짜 401'] })
      if (req.url === '/rest/api/3/myself') return send(200, { displayName: '가짜 사용자' })
      if (req.url?.startsWith('/rest/api/3/issue/')) { const r = rows().find((x) => req.url!.startsWith(`/rest/api/3/issue/${x.id}?`)); return r ? send(200, r) : send(404, {}) }
      if (req.url !== '/rest/api/3/search/jql') return send(404, {})
      if (fake.mode === 'hang') return
      if (fake.mode === 'drop') { res.writeHead(200, { 'content-type': 'application/json', 'content-length': '500' }); res.write('{"issues":['); setTimeout(() => res.socket?.destroy(), 20); return }
      if (JSON.parse(body).jql === fake.slowJql) return void setTimeout(() => send(200, { issues: [row(9, day(10), '늦게 온 옛 응답')] }), 800)
      send(200, { issues: rows() })
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
test.afterAll(async () => { server.closeAllConnections(); await new Promise((done) => server.close(done)) })

const panel = () => win.getByTestId('issues-panel')
async function launch(env: Record<string, string> = {}) {
  app = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: data, TASKMINAL_JIRA_NO_SAFE_STORAGE: '1', TASKMINAL_JIRA_TIMEOUT_MS: '1500', JIRA_SITE: '', JIRA_EMAIL: '', JIRA_API_TOKEN: '', TASKMINAL_CLAUDE_BIN: resolve('tests/fixtures/fake-claude.mjs'), FAKE_CLAUDE_LOG: join(data, 'claude.log'), ...env } })
  win = await firstWindow(app)
  await waitLoaded(win)
}
const envAuth = { JIRA_SITE: '', JIRA_EMAIL: 'me@example.com', JIRA_API_TOKEN: GOOD }
async function openJira() {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('app:command', 'issues'))
  await panel().getByRole('combobox', { name: '이슈 서비스', exact: true }).selectOption('jira')
  await expect(panel().getByRole('textbox', { name: 'JQL', exact: true })).toHaveValue('assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC')
}
const search = () => panel().getByRole('button', { name: '이슈 조회', exact: true }).click()
const issueButton = (key: string) => panel().getByRole('button', { name: new RegExp(`^${key} · `) })
/** 글자색과 겹친 배경으로 대비를 잰다 (readability.spec 과 같은 식) */
const contrastOf = (selector: string) => win.evaluate((sel) => {
  const parse = (c: string) => { const m = c.match(/[\d.]+/g)!.map(Number); return [m[0]!, m[1]!, m[2]!, m[3] ?? 1] }
  const over = (a: number[], b: number[]) => [0, 1, 2].map((i) => a[i]! * a[3]! + b[i]! * (1 - a[3]!)).concat(1)
  const lum = (c: number[]) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(c[0]!) + 0.7152 * f(c[1]!) + 0.0722 * f(c[2]!) }
  const el = document.querySelector(sel)
  if (!el) return null
  const layers: number[][] = []
  for (let e: Element | null = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c[3]! > 0) layers.push(c); if (c[3]! >= 1) break }
  let bg = [0, 0, 0, 1]
  for (const l of layers.reverse()) bg = over(l, bg)
  const fg = over(parse(getComputedStyle(el).color), bg)
  const [a, b] = [lum(fg), lum(bg)]
  return { contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), size: parseFloat(getComputedStyle(el).fontSize) }
}, selector)

test.describe.configure({ timeout: 90_000 })
test.beforeEach(async () => {
  data = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-jira-')))
  mkdirSync(join(data, 'work'))
  seedState(data, [{ id: 'task', name: 'Jira 검증', paneId: 'shell', cwd: join(data, 'work') }, { id: 'other', name: '다른 일감', paneId: 'shell2', cwd: join(data, 'work') }])
  fake.mode = 'ok'; fake.slowJql = ''; fake.requests.length = 0
})
test.afterEach(async () => {
  await app?.close()
  rmSync(data, { recursive: true, force: true, maxRetries: 5 })
})

test('인증 저장 — 401 뒤 토큰을 바꿔 저장하면 새 토큰으로 처음부터 읽고, 토큰은 화면 · 상태 파일 · status 에 없다', async () => {
  await launch()
  await openJira()
  const auth = panel().getByTestId('jira-auth')
  await expect(auth).toHaveAttribute('open', '')
  await expect(auth).toContainText('저장한 토큰이 없어요')
  await auth.getByRole('textbox', { name: 'Jira 사이트', exact: true }).fill(site)
  await auth.getByRole('textbox', { name: 'Jira 이메일', exact: true }).fill('me@example.com')
  await auth.getByLabel('Jira API 토큰', { exact: true }).fill(BAD)
  await auth.getByRole('button', { name: '저장하고 연결 확인', exact: true }).click()
  // 연결 확인이 실패해도 저장한 토큰은 남고 오류를 보인다
  await expect(auth.getByTestId('jira-auth-note')).toContainText('토큰은 저장했어요')
  await expect(auth.getByTestId('jira-auth-note')).toContainText('401')
  await expect(auth.getByLabel('Jira API 토큰', { exact: true })).toHaveValue('')
  const status = await win.evaluate(() => window.taskminal.jira.status())
  expect(status).toMatchObject({ token: true, storage: 'memory', encryption: false, site })
  expect(status.notice).toContain('이번 실행')
  expect(JSON.stringify(status)).not.toContain(BAD)
  await search()
  await expect(panel().getByTestId('jira-list-error')).toContainText('401')
  // 토큰을 바꿔 저장 → 새 토큰으로 처음부터
  await auth.getByLabel('Jira API 토큰', { exact: true }).fill(GOOD)
  await auth.getByRole('button', { name: '저장하고 연결 확인', exact: true }).click()
  await expect(auth.getByTestId('jira-auth-note')).toContainText('가짜 사용자 계정으로 연결했어요')
  await expect(issueButton('PROJ-7')).toContainText('마감 지남')
  const last = fake.requests.filter((r) => r.path === '/rest/api/3/search/jql').at(-1)!
  expect(last.auth).toBe(basic(GOOD))
  expect(JSON.parse(last.body).nextPageToken).toBeUndefined()
  // 비신뢰 제목은 글자로만 — HTML 로 넣지 않는다
  await expect(issueButton('PROJ-7')).toContainText('<b>굵게</b>')
  expect(await issueButton('PROJ-7').locator('b').count()).toBe(0)
  await issueButton('PROJ-7').click()
  await expect(panel().getByRole('region', { name: '선택한 이슈' })).toContainText('담당: 가짜 담당')
  await captureWindow(app, 'test-results/jira-panel.png')
  // 토큰은 renderer 의 글 · 입력 · 저장소, state.json, 앱 폴더 어디에도 없다(메모리 길이라 jira-auth.bin 도 없다)
  const page = await win.evaluate(() => document.body.innerText + Array.from(document.querySelectorAll('input')).map((i) => i.value).join('\n') + JSON.stringify(localStorage) + JSON.stringify(sessionStorage))
  for (const t of [GOOD, BAD]) expect(page).not.toContain(t)
  // 지우기 단추
  await auth.getByRole('button', { name: '저장한 토큰 지우기', exact: true }).click()
  await expect(auth.getByTestId('jira-auth-note')).toHaveText('저장한 토큰을 지웠어요.')
  expect((await win.evaluate(() => window.taskminal.jira.status())).token).toBe(false)
  // 상태를 한 번 바꿔 state.json 을 다시 쓰게 한 뒤 토큰이 없는지 본다
  const before = readFileSync(join(data, 'state.json'), 'utf8')
  await win.locator('[data-testid="task-row"]', { hasText: '다른 일감' }).locator('.task-main').click()
  await expect.poll(() => readFileSync(join(data, 'state.json'), 'utf8') !== before).toBe(true)
  for (const t of [GOOD, BAD]) expect(readFileSync(join(data, 'state.json'), 'utf8')).not.toContain(t)
  expect(readdirSync(data)).not.toContain('jira-auth.bin')
})

test('이슈로 일감 만들기 — 같은 프레임 두 번 눌러도 일감 하나, 사이드바 · 일감 머리에 키와 마감 지남, 재시작 뒤 유지', async () => {
  await launch({ ...envAuth, JIRA_SITE: site })
  await openJira()
  await search()
  await issueButton('PROJ-7').click()
  await panel().getByRole('button', { name: '연결 일감 준비…', exact: true }).click()
  const confirm = win.getByRole('alertdialog', { name: '연결 일감 준비', exact: true })
  await expect(confirm).toContainText('PROJ-7')
  // 같은 프레임에서 두 번 누르기
  await confirm.getByRole('button', { name: '일감 준비', exact: true }).evaluate((b: HTMLElement) => { b.click(); b.click() })
  await expect.poll(() => win.evaluate(async () => (await window.taskminal.issues.links()).length)).toBe(1)
  const rowsOf = win.locator('[data-testid="task-row"]')
  await expect(rowsOf).toHaveCount(3)
  const created = win.locator('[data-testid="task-row"]', { hasText: 'PROJ-7' })
  await expect(created).toHaveCount(1)
  const chip = created.getByTestId('task-issue')
  await expect(chip).toHaveText('PROJ-7 · 마감 지남')
  // 잘리지 않고 다 보인다
  expect(await chip.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  await expect(chip).toHaveClass(/overdue/)
  await win.getByRole('button', { name: '작업 보조 화면 닫기' }).click()
  await created.locator('.task-main').click()
  const head = win.locator('[data-testid="task-view"]:visible').getByTestId('jira-head')
  await expect(head).toContainText('PROJ-7')
  await expect(head.getByTestId('jira-due')).toContainText('마감 지남')
  for (const theme of ['dark', 'light']) {
    await win.evaluate((t) => { document.documentElement.dataset.theme = t }, theme)
    for (const sel of ['[data-testid="task-issue"].overdue', '[data-testid="task-view"]:not([style*="none"]) [data-testid="jira-due"].overdue']) {
      const c = await contrastOf(sel)
      expect(c, `${theme} ${sel}`).not.toBeNull()
      expect(c!.contrast, `${theme} ${sel}`).toBeGreaterThanOrEqual(4.5)
      expect(c!.size).toBeGreaterThanOrEqual(12)
    }
  }
  await win.evaluate(() => { delete document.documentElement.dataset.theme })
  await captureWindow(app, 'test-results/jira-task-head.png')
  // 재시작 뒤에도 연결 · 칩 · 머리가 남는다 (waitLoaded 는 첫 일감 화면을 기다리므로 첫 일감으로 돌려 둔다)
  await win.locator('[data-testid="task-row"]', { hasText: 'Jira 검증' }).locator('.task-main').click()
  await app.close()
  await launch({ ...envAuth, JIRA_SITE: site })
  await expect(win.locator('[data-testid="task-row"]', { hasText: 'PROJ-7' }).getByTestId('task-issue')).toContainText('마감 지남')
  await win.locator('[data-testid="task-row"]', { hasText: 'PROJ-7' }).locator('.task-main').click()
  await expect(win.locator('[data-testid="task-view"]:visible').getByTestId('jira-head')).toContainText('PROJ-7')
})

test('기존 일감에 연결 — 확인을 연 사이 대상 일감이 사라지면 막고 안내, 남은 일감에는 연결 하나', async () => {
  await launch({ ...envAuth, JIRA_SITE: site })
  await openJira()
  await search()
  await issueButton('PROJ-8').click()
  await panel().getByRole('combobox', { name: '연결할 일감', exact: true }).selectOption('other')
  await panel().getByRole('button', { name: '이 일감에 연결…', exact: true }).click()
  const confirm = win.getByRole('alertdialog', { name: '기존 일감에 연결', exact: true })
  await expect(confirm).toContainText('다른 일감')
  // 확인을 연 사이 대상 일감을 지운다(대화상자 뒤의 사이드바 단추를 DOM 으로 누른다)
  await win.evaluate(() => (document.querySelector('[aria-label="다른 일감 지우기"]') as HTMLElement).click())
  // 두 확인창이 같은 제목 id 를 써서 이름으로 못 찾는다 — 글로 찾는다
  await win.getByRole('alertdialog').filter({ hasText: '일감을 지울까요' }).evaluate((d) => (d.querySelector('button.danger') as HTMLElement).click())
  await expect(win.locator('[data-testid="task-row"]', { hasText: '다른 일감' })).toHaveCount(0)
  await confirm.getByRole('button', { name: '연결', exact: true }).click()
  await expect(panel().getByRole('alert').filter({ hasText: '연결할 일감이 사라졌어요' })).toBeVisible()
  expect(await win.evaluate(() => window.taskminal.issues.links())).toHaveLength(0)
  // main 도 지운 일감을 막는다
  expect(await win.evaluate(() => window.taskminal.jira.attach({ requestId: 'r-gone', id: '10008', taskId: 'other' }).then(() => 'ok', (e: Error) => e.message))).toContain('[issue-task-deleted]')
  // 남은 일감에 연결 — 같은 프레임 두 번도 하나
  await panel().getByRole('combobox', { name: '연결할 일감', exact: true }).selectOption('task')
  await panel().getByRole('button', { name: '이 일감에 연결…', exact: true }).click()
  await confirm.getByRole('button', { name: '연결', exact: true }).evaluate((b: HTMLElement) => { b.click(); b.click() })
  await expect.poll(() => win.evaluate(async () => (await window.taskminal.issues.links()).map((l) => `${l.taskId}:${l.issue.key}`))).toEqual(['task:PROJ-8'])
  await expect(win.locator('[data-testid="task-view"]:visible').getByTestId('jira-head')).toContainText('PROJ-8')
  await expect(panel().getByRole('region', { name: '연결한 이슈' })).toContainText('PROJ-8')
  await expect(panel().getByRole('region', { name: '연결한 이슈' }).getByRole('button', { name: '외부 이슈 닫기…' })).toHaveCount(0)
})

test('붙는 중 한도 · 응답 유실 · 늦게 온 옛 응답 — 마지막 목록과 받은 시각을 남기고 다시 시도 · 좁은 창', async () => {
  await launch({ ...envAuth, JIRA_SITE: site })
  await openJira()
  await search()
  await expect(issueButton('PROJ-7')).toBeVisible()
  // 답하지 않는 가짜 → '읽는 중' → 한도(시험 1.5초) 뒤 '응답이 없어요' · 다시 시도 · 마지막 목록 유지
  fake.mode = 'hang'
  await search()
  await expect(panel().getByTestId('jira-list-state')).toContainText('Jira 에서 읽는 중')
  await expect(panel().getByTestId('jira-list-error')).toContainText('응답이 없어요', { timeout: 10_000 })
  await expect(panel().getByTestId('jira-list-state')).toContainText(/마지막으로 받은 목록을 그대로 보여요 · .+ 받음/)
  await expect(issueButton('PROJ-7')).toBeVisible()
  // 응답 유실
  fake.mode = 'drop'
  await panel().getByRole('button', { name: '다시 시도', exact: true }).click()
  await expect(panel().getByTestId('jira-list-error')).toContainText('중간에 끊겼어요')
  // 다시 시도 성공
  fake.mode = 'ok'
  await panel().getByRole('button', { name: '다시 시도', exact: true }).click()
  await expect(panel().getByTestId('jira-list-error')).toHaveCount(0)
  // 느린 옛 JQL 뒤에 빠른 새 JQL — 늦게 온 옛 응답은 버린다
  const jql = panel().getByRole('textbox', { name: 'JQL', exact: true })
  fake.slowJql = 'project = SLOW'
  await jql.fill('project = SLOW')
  await search()
  await jql.fill('project = FAST')
  await search()
  await expect(issueButton('PROJ-8')).toBeVisible()
  await win.waitForTimeout(1200)
  await expect(issueButton('PROJ-9')).toHaveCount(0)
  await expect(issueButton('PROJ-8')).toBeVisible()
  // 좁은 창 · 확대에서도 가로로 넘치지 않는다
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]!; w.setSize(640, 520); w.webContents.setZoomFactor(2) })
  await expect.poll(() => win.evaluate(() => innerWidth)).toBe(320)
  await expect.poll(() => panel().evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  await panel().getByTestId('jira-list-state').evaluate((el) => el.scrollIntoView())
  await captureWindow(app, 'test-results/jira-narrow.png')
})
