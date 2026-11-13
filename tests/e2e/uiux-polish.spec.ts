import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstWindow, seedState, waitLoaded } from './helpers'

let userData: string
let app: ElectronApplication | undefined
let win: Page

test.beforeEach(async () => {
  userData = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-e2e-')))
  seedState(userData, [{ id: 't', name: '로그인·결제 화면 사용성 개선', paneId: 'p', cwd: userData }])
  app = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: userData } })
  win = await firstWindow(app)
  await waitLoaded(win)
})
test.afterEach(async () => {
  await app?.close()
  app = undefined
  rmSync(userData, { recursive: true, force: true, maxRetries: 5 })
})

async function command(c: string) {
  await app!.evaluate(({ BrowserWindow }, cmd) => BrowserWindow.getAllWindows()[0]!.webContents.send('app:command', cmd), c)
}

test('사이드바: 보통 창에서 긴 일감 이름이 보이고 작은 창에서는 본문 공간을 남긴다', async () => {
  await win.setViewportSize({ width: 1280, height: 800 })
  const name = win.getByTestId('sidebar').locator('.task-name').first()
  await expect.poll(() => name.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true)
  const normal = (await win.getByTestId('sidebar').boundingBox())!.width
  await win.screenshot({ path: 'test-results/uiux-sidebar-wide.png' })
  await win.setViewportSize({ width: 640, height: 400 })
  const small = (await win.getByTestId('sidebar').boundingBox())!.width
  expect(small).toBeLessThan(normal)
  expect(640 - small).toBeGreaterThanOrEqual(390)
  await command('settings')
  await expect(win.getByRole('combobox',{name:'설정 칸 선택'})).toBeVisible()
  expect((await win.locator('.settings-main').boundingBox())!.width).toBeGreaterThanOrEqual(600)
  await win.screenshot({ path: 'test-results/uiux-settings-small.png' })
})

test('최소 창에서 새 일감 마지막 액션까지 스크롤하고 키보드로 취소할 수 있다', async () => {
  await win.setViewportSize({ width: 640, height: 400 })
  await command('new-task')
  const dialog = win.getByRole('dialog')
  await expect(dialog).toBeVisible()
  const bounds = (await dialog.boundingBox())!
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(400)
  const cancel = dialog.getByRole('button', { name: '취소', exact: true })
  await cancel.scrollIntoViewIfNeeded()
  const button = (await cancel.boundingBox())!
  expect(button.y + button.height).toBeLessThanOrEqual(400)
  await cancel.focus()
  await win.screenshot({ path: 'test-results/uiux-new-task-small.png' })
  await win.keyboard.press('Enter')
  await expect(dialog).toHaveCount(0)
})

test('모든 출력 찾기: Tab은 옵션 순회, 버튼 Enter는 해당 옵션만, 범위는 Control+Tab', async () => {
  await command('global-find')
  const find = win.getByTestId('global-find')
  const input = find.getByRole('textbox')
  const previous = find.getByRole('button', { name: '이전 세션', exact: true })
  await expect(input).toBeFocused()
  await win.keyboard.press('Tab')
  await expect(previous).toBeFocused()
  await expect(find.getByTestId('global-find-scope')).toHaveText('모든 일감')
  await win.keyboard.press('Enter')
  await expect(previous).toHaveAttribute('aria-pressed', 'false')
  await expect(find).toBeVisible()
  await win.keyboard.press('Shift+Tab')
  await expect(input).toBeFocused()
  await input.press('Control+Tab')
  await expect(find.getByTestId('global-find-scope')).toHaveText('지금 일감')
  await expect(input).toBeFocused()
  await input.press('Control+Shift+Tab')
  await expect(find.getByTestId('global-find-scope')).toHaveText('모든 일감')
  const last = find.getByRole('button').last()
  await last.focus()
  await win.keyboard.press('Tab')
  await expect(input).toBeFocused()
  await win.keyboard.press('Shift+Tab')
  await expect(last).toBeFocused()
  await win.screenshot({ path: 'test-results/uiux-find-keyboard.png' })
})

test('모든 출력 찾기의 더 보기는 Tab으로 도달하고 Enter로 나머지 결과를 펼친다', async () => {
  const term = win.getByTestId('pane-p')
  await expect(term.locator('.xterm-rows')).toContainText('%')
  await term.click()
  await win.keyboard.type("printf 'AUDIT_MATCH%02d\\n' {1..40}")
  await win.keyboard.press('Enter')
  await expect(term.locator('.xterm-rows')).toContainText('AUDIT_MATCH40')
  await command('global-find')
  const find = win.getByTestId('global-find')
  await find.getByRole('textbox').fill('AUDIT_MATCH')
  const more = find.getByRole('button', { name: /개 더 보기/ })
  await expect(more).toBeVisible()
  const before = await find.getByTestId('gf-row').count()
  for (let i = 0; i < 12; i++) {
    if (await more.evaluate((e) => document.activeElement === e)) break
    await win.keyboard.press('Tab')
  }
  await expect(more).toBeFocused()
  await win.keyboard.press('Enter')
  await expect(more).toHaveCount(0)
  expect(await find.getByTestId('gf-row').count()).toBeGreaterThan(before)
  await expect(find).toBeVisible()
  await win.screenshot({ path: 'test-results/uiux-find-expanded.png' })
})
