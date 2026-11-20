import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstWindow, seedState, waitLoaded } from './helpers'

// 64: Jira 쓰기(상태 바꾸기 · 댓글) — 가짜 Jira(이 파일 안의 loopback http)만 부른다. 실제 Jira 는 건드리지 않는다.
// 가짜는 이슈 하나(PROJ-7)의 상태 · 댓글을 메모리에 들고, 쓰기 응답을 끊는(소켓 destroy) 모드로 '됐는지 모름' 을 만든다.
const GOOD = 'ATATT3xGood0' + 'G'.repeat(50)
const basic = (token: string) => 'Basic ' + Buffer.from(`me@example.com:${token}`).toString('base64')
const ME = 'acc-me'
type StatusId = '1' | '3' | '5'
const STATUS: Record<StatusId, { id: StatusId; name: string; statusCategory: { key: string } }> = {
  '1': { id: '1', name: '할 일', statusCategory: { key: 'new' } },
  '3': { id: '3', name: '진행 중', statusCategory: { key: 'indeterminate' } },
  '5': { id: '5', name: '검토', statusCategory: { key: 'indeterminate' } },
}
const TRANSITIONS = [
  { id: '21', name: '진행 시작', to: STATUS['3'] },
  { id: '31', name: '검토', to: STATUS['5'] },
]
/** drop: 쓰기 응답을 끊는다 — apply 면 가짜 Jira 에는 반영하고 끊는다(실제로는 됐는데 답을 못 받음), skip 이면 반영도 안 한다 */
const fake = {
  status: '1' as StatusId,
  comments: [] as Array<{ id: string; author: { accountId: string }; created: string; body: unknown }>,
  drop: { transition: 'no' as 'no' | 'apply' | 'skip', comment: 'no' as 'no' | 'apply' | 'skip' },
  requests: [] as Array<{ method: string; path: string; body: string }>,
}
const issueRow = () => ({
  id: '10007',
  key: 'PROJ-7',
  fields: { summary: '쓰기 시험 이슈', status: STATUS[fake.status], project: { key: 'PROJ', name: '가짜 프로젝트' }, issuetype: { name: 'Task' }, updated: '2026-11-15T10:00:00.000+0900' },
})
let server: Server, site: string
let data: string, app: ElectronApplication | undefined, win: Page

test.beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const path = req.url ?? ''
      fake.requests.push({ method: req.method ?? '', path, body })
      const send = (status: number, value?: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(value === undefined ? undefined : JSON.stringify(value))
      }
      if (req.headers.authorization !== basic(GOOD)) return send(401, { errorMessages: ['가짜 401'] })
      if (path === '/rest/api/3/myself') return send(200, { displayName: '가짜 사용자', accountId: ME })
      if (path === '/rest/api/3/search/jql') return send(200, { issues: [issueRow()] })
      if (path.startsWith('/rest/api/3/issue/10007?')) return send(200, issueRow())
      if (path === '/rest/api/3/issue/PROJ-7/transitions') {
        if (req.method === 'GET') return send(200, { transitions: TRANSITIONS.filter((t) => t.to.id !== fake.status) })
        const id = (JSON.parse(body) as { transition?: { id?: string } }).transition?.id
        const t = TRANSITIONS.find((x) => x.id === id)
        if (!t) return send(400, { errorMessages: ['없는 전환'] })
        if (fake.drop.transition !== 'no') {
          if (fake.drop.transition === 'apply') fake.status = t.to.id
          return void req.socket.destroy()
        }
        fake.status = t.to.id
        return send(204)
      }
      if (path.startsWith('/rest/api/3/issue/PROJ-7/comment')) {
        if (req.method === 'GET') return send(200, { comments: [...fake.comments].reverse() })
        const comment = { id: String(100 + fake.comments.length), author: { accountId: ME }, created: new Date().toISOString(), body: (JSON.parse(body) as { body: unknown }).body }
        if (fake.drop.comment !== 'no') {
          if (fake.drop.comment === 'apply') fake.comments.push(comment)
          return void req.socket.destroy()
        }
        fake.comments.push(comment)
        return send(201, { id: comment.id })
      }
      if (path.startsWith('/rest/api/3/issue/PROJ-7?')) return send(200, { id: '10007', key: 'PROJ-7', fields: { status: STATUS[fake.status] } })
      send(404, {})
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
test.afterAll(async () => {
  server.closeAllConnections()
  await new Promise((done) => server.close(done))
})

test.describe.configure({ timeout: 90_000 })
test.beforeEach(async () => {
  data = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-jira-write-')))
  mkdirSync(join(data, 'work'))
  seedState(data, [
    { id: 'task', name: 'Jira 쓰기', paneId: 'shell', cwd: join(data, 'work') },
    { id: 'other', name: '다른 일감', paneId: 'shell2', cwd: join(data, 'work') },
  ])
  fake.status = '1'
  fake.comments.length = 0
  fake.drop = { transition: 'no', comment: 'no' }
  fake.requests.length = 0
  app = await electron.launch({
    args: ['.'],
    env: { ...process.env, TASKMINAL_USER_DATA: data, TASKMINAL_JIRA_NO_SAFE_STORAGE: '1', TASKMINAL_JIRA_TIMEOUT_MS: '3000', JIRA_SITE: site, JIRA_EMAIL: 'me@example.com', JIRA_API_TOKEN: GOOD },
  })
  win = await firstWindow(app)
  await waitLoaded(win)
  await linkIssue()
})
test.afterEach(async () => {
  await app?.close()
  app = undefined
  rmSync(data, { recursive: true, force: true, maxRetries: 5 })
})

const panel = () => win.getByTestId('issues-panel')
const head = () => win.locator('[data-testid="task-view"]:visible').getByTestId('jira-head')
const stateText = () => head().locator('.jira-state')
const result = () => head().getByTestId('jira-result')
const changeButton = () => head().getByRole('button', { name: /상태 바꾸기 ▾|읽는 중…/ })
const commentButton = () => head().getByRole('button', { name: '댓글', exact: true })
const posts = (suffix: string) => fake.requests.filter((r) => r.method === 'POST' && r.path === `/rest/api/3/issue/PROJ-7/${suffix}`)

/** 이슈 패널에서 PROJ-7 을 첫 일감에 연결한다(jira.spec 과 같은 길) */
async function linkIssue() {
  await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('app:command', 'issues'))
  await panel().getByRole('combobox', { name: '이슈 서비스', exact: true }).selectOption('jira')
  await panel().getByRole('button', { name: '이슈 조회', exact: true }).click()
  await panel().getByRole('button', { name: /^PROJ-7 · / }).click()
  await panel().getByRole('combobox', { name: '연결할 일감', exact: true }).selectOption('task')
  await panel().getByRole('button', { name: '이 일감에 연결…', exact: true }).click()
  await win.getByRole('alertdialog', { name: '기존 일감에 연결', exact: true }).getByRole('button', { name: '연결', exact: true }).click()
  await expect(head()).toContainText('PROJ-7')
  await expect(stateText()).toHaveText('할 일')
  await expect(changeButton()).toBeEnabled()
}
async function pickTransition(label: string) {
  await changeButton().click()
  const menu = win.getByTestId('jira-transitions')
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitem', { name: label }).click()
}
const confirmDialog = () => win.getByRole('alertdialog').filter({ has: win.locator('h1', { hasText: /^Jira / }) })

test('상태 바꾸기 → 확인 → 바꿨어요 · 일감 머리의 상태 줄이 새 상태로', async () => {
  await pickTransition('진행 시작 → 진행 중')
  const dialog = confirmDialog()
  await expect(dialog.locator('h1')).toHaveText('Jira 상태 바꾸기')
  await expect(dialog.locator('.dialog-message')).toHaveText('PROJ-7\n할 일 → 진행 중')
  expect(posts('transitions')).toHaveLength(0) // 확인 전에는 보내지 않는다
  await win.screenshot({ path: 'test-results/jira-write-confirm.png' })
  await dialog.getByRole('button', { name: '상태 바꾸기', exact: true }).click()
  await expect(result()).toHaveText('바꿨어요')
  await expect(stateText()).toHaveText('진행 중')
  expect(posts('transitions').map((r) => JSON.parse(r.body))).toEqual([{ transition: { id: '21' } }])
  await win.screenshot({ path: 'test-results/jira-write-done.png' })
})

test('댓글 남기기 → 확인 → 남겼어요 · 가짜 Jira 에 ADF 본문 하나 · 입력 칸 닫힘', async () => {
  await commentButton().click()
  const box = head().locator('..').getByTestId('jira-compose')
  await box.getByRole('textbox', { name: 'PROJ-7 에 남길 댓글' }).fill('첫 줄\n둘째 줄')
  await box.getByRole('button', { name: '댓글 남기기…' }).click()
  const dialog = confirmDialog()
  await expect(dialog.locator('.dialog-message')).toHaveText('PROJ-7\n첫 줄\n둘째 줄')
  await dialog.getByRole('button', { name: '댓글 남기기', exact: true }).click()
  await expect(result()).toHaveText('댓글을 남겼어요')
  await expect(win.getByTestId('jira-compose')).toHaveCount(0)
  expect(posts('comment')).toHaveLength(1)
  expect(JSON.stringify(fake.comments[0]!.body)).toContain('첫 줄')
  expect(JSON.stringify(fake.comments[0]!.body)).toContain('둘째 줄')
})

test('전환 응답이 끊김 → 됐는지 모름(상태 줄 그대로 · 새 쓰기 막힘) → 다시 확인은 가짜 Jira 의 실제 상태로 정한다(다시 보내지 않음)', async () => {
  fake.drop.transition = 'apply' // 가짜 Jira 에는 반영됐지만 답은 끊긴다
  await pickTransition('진행 시작 → 진행 중')
  await confirmDialog().getByRole('button', { name: '상태 바꾸기', exact: true }).click()
  await expect(result()).toContainText('됐는지 모름')
  await expect(result()).toHaveAttribute('role', 'alert')
  expect(fake.status).toBe('3')
  // 미리 바꾸지 않는다 — 됐는지 모르므로 상태 줄은 그대로
  await expect(stateText()).toHaveText('할 일')
  // 같은 이슈의 새 쓰기를 막는다
  await expect(changeButton()).toBeDisabled()
  await expect(commentButton()).toBeDisabled()
  await expect(head().getByRole('button', { name: '결과 지우기' })).toBeVisible()
  await win.screenshot({ path: 'test-results/jira-write-unknown.png' })

  fake.drop.transition = 'no'
  await head().getByRole('button', { name: '다시 확인' }).click()
  await expect(result()).toHaveText('바꿨어요')
  await expect(stateText()).toHaveText('진행 중')
  expect(posts('transitions')).toHaveLength(1) // 이미 된 것을 확인했으므로 다시 보내지 않았다
  await expect(changeButton()).toBeEnabled()
})

test('댓글 응답이 끊기고 실제로도 안 남음 → 다시 확인이 한 번 더 보내 남긴다 · 다음 끊김은 결과 지우기로 넘기면 새 쓰기가 풀린다', async () => {
  fake.drop.comment = 'skip'
  await commentButton().click()
  const text = () => win.getByRole('textbox', { name: 'PROJ-7 에 남길 댓글' })
  await text().fill('다시 확인 시험')
  await win.getByRole('button', { name: '댓글 남기기…' }).click()
  await confirmDialog().getByRole('button', { name: '댓글 남기기', exact: true }).click()
  await expect(result()).toContainText('됐는지 모름')
  expect(fake.comments).toHaveLength(0)
  await expect(text()).toHaveValue('다시 확인 시험') // 입력 중인 글은 성공할 때까지 남는다
  await expect(commentButton()).toBeDisabled()

  fake.drop.comment = 'no'
  await head().getByRole('button', { name: '다시 확인' }).click()
  await expect(result()).toHaveText('댓글을 남겼어요')
  expect(fake.comments).toHaveLength(1)
  expect(posts('comment')).toHaveLength(2) // 안 남은 것을 확인한 뒤에만 한 번 더

  // 다음 쓰기가 다시 끊김 → '결과 지우기' 로 넘기면 결과 줄이 사라지고 단추가 풀린다
  fake.drop.comment = 'skip'
  await commentButton().click()
  await text().fill('넘길 댓글')
  await win.getByRole('button', { name: '댓글 남기기…' }).click()
  await confirmDialog().getByRole('button', { name: '댓글 남기기', exact: true }).click()
  await expect(result()).toContainText('됐는지 모름')
  await expect(changeButton()).toBeDisabled()
  await head().getByRole('button', { name: '결과 지우기' }).click()
  await expect(result()).toHaveCount(0)
  await expect(changeButton()).toBeEnabled()
  await expect(commentButton()).toBeEnabled()
})

test('확인 창의 배경이 사이드바까지 덮는다 — 사이드바 위 점은 배경이고, 눌러도 다른 일감으로 가지 않고 창만 닫힌다', async () => {
  await pickTransition('진행 시작 → 진행 중')
  await expect(confirmDialog()).toBeVisible()
  const other = win.locator('[data-testid="task-row"][data-task-name="다른 일감"]')
  const box = (await other.boundingBox())!
  const hit = await win.evaluate(
    ({ x, y }) => {
      const el = globalThis.document.elementFromPoint(x, y)
      return { backdrop: !!el?.closest('.jira-confirm .dialog-backdrop'), sidebar: !!el?.closest('[data-testid="sidebar"]') }
    },
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  )
  expect(hit).toEqual({ backdrop: true, sidebar: false })
  await win.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await expect(confirmDialog()).toHaveCount(0)
  await expect(win.locator('[data-testid="task-view"]:visible')).toHaveAttribute('data-task-name', 'Jira 쓰기')
  expect(posts('transitions')).toHaveLength(0)
})
