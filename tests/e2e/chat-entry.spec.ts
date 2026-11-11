import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { firstWindow, seedState, waitLoaded } from './helpers'

// 26단계 A: 대화를 ⌘P 밖에서도 연다 — 메뉴 막대 파일 › 새 대화 · 탭 줄 "▾" 메뉴
const FAKE_CLAUDE = resolve(__dirname, '../fixtures/fake-claude.mjs')
const FAKE_CODEX = resolve(__dirname, '../fixtures/fake-codex.mjs')
let userData: string
let app: ElectronApplication | undefined
let win: Page

const view = () => win.locator('[data-testid="task-view"][aria-hidden="false"]')
const chats = () => view().getByTestId('chat-pane')

test.beforeEach(async () => {
  userData = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-e2e-')))
  seedState(userData, [{ id: 'task-a', name: 'A 일감', paneId: 'pane-a', cwd: userData }])
  app = await electron.launch({
    args: ['.'],
    env: { ...process.env, TASKMINAL_USER_DATA: userData, TASKMINAL_CLAUDE_BIN: FAKE_CLAUDE, TASKMINAL_CODEX_BIN: FAKE_CODEX },
  })
  win = await firstWindow(app)
  await waitLoaded(win)
})
test.afterEach(async () => {
  await app?.close()
  app = undefined
  rmSync(userData, { recursive: true, force: true })
})

test('메뉴 막대 파일 › 새 대화 (Claude) · (Codex) 가 새 대화 탭을 연다', async () => {
  const labels = await app!.evaluate(({ Menu }) => {
    const m = Menu.getApplicationMenu()!
    const file = m.items.find((i) => i.label === '파일')
    return file?.submenu?.items.map((i) => i.id ?? '') ?? []
  })
  expect(labels).toEqual(expect.arrayContaining(['chat-new', 'chat-new-codex', 'chat-split', 'chat-split-codex']))

  await app!.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('chat-new')!.click())
  await expect(chats()).toHaveCount(1)
  await expect(chats().first()).toHaveAttribute('data-agent', 'claude')

  await app!.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('chat-new-codex')!.click())
  await expect(view().getByTestId('chat-pane').and(win.locator('[data-agent="codex"]'))).toBeVisible()
  // 탭이 둘 늘었다(셸 탭 + 대화 탭 둘)
  await expect(view().getByRole('tab')).toHaveCount(3)
})

test('탭 줄 "▾" 메뉴의 새 대화 (Claude) · (Codex)', async () => {
  await view().getByRole('button', { name: '새 대화 · 템플릿 탭' }).click()
  await win.getByTestId('tab-menu-chat-codex').click()
  await expect(win.getByTestId('template-menu')).toHaveCount(0)
  await expect(chats().first()).toHaveAttribute('data-agent', 'codex')

  await view().getByRole('button', { name: '새 대화 · 템플릿 탭' }).click()
  // 메뉴를 열면 첫 항목(새 대화 Claude)에 포커스 — 키보드로 바로 고른다
  await expect(win.getByTestId('tab-menu-chat-claude')).toBeFocused()
  await win.keyboard.press('Enter')
  await expect(view().getByRole('tab')).toHaveCount(3)
  await expect(view().locator('[data-testid="chat-pane"][data-agent="claude"]')).toHaveCount(1)
})
