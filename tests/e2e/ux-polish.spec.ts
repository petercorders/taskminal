import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { firstWindow, seedState, waitLoaded } from './helpers'

// 27단계 UX 다듬기 — 감사에서 나온 것마다 하나씩
const FAKE_CLAUDE = resolve(__dirname, '../fixtures/fake-claude.mjs')
let userData: string
let app: ElectronApplication | undefined
let win: Page

const view = () => win.locator('[data-testid="task-view"][aria-hidden="false"]')

async function launch(chatTask: boolean) {
  seedState(userData, [{ id: 'term', name: '터미널 일감', paneId: 'tp', cwd: userData }])
  const file = join(userData, 'state.json')
  const s = JSON.parse(readFileSync(file, 'utf8'))
  if (chatTask) {
    s.tasks.unshift({ ...s.tasks[0], id: 'chat', name: '대화 일감', tabs: [{ id: 'ct', layout: { type: 'pane', paneId: 'cp' }, activePaneId: 'cp' }], activeTabId: 'ct', panes: { cp: { id: 'cp', cwd: userData, kind: 'chat', chat: { agent: 'claude' } } } })
    s.activeTaskId = 'chat'
  }
  writeFileSync(file, JSON.stringify(s))
  app = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: userData, TASKMINAL_CLAUDE_BIN: FAKE_CLAUDE } })
  win = await firstWindow(app)
  await waitLoaded(win)
}
async function command(c: string) {
  await app!.evaluate(({ BrowserWindow }, cmd) => BrowserWindow.getAllWindows()[0]!.webContents.send('app:command', cmd), c)
}

test.beforeEach(() => {
  userData = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-e2e-')))
})
test.afterEach(async () => {
  await app?.close()
  app = undefined
  rmSync(userData, { recursive: true, force: true })
})

test('빈 빠른 명령 안내 띠: 대화 탭에서는 숨고 · 터미널 일감에서는 보인다', async () => {
  await launch(true)
  await expect(view().getByTestId('chat-pane')).toBeVisible()
  await expect(view().getByTestId('quick-empty')).toHaveCount(0)
  await win.getByTestId('task-row').filter({ hasText: '터미널 일감' }).click()
  await expect(view().getByTestId('quick-empty')).toBeVisible()
})

test('탭 이름: ⌘J 로 셸을 꺼내도 대화 이름 그대로 · 같은 폴더 탭은 번호로 나뉜다', async () => {
  await launch(true)
  const tabs = () => view().getByTestId('tab')
  await expect(tabs().first()).toContainText('Claude 대화')
  await win.keyboard.press('Meta+j')
  await expect(view().locator('.xterm')).toHaveCount(1)
  await expect(tabs().first()).toContainText('Claude 대화')

  await win.getByTestId('task-row').filter({ hasText: '터미널 일감' }).click()
  await command('new-tab')
  await command('new-tab')
  const name = userData.split('/').pop()!
  await expect(tabs()).toHaveCount(3)
  await expect(tabs().nth(0).getByRole('tab')).toHaveText(name)
  await expect(tabs().nth(1).getByRole('tab')).toHaveText(`${name} 2`)
  await expect(tabs().nth(2).getByRole('tab')).toHaveText(`${name} 3`)
})

test('빈 대화의 폴더는 짧게(…/끝 두 칸) · 전체 경로는 title', async () => {
  await launch(true)
  const empty = view().getByTestId('chat-empty')
  await expect(empty).toBeVisible()
  await expect(empty).not.toContainText(userData) // 긴 절대 경로를 그대로 쓰지 않는다
  await expect(empty.locator(`[title="${userData}"]`)).toContainText(userData.split('/').pop()!)
})

test("새 일감 대화상자: '색' 제목과 고른 색의 테두리가 겹치지 않는다", async () => {
  await launch(false)
  await command('new-task')
  const dialog = win.getByRole('dialog')
  const legend = await dialog.locator('legend', { hasText: '색' }).boundingBox()
  const swatch = await dialog.locator('.swatch.selected').boundingBox()
  // 테두리 바깥 끝 = 견본 위 - (outline 2 + offset 2)
  expect(swatch!.y - 4).toBeGreaterThanOrEqual(legend!.y + legend!.height + 2)
})

test("대화 머리: '셸 ⌘J'(아래에 셸) 와 'TUI 로 ⇧⌘J'(이 대화를 터미널 화면으로) 이름이 겹치지 않는다 · 사이드바 빈 안내는 대화 기준", async () => {
  await launch(true)
  const chat = view().getByTestId('chat-pane')
  await expect(chat.getByTestId('chat-shell')).toHaveText(/^셸/)
  await expect(chat.getByTestId('chat-to-tui')).toHaveText(/^TUI 로/)
  await expect(chat.getByRole('button', { name: /^터미널/ })).toHaveCount(0)
  await app!.close()
  seedState(userData, [])
  app = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: userData } })
  win = await firstWindow(app)
  await waitLoaded(win)
  await expect(win.getByTestId('sidebar')).toContainText('⌘N 이나 + 로 대화를 시작해요')
})
