import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { captureWindow, firstWindow, seedState, waitLoaded } from './helpers'

let userData: string
let repo: string
let app: ElectronApplication | undefined
let win: Page
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
const write = (path: string, body: string) => writeFileSync(join(repo, path), body)
const pane = () => win.locator('[data-testid="task-view"][aria-hidden="false"] [data-testid="review-pane"]')
const comments = () => pane().getByTestId('review-comment')
const file = (path: string) => pane().getByTestId('review-file').filter({ hasText: path })
const changed = (text: string) => pane().locator('.review-line.tadd').filter({ hasText: text })
const command = (name: string) => app!.evaluate(({ BrowserWindow }, cmd) => BrowserWindow.getAllWindows()[0]!.webContents.send('app:command', cmd), name)
async function addLineComment(path: string, text: string, body: string) {
  await file(path).click()
  await changed(text).getByRole('button', { name: /의견 쓰기/ }).click()
  await pane().getByRole('textbox', { name: '줄 리뷰 의견', exact: true }).fill(body)
  await pane().getByRole('button', { name: '의견 추가', exact: true }).click()
}

test.describe.configure({ timeout: 90_000 })
test.beforeEach(async () => {
  userData = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-review-comments-')))
  repo = join(userData, 'repo')
  mkdirSync(repo)
  git('init', '-q', '-b', 'feat')
  git('config', 'user.email', 'test@example.invalid')
  git('config', 'user.name', 'test')
  git('config', 'commit.gpgsign', 'false')
  write('x.txt', 'first\nsecond\nthird\nfourth\n')
  write('other.txt', 'other original\n')
  git('add', '.')
  git('commit', '-qm', 'initial')
  write('x.txt', 'first\nSECOND-A\nSECOND-B\nthird\nfourth\n')
  write('other.txt', 'OTHER-CHANGE\n')
  seedState(userData, [{ id: 'task-a', name: 'A 일감', paneId: 'pane-a', cwd: repo }, { id: 'task-b', name: 'B 일감', paneId: 'pane-b', cwd: repo }])
  app = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: userData, TASKMINAL_CLAUDE_BIN: resolve(__dirname, '../fixtures/fake-claude.mjs') } })
  win = await firstWindow(app)
  await waitLoaded(win)
  await command('review')
  await expect(pane()).toBeVisible()
})
test.afterEach(async () => {
  await app?.close()
  app = undefined
  rmSync(userData, { recursive: true, force: true })
})

test('정확한 파일과 선택한 줄 범위 의견을 한 번에 대화 초안에 넣고 자동 전송하지 않는다', async () => {
  await file('x.txt').click()
  await changed('SECOND-A').click()
  await changed('SECOND-B').click()
  await pane().getByRole('button', { name: '고른 줄에 의견 쓰기', exact: true }).click()
  await pane().getByRole('textbox', { name: '줄 리뷰 의견', exact: true }).fill('두 줄의 이름을 설명해 주세요')
  await pane().getByRole('button', { name: '의견 추가', exact: true }).click()
  await addLineComment('other.txt', 'OTHER-CHANGE', '다른 파일 의견')
  await expect(comments()).toHaveCount(2)
  await captureWindow(app!, '/tmp/taskminal-44-review.png')
  const theme = await win.evaluate(() => {
    const previous = document.documentElement.dataset.theme
    document.documentElement.dataset.theme = 'light'
    return previous
  })
  await app!.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]!
    window.setSize(1000, 900)
    window.webContents.setZoomFactor(2)
  })
  await captureWindow(app!, '/tmp/taskminal-44-review-light-200.png')
  await app!.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]!
    window.webContents.setZoomFactor(1)
    window.setSize(1280, 900)
  })
  await win.evaluate((previous) => {
    if (previous === undefined) delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = previous
  }, theme)
  await pane().getByTestId('review-comments-attach').click()
  const view = win.locator('[data-testid="task-view"][aria-hidden="false"]')
  const chat = view.getByTestId('chat-input')
  await expect(chat).toHaveValue(/리뷰 의견 2개/)
  const value = await chat.inputValue()
  expect(value).toContain('x.txt · 현재 2, 현재 3\n변경 서명:')
  expect(value).toContain('두 줄의 이름을 설명해 주세요\n```diff\n+SECOND-A\n+SECOND-B\n```')
  expect(value).toContain('other.txt · 현재 1\n변경 서명:')
  expect(value).toContain('다른 파일 의견\n```diff\n+OTHER-CHANGE\n```')
  expect(value).not.toContain('-second')
  await expect(view.getByTestId('chat-user-text')).toHaveCount(0)
})

test('패널을 닫아도 작성 중 의견 보존 · 바뀐 diff는 첨부 차단 · 명시적 재검토 · 해결 및 정확한 삭제', async () => {
  await file('x.txt').click()
  await changed('SECOND-A').getByRole('button', { name: /의견 쓰기/ }).click()
  await pane().getByRole('textbox', { name: '줄 리뷰 의견', exact: true }).fill('보존할 초안')
  await pane().focus()
  await command('close-pane')
  await expect(pane()).toHaveCount(0)
  await command('review')
  await expect(pane().getByRole('textbox', { name: '줄 리뷰 의견', exact: true })).toHaveValue('보존할 초안')
  await pane().getByRole('button', { name: '의견 추가', exact: true }).click()
  await addLineComment('other.txt', 'OTHER-CHANGE', '지울 두 번째 의견')
  // A positional deletion would accidentally remove the first comment.
  await comments().nth(1).getByRole('button', { name: 'other.txt 의견 삭제', exact: true }).click()
  await expect(comments()).toHaveCount(1)
  await expect(comments()).toContainText('보존할 초안')
  write('x.txt', 'first\nREPLACED\nSECOND-B\nthird\nfourth\n')
  await expect(comments()).toHaveAttribute('data-stale', 'true')
  await expect(pane().getByTestId('review-comments-attach')).toBeDisabled()
  await expect(comments()).toContainText('+SECOND-A')
  await file('x.txt').click()
  await changed('REPLACED').click()
  await comments().getByRole('button', { name: '현재 고른 줄로 다시 연결', exact: true }).click()
  await expect(comments()).toHaveAttribute('data-stale', 'false')
  await expect(comments()).toContainText('+REPLACED')
  await expect(pane().getByTestId('review-comments-attach')).toBeEnabled()
  await comments().getByRole('button', { name: '해결됨으로 표시', exact: true }).click()
  await expect(pane().getByTestId('review-comments-attach')).toBeDisabled()
  await comments().getByRole('button', { name: '다시 열기', exact: true }).click()
  await pane().getByTestId('review-comments-attach').click()
  await expect(win.locator('[data-testid="task-view"][aria-hidden="false"] [data-testid="chat-input"]')).toHaveValue(/보존할 초안[\s\S]*\+REPLACED/)
})

test('감시 갱신 전에 첨부해도 최신 diff 재검증이 낡은 의견 전달을 막는다', async () => {
  await addLineComment('x.txt', 'SECOND-A', '옛 줄에 대한 의견')
  // Keep the renderer's existing snapshot while changing the actual repository.
  await expect(pane().getByTestId('review-fresh')).toContainText('방금 갱신')
  const id = (await pane().getAttribute('data-pane-id'))!
  await win.evaluate((paneId) => window.taskminal.review.watch(paneId, null), id)
  write('x.txt', 'first\nDIFFERENT\nthird\nfourth\n')
  const attach = pane().getByTestId('review-comments-attach')
  await expect(attach).toBeEnabled()
  await attach.click()
  await expect(comments()).toHaveAttribute('data-stale', 'true')
  await expect(attach).toBeDisabled()
  await expect(win.locator('[data-testid="task-view"][aria-hidden="false"] [data-testid="chat-input"]')).toHaveCount(0)
})


test('같은 저장소의 두 리뷰 pane은 공유 의견을 유실 없이 갱신하고 숨긴 pane의 늦은 첨부는 취소한다', async () => {
  await addLineComment('x.txt', 'SECOND-A', 'A pane 첫 의견')
  const aId = (await pane().getAttribute('data-pane-id'))!
  await win.locator('[data-testid="task-row"][data-task-name="B 일감"]').click()
  await command('review')
  await expect(pane()).toBeVisible()
  await expect(comments()).toHaveCount(1)
  await expect(comments().first()).toContainText('A pane 첫 의견')
  await addLineComment('other.txt', 'OTHER-CHANGE', 'B pane 독립 의견')
  const bId = (await pane().getAttribute('data-pane-id'))!
  expect(bId).not.toBe(aId)
  await win.locator('[data-testid="task-row"][data-task-name="A 일감"]').click()
  await expect(comments()).toHaveCount(2)
  await expect(comments().first()).toContainText('A pane 첫 의견')
  await addLineComment('other.txt', 'OTHER-CHANGE', 'A pane 두 번째 의견')
  await win.locator('[data-testid="task-row"][data-task-name="B 일감"]').click()
  await expect(comments()).toHaveCount(3)
  await expect(comments().nth(1)).toContainText('B pane 독립 의견')
  await win.locator('[data-testid="task-row"][data-task-name="A 일감"]').click()
  await expect(comments()).toHaveCount(3)
  await expect(pane().getByTestId('review-fresh')).toContainText('방금 갱신')
  // Hold the real latest-diff reply after attachment starts, then change tabs.
  await app!.evaluate(({ ipcMain }) => {
    const ipc = ipcMain as unknown as {
      _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>>
      commentRelease?: () => void
      commentStarted?: boolean
    }
    const original = ipc._invokeHandlers.get('review:load')!
    if (!original) throw new Error('review:load handler missing')
    const gate = new Promise<void>((resolve) => { ipc.commentRelease = resolve })
    ipcMain.removeHandler('review:load')
    ipcMain.handle('review:load', async (...args) => {
      ipc.commentStarted = true
      await gate
      return original(...args)
    })
  })
  await pane().getByTestId('review-comments-attach').click()
  await expect.poll(() => app!.evaluate(({ ipcMain }) => (ipcMain as unknown as { commentStarted?: boolean }).commentStarted)).toBe(true)
  await command('new-tab')
  await expect(pane()).toBeHidden()
  const selectedTab = await win.getByRole('tab', { selected: true }).locator('xpath=..').getAttribute('data-tab-id')
  await app!.evaluate(({ ipcMain }) => (ipcMain as unknown as { commentRelease(): void }).commentRelease())
  const hiddenA = win.locator(`[data-testid="review-pane"][data-pane-id="${aId}"]`)
  await expect(hiddenA.getByTestId('review-comments-attach')).toHaveText('리뷰 의견을 대화에 넣기')
  await expect(win.getByRole('tab', { selected: true }).locator('xpath=..')).toHaveAttribute('data-tab-id', selectedTab!)
  await expect(win.getByTestId('chat-input')).toHaveCount(0)
  await command('review')
  await expect(comments()).toHaveCount(3)
  await expect(comments().first()).toContainText('A pane 첫 의견')
})
