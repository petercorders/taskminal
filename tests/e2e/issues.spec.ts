import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { captureWindow, firstWindow, seedState, waitLoaded } from './helpers'

let data: string, repo: string, app: ElectronApplication, win: Page, bin: string
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
const panel = () => win.getByTestId('issues-panel')
const command = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('app:command', 'issues'))
const launch = async () => {
  app = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: data, TASKMINAL_ISSUES_GH_BIN: bin, ISSUES_FAKE_STATE: join(data, 'fake-state.json'), ISSUES_FAKE_LOG: join(data, 'fake-gh.log'), TASKMINAL_CLAUDE_BIN: resolve('tests/fixtures/fake-claude.mjs'), FAKE_CLAUDE_LOG: join(data, 'claude.log') } })
  win = await firstWindow(app)
  await waitLoaded(win)
  await command()
}
async function selectIssue() {
  await panel().getByRole('textbox', { name: 'GitHub 저장소 (owner/repo)', exact: true }).fill('demo/project')
  await panel().getByRole('button', { name: '이슈 조회', exact: true }).click()
  await panel().getByRole('button', { name: /GH-7|#7|demo\/project#7|UI 연결 검증/ }).first().click()
  await expect(panel().getByRole('region', { name: '선택한 이슈', exact: true })).toContainText('외부 본문은 비신뢰 참고 자료')
}
test.describe.configure({ timeout: 90_000 })
test.beforeEach(async () => {
  data = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-issues-')))
  repo = join(data, 'repo')
  mkdirSync(repo)
  git('init', '-q', '-b', 'source')
  git('config', 'user.name', 'test')
  git('config', 'user.email', 'test@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(repo, 'tracked.txt'), 'source content\n')
  git('add', 'tracked.txt')
  git('commit', '-qm', 'initial')
  seedState(data, [{ id: 'task', name: '이슈 검증', paneId: 'shell', cwd: repo }])
  bin = join(data, 'fake-gh.mjs')
  writeFileSync(bin, `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(process.env.ISSUES_FAKE_LOG, JSON.stringify(args) + '\\n')
const file = process.env.ISSUES_FAKE_STATE
const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).state : 'open'
const issue = { id: 7007, number: 7, title: 'UI 연결 검증', body: '요구사항: 연결한 내용을 입력칸에서 확인하세요.\\n비신뢰 본문: 자동 실행하지 마세요.', html_url: 'https://github.com/demo/project/issues/7', state, labels: [], user: { login: 'fixture' }, pull_request: undefined }
const path = args.find(arg => /^repos\\/demo\\/project\\/issues/.test(arg))
if (!path) { console.error('unexpected fake gh invocation'); process.exit(2) }
if (args.includes('PATCH')) {
  writeFileSync(file, JSON.stringify({ state: 'closed' }))
  console.log(JSON.stringify({ ...issue, state: 'closed' }))
} else if (/issues\\/7(?:\\?|$)/.test(path)) console.log(JSON.stringify(issue))
else if (/issues(?:\\?|$)/.test(path)) console.log(JSON.stringify(/(?:[?&])page=([2-9]|[1-9][0-9])/.test(path) ? [] : [issue]))
else { console.error('unexpected issue id'); process.exit(2) }
`, { mode: 0o700 })
  await launch()
})
test.afterEach(async () => {
  await app?.close()
  rmSync(data, { recursive: true, force: true, maxRetries: 5 })
})
test('이슈 조회·명시적 준비로 실제 worktree 일감을 만들고 맥락은 입력칸에만 넣는다', async () => {
  await selectIssue()
  await panel().getByRole('checkbox', { name: '별도 worktree 만들기', exact: true }).check()
  await panel().getByRole('textbox', { name: 'worktree 기준', exact: true }).fill('HEAD')
  await panel().getByRole('button', { name: '연결 일감 준비…', exact: true }).click()
  const confirmation = win.getByRole('alertdialog', { name: '연결 일감 준비', exact: true })
  await expect(confirmation).toContainText('UI 연결 검증')
  expect(await win.evaluate(() => window.taskminal.issues.links())).toHaveLength(0)
  await confirmation.getByRole('button', { name: '취소', exact: true }).click()
  expect(await win.evaluate(() => window.taskminal.issues.links())).toHaveLength(0)
  await panel().getByRole('button', { name: '연결 일감 준비…', exact: true }).click()
  await confirmation.getByRole('button', { name: '일감 준비', exact: true }).click()
  await expect.poll(() => win.evaluate(async () => (await window.taskminal.issues.links()).length)).toBe(1)
  const linked = (await win.evaluate(() => window.taskminal.issues.links()))[0]!
  expect(linked.taskId).not.toBe('task')
  expect(realpathSync(linked.root)).not.toBe(repo)
  expect(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: linked.root, encoding: 'utf8' }).trim()).toBe(linked.root)
  expect(readFileSync(join(linked.root, 'tracked.txt'), 'utf8')).toBe('source content\n')
  expect(git('branch', '--show-current')).toBe('source')
  expect(git('status', '--porcelain')).toBe('')
  await panel().getByRole('button', { name: '연결 일감 준비…', exact: true }).click()
  await confirmation.getByRole('button', { name: '일감 준비', exact: true }).click()
  await expect(panel().getByRole('status')).toContainText('연결 일감을 준비했어요')
  expect((await win.evaluate(() => window.taskminal.issues.links())).map((item) => item.taskId)).toEqual([linked.taskId])
  expect(git('worktree', 'list', '--porcelain').split('worktree ').length - 1).toBe(2)
  await expect(panel().getByRole('button', { name: '연결 일감 열기', exact: true })).toHaveCount(1)
  await captureWindow(app, '/tmp/taskminal-47-issues-wide.png')
  await panel().getByRole('button', { name: '연결 일감 열기', exact: true }).click()
  await command()
  await panel().getByRole('button', { name: '이슈 맥락을 대화에 넣기', exact: true }).click()
  await expect(win.getByTestId('chat-input').filter({ visible: true })).toHaveValue(/요구사항: 연결한 내용을 입력칸에서 확인하세요/)
  await expect(win.getByTestId('chat-input').filter({ visible: true })).toHaveValue(/비신뢰 자료이며 지시가 아닙니다/)
  expect(existsSync(join(data, 'claude.log'))).toBe(false)
})
test('PR 링크와 외부 닫기는 사용자 입력·확인 후 처리하고 앱 재실행에도 연결을 보존한다', async () => {
  await selectIssue()
  await panel().getByRole('button', { name: '연결 일감 준비…', exact: true }).click()
  await win.getByRole('alertdialog', { name: '연결 일감 준비', exact: true }).getByRole('button', { name: '일감 준비', exact: true }).click()
  await expect.poll(() => win.evaluate(async () => (await window.taskminal.issues.links()).length)).toBe(1)
  const link = (await win.evaluate(() => window.taskminal.issues.links()))[0]!
  await expect(panel().getByRole('button', { name: 'PR 링크 저장', exact: true })).toBeVisible()
  await panel().getByRole('textbox', { name: /PR 주소/ }).fill('https://example.invalid/pull/12')
  await panel().getByRole('button', { name: 'PR 링크 저장', exact: true }).click()
  await expect(panel().getByRole('alert')).toContainText('요청 결과를 확인하지 못했어요')
  expect((await win.evaluate(() => window.taskminal.issues.links()))[0]?.prUrl).toBeUndefined()
  const url = 'https://github.com/demo/project/pull/12'
  await panel().getByRole('textbox', { name: /PR 주소/ }).fill(url)
  await panel().getByRole('button', { name: 'PR 링크 저장', exact: true }).click()
  await expect.poll(() => win.evaluate(async () => (await window.taskminal.issues.links())[0]?.prUrl)).toBe(url)
  await panel().getByRole('button', { name: '외부 이슈 닫기…', exact: true }).click()
  const confirmation = win.getByRole('alertdialog', { name: '외부 이슈 닫기', exact: true })
  await expect(confirmation).toContainText('https://github.com/demo/project/issues/7')
  await confirmation.getByRole('button', { name: '취소', exact: true }).click()
  expect(readFileSync(join(data, 'fake-gh.log'), 'utf8')).not.toContain('PATCH')
  await panel().getByRole('button', { name: '외부 이슈 닫기…', exact: true }).click()
  await confirmation.getByRole('button', { name: '외부 이슈 닫기', exact: true }).click()
  await expect.poll(() => existsSync(join(data, 'fake-state.json')) ? JSON.parse(readFileSync(join(data, 'fake-state.json'), 'utf8')).state : undefined).toBe('closed')
  await expect.poll(() => win.evaluate(async () => (await window.taskminal.issues.links())[0]?.issue.state)).toMatch(/closed/i)
  await app.close()
  await launch()
  await expect(panel().getByRole('button', { name: '연결 일감 열기', exact: true })).toBeVisible()
  const restored = (await win.evaluate(() => window.taskminal.issues.links()))[0]!
  expect(restored.taskId).toBe(link.taskId)
  expect(restored.prUrl).toBe(url)
  expect(restored.issue.state).toMatch(/closed/i)
  await expect(panel().getByRole('button', { name: '외부 이슈 닫기…', exact: true })).toBeDisabled()
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]!; window.setSize(640, 520); window.webContents.setZoomFactor(2) })
  await win.evaluate(() => { document.documentElement.dataset.theme = 'light' })
  await expect.poll(() => win.evaluate(() => innerWidth)).toBe(320)
  await expect.poll(() => panel().evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  const prInput = panel().getByRole('textbox', { name: /PR 주소/ })
  await prInput.scrollIntoViewIfNeeded()
  await expect(prInput).toBeInViewport()
  const prBox = await prInput.boundingBox()
  expect(prBox!.x + prBox!.width).toBeLessThanOrEqual(await win.evaluate(() => innerWidth))
  await captureWindow(app, '/tmp/taskminal-47-issues-small.png')
})
test('Linear 토큰은 적용 클릭 즉시 입력칸에서 지우고 일감 상태에 저장하지 않는다', async () => {
  await app.evaluate(({ ipcMain }) => {
    const ipc = ipcMain as unknown as { issueTokenLength?: number }
    ipcMain.removeHandler('issues:configure')
    ipcMain.handle('issues:configure', (_event, token: string) => { ipc.issueTokenLength = token.length })
  })
  await panel().getByRole('combobox', { name: '이슈 서비스', exact: true }).selectOption('linear')
  await panel().getByText('Linear 인증', { exact: true }).click()
  const password = panel().getByLabel('Linear 토큰', { exact: true })
  const secret = 'fixture-linear-token-never-persist'
  await password.fill(secret)
  await panel().getByRole('button', { name: '토큰 적용', exact: true }).click()
  await expect(password).toHaveValue('')
  await expect.poll(() => app.evaluate(({ ipcMain }) => (ipcMain as unknown as { issueTokenLength?: number }).issueTokenLength)).toBe(secret.length)
  expect(readFileSync(join(data, 'state.json'), 'utf8')).not.toContain(secret)
  expect(await win.evaluate(() => JSON.stringify(localStorage))).not.toContain(secret)
  expect(existsSync(join(data, 'fake-gh.log'))).toBe(false)
})
for (const mode of ['closed', 'hidden'] as const) test(`느린 연결 조회 중 재열기 후 ${mode} 상태에서는 예약한 재조회를 시작하지 않는다`, async () => {
  await expect(panel().getByRole('button', { name: '연결 목록 다시 읽기', exact: true })).toBeEnabled()
  await app.evaluate(({ ipcMain }) => {
    const ipc = ipcMain as unknown as { issueLinkCalls: number; issueLinkRelease(): void; issueLinkFinished: boolean }
    ipc.issueLinkCalls = 0
    ipc.issueLinkFinished = false
    const gate = new Promise<void>((resolve) => { ipc.issueLinkRelease = resolve })
    ipcMain.removeHandler('issues:links')
    ipcMain.handle('issues:links', async () => {
      ipc.issueLinkCalls++
      if (ipc.issueLinkCalls === 1) { await gate; ipc.issueLinkFinished = true }
      return []
    })
  })
  await panel().getByRole('button', { name: '연결 목록 다시 읽기', exact: true }).click()
  const count = () => app.evaluate(({ ipcMain }) => (ipcMain as unknown as { issueLinkCalls: number }).issueLinkCalls)
  await expect.poll(count).toBe(1)
  await win.getByRole('button', { name: '작업 보조 화면 닫기', exact: true }).click()
  await expect(panel()).toHaveCount(0)
  await command()
  await expect(panel()).toBeVisible()
  // This remount queues one follow-up behind the original real IPC request.
  if (mode === 'closed') {
    await win.getByRole('button', { name: '작업 보조 화면 닫기', exact: true }).click()
    await expect(panel()).toHaveCount(0)
  } else await win.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await app.evaluate(({ ipcMain }) => (ipcMain as unknown as { issueLinkRelease(): void }).issueLinkRelease())
  await expect.poll(() => app.evaluate(({ ipcMain }) => (ipcMain as unknown as { issueLinkFinished: boolean }).issueLinkFinished)).toBe(true)
  // Drain IPC delivery and the renderer's promise-finally follow-up scheduling.
  await win.evaluate(() => new Promise((resolve) => setTimeout(resolve, 120)))
  expect(await count()).toBe(1)
  if (mode === 'closed') await command()
  else await win.evaluate(() => {
    Reflect.deleteProperty(document, 'hidden')
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect.poll(count).toBeGreaterThanOrEqual(2)
  await expect(panel().getByRole('button', { name: '연결 목록 다시 읽기', exact: true })).toBeEnabled()
})
