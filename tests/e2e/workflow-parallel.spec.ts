import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { captureWindow, firstWindow, seedState, waitLoaded } from './helpers'
import type { Workflow } from '../../src/shared/workflows'

let data: string, repo: string, app: ElectronApplication, win: Page
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const view = () => win.evaluate(() => window.taskminal.workflows.view())
const panel = () => win.getByRole('region', { name: '작업 흐름', exact: true })
const workflow: Workflow = {
  id: 'parallel', name: '병렬 후 종합', maxParallel: 2, isolate: true,
  steps: [
    { id: 'alpha', name: '알파', agent: 'claude', prompt: 'perm alpha', after: [] },
    { id: 'beta', name: '베타', agent: 'claude', prompt: 'perm beta', after: [] },
    { id: 'collect', name: '종합', agent: 'claude', prompt: 'collect outcomes', after: ['alpha', 'beta'] },
  ],
}
async function allow(paneId: string) {
  await expect.poll(() => win.evaluate(async (id) => (await window.taskminal.chat.history(id)).events.some((event) => event.t === 'permission'), paneId)).toBe(true)
  await win.evaluate(async (id) => {
    const event = (await window.taskminal.chat.history(id)).events.find((item) => item.t === 'permission')
    if (event?.t !== 'permission') throw new Error('permission missing')
    window.taskminal.chat.answer(id, event.id, { how: 'allow' })
  }, paneId)
}
test.describe.configure({ timeout: 90_000 })
test.beforeEach(async () => {
  data = realpathSync(mkdtempSync(join(tmpdir(), 'tm-workflow-parallel-')))
  repo = join(data, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'source')
  git(repo, 'config', 'user.name', 'test')
  git(repo, 'config', 'user.email', 'test@example.invalid')
  git(repo, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(repo, 'tracked.txt'), 'source content\n')
  git(repo, 'add', 'tracked.txt')
  git(repo, 'commit', '-qm', 'initial')
  seedState(data, [{ id: 'task', name: '병렬 검증', paneId: 'shell', cwd: repo }])
  app = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: data, FAKE_CLAUDE_MATCH_FIRST_LINE: '1', TASKMINAL_CLAUDE_BIN: resolve('tests/fixtures/fake-claude.mjs'), FAKE_CLAUDE_LOG: join(data, 'claude.log') } })
  win = await firstWindow(app)
  await waitLoaded(win)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('app:command', 'workflows'))
})
test.afterEach(async () => {
  await app?.close()
  rmSync(data, { recursive: true, force: true, maxRetries: 5 })
})
test('순차 기본값과 병렬 worktree 선택을 저장·재편집해도 보존한다', async () => {
  await panel().getByRole('button', { name: '새로 만들기', exact: true }).click()
  const limit = panel().getByRole('combobox', { name: '동시 실행 한도', exact: true })
  const isolate = panel().getByRole('checkbox', { name: '단계마다 별도 worktree', exact: true })
  await expect(limit).toHaveValue('1')
  await expect(isolate).not.toBeChecked()
  await limit.selectOption('2')
  await expect(isolate).toBeChecked()
  await expect(isolate).toBeDisabled()
  await expect(panel()).toContainText('변경을 자동으로 합치지 않습니다')
  await panel().getByRole('textbox', { name: '흐름 이름', exact: true }).fill('병렬 설정')
  await panel().getByRole('textbox', { name: '단계 이름', exact: true }).fill('독립 작업')
  await panel().getByRole('textbox', { name: '보낼 지시', exact: true }).fill('check')
  await panel().getByRole('button', { name: '저장', exact: true }).click()
  await expect.poll(async () => (await view()).templates[0]?.maxParallel).toBe(2)
  expect((await view()).templates[0]?.isolate).toBe(true)
  await panel().getByRole('button', { name: '편집', exact: true }).click()
  await expect(limit).toHaveValue('2')
  await expect(isolate).toBeChecked()
  await limit.selectOption('1')
  await expect(isolate).toBeEnabled()
  await isolate.uncheck()
  await panel().getByRole('button', { name: '저장', exact: true }).click()
  await expect.poll(async () => (await view()).templates[0]?.maxParallel).toBe(1)
  expect((await view()).templates[0]?.isolate).toBe(false)
  await panel().getByRole('button', { name: '편집', exact: true }).click()
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]!
    window.setSize(640, 520)
    window.webContents.setZoomFactor(2)
  })
  await win.evaluate(() => { document.documentElement.dataset.theme = 'light' })
  await expect.poll(() => win.evaluate(() => innerWidth)).toBe(320)
  await expect.poll(() => panel().evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  await limit.scrollIntoViewIfNeeded()
  await captureWindow(app, '/tmp/taskminal-45-workflow-small.png')
})
test('두 독립 단계는 실제 별도 Git 경로에서 동시에 기다리고 두 완료 후 종합 단계를 시작한다', async () => {
  await win.evaluate(async (value) => { await window.taskminal.workflows.save(value) }, workflow)
  await expect(panel().getByRole('combobox', { name: '저장된 작업 흐름', exact: true }).getByRole('option', { name: workflow.name })).toHaveCount(1)
  await panel().getByRole('combobox', { name: '저장된 작업 흐름', exact: true }).selectOption(workflow.id)
  await panel().getByRole('button', { name: '저장된 흐름 실행', exact: true }).click()
  await expect.poll(async () => (await view()).runs[0]?.steps.map((step) => step.status)).toEqual(['waiting', 'waiting', 'pending'])
  const running = (await view()).runs[0]!
  const first = running.steps[0]!, second = running.steps[1]!
  const saved = JSON.parse(readFileSync(join(data, 'state.json'), 'utf8'))
  const task = saved.tasks.find((item: { id: string }) => item.id === 'task')
  expect(task.cwd).toBe(repo)
  for (const step of [first, second]) expect(task.panes[step.paneId].cwd).toBe(step.cwd)
  expect(first.cwd).toBeTruthy()
  expect(second.cwd).toBeTruthy()
  expect(first.cwd).not.toBe(second.cwd)
  expect(first.cwd).not.toBe(repo)
  expect(second.cwd).not.toBe(repo)
  for (const step of [first, second]) {
    expect(realpathSync(git(step.cwd!, 'rev-parse', '--show-toplevel'))).toBe(realpathSync(step.cwd!))
    expect(git(step.cwd!, 'branch', '--show-current')).toBe(step.branch)
    expect(readFileSync(join(step.cwd!, 'tracked.txt'), 'utf8')).toBe('source content\n')
  }
  await expect(panel().getByTestId('workflow-running-count')).toContainText('실행 중 2개')
  await captureWindow(app, '/tmp/taskminal-45-workflow-wide.png')
  await expect(panel().getByTestId('workflow-step-cwd').filter({ hasText: first.cwd! })).toHaveCount(1)
  await expect(panel().getByTestId('workflow-step-branch').filter({ hasText: second.branch! })).toHaveCount(1)
  expect(existsSync(join(data, 'claude.log'))).toBe(true)
  const log = () => readFileSync(join(data, 'claude.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  expect(log().filter((line) => line.argv).map((line) => line.cwd).sort()).toEqual([first.cwd, second.cwd].sort())
  await allow(first.paneId)
  await expect.poll(async () => (await view()).runs[0]?.steps[0]?.status).toBe('done')
  expect((await view()).runs[0]!.steps.map((step) => step.status)).toEqual(['done', 'waiting', 'pending'])
  expect(log().filter((line) => line.argv)).toHaveLength(2)
  await allow(second.paneId)
  await expect.poll(async () => (await view()).runs[0]?.status).toBe('done')
  const completed = (await view()).runs[0]!
  expect(completed.steps.map((step) => step.status)).toEqual(['done', 'done', 'done'])
  expect(new Set(completed.steps.map((step) => step.cwd)).size).toBe(3)
  const prompts = log().flatMap((line) => line.stdin?.type === 'user' ? [line.stdin.message.content.map((item: { text?: string }) => item.text ?? '').join('')] : [])
  const collected = prompts.find((prompt: string) => prompt.startsWith('collect outcomes'))
  expect(collected).toContain(first.cwd)
  expect(collected).toContain(second.cwd)
  expect(collected).toContain('허락 받음')
  expect(git(repo, 'branch', '--show-current')).toBe('source')
  expect(git(repo, 'status', '--porcelain')).toBe('')
})
