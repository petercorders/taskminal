import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstWindow, seedState, waitLoaded, captureWindow } from './helpers'

let app: ElectronApplication, win: Page, data: string
test.beforeEach(async () => {
  data = mkdtempSync(join(tmpdir(), 'taskminal-layout-ux-'))
  seedState(data, [{ id: 'one', name: '첫 일감', paneId: 'first', cwd: data }, { id: 'two', name: '다른 일감', paneId: 'second', cwd: data }])
  app = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: data } })
  win = await firstWindow(app)
  await waitLoaded(win)
  mkdirSync('test-results/layout-ux', { recursive: true })
})
test.afterEach(async () => { await app?.close(); rmSync(data, { recursive: true, force: true, maxRetries: 5 }) })

test('900px에서 줄바꿈된 도구 줄을 보조 화면이 덮지 않고 헤더를 유지한다', async () => {
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]!; window.webContents.setZoomFactor(1); window.setSize(900, 700) })
  await win.getByRole('button', { name: '작업 흐름', exact: true }).click()
  await expect(win.locator('.workflow-panel')).toBeVisible()
  await expect.poll(() => win.evaluate(() => {
    const toolbar = document.querySelector<HTMLElement>('.workspace-toolbar')!, panel = document.querySelector<HTMLElement>('.work-tool-panel')!
    const tools = toolbar.getBoundingClientRect(), bounds = panel.getBoundingClientRect()
    const buttons = Array.from(toolbar.querySelectorAll('button')).filter(button => button.getClientRects().length)
    return { wrapped: tools.height > 60, allReachable: buttons.length >= 6 && buttons.every(button => button.getBoundingClientRect().bottom <= bounds.top + 1), followsToolbar: Math.abs(bounds.top - tools.bottom) <= 1 }
  })).toEqual({ wrapped: true, allReachable: true, followsToolbar: true })
  await win.getByRole('button', { name: '새로 만들기', exact: true }).click()
  await win.getByRole('button', { name: /단계 추가/ }).click()
  await win.locator('.work-tool-panel').evaluate(element => { element.scrollTop = 0 })
  const beforeScroll = await win.locator('.work-tool-panel').evaluate(element => {
    const panel = element.getBoundingClientRect(), header = element.querySelector(':scope > header')!.getBoundingClientRect()
    return { panelTop: panel.top, headerTop: header.top, headerBottom: header.bottom, headerHeight: header.height, paddingTop: getComputedStyle(element).paddingTop, scrollTop: element.scrollTop }
  })
  await win.locator('.work-tool-panel').evaluate(element => { element.scrollTop = element.scrollHeight })
  await expect.poll(() => win.locator('.work-tool-panel').evaluate((element, initial) => {
    const panel = element.getBoundingClientRect(), header = element.querySelector(':scope > header')!.getBoundingClientRect()
    return { scrolled: element.scrollTop > initial.scrollTop + initial.headerHeight, sticky: Math.abs(header.top - initial.headerTop) <= 1, visible: header.height > 0 && header.top >= Math.max(0, panel.top) && header.bottom <= Math.min(innerHeight, panel.bottom) }
  }, beforeScroll)).toEqual({ scrolled: true, sticky: true, visible: true })
  const afterScroll = await win.locator('.work-tool-panel').evaluate(element => {
    const panel = element.getBoundingClientRect(), header = element.querySelector(':scope > header')!.getBoundingClientRect()
    return { panelTop: panel.top, headerTop: header.top, headerBottom: header.bottom, panelBottom: panel.bottom, scrollTop: element.scrollTop }
  })
  await test.info().attach('header-scroll-geometry', { body: JSON.stringify({ beforeScroll, afterScroll }, null, 2), contentType: 'application/json' })
  await captureWindow(app, 'test-results/layout-ux/toolbar-900.png')
})

test('320 CSS px 서랍은 포커스를 가두고 Escape 복원·배경 단축키 차단·설정 열기를 지킨다', async () => {
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]!; window.setSize(640, 400); window.webContents.setZoomFactor(2) })
  await expect.poll(() => win.evaluate(() => innerWidth)).toBeLessThanOrEqual(320)
  const opener = win.getByRole('button', { name: '일감 목록', exact: true })
  const drawer = win.getByRole('dialog', { name: '일감 목록', exact: true })
  const tabsBefore = await win.getByTestId('tab').count()
  await opener.focus(); await opener.press('Enter')
  await expect(drawer).toBeVisible()
  await expect(drawer.getByRole('textbox', { name: '일감 거르기' })).toBeFocused()
  await win.keyboard.press('Escape'); await expect(drawer).toHaveCount(0); await expect(opener).toBeFocused()
  await opener.press('Enter'); await drawer.getByRole('textbox', { name: '일감 거르기' }).fill('첫')
  await win.keyboard.press('Escape'); await expect(drawer).toBeVisible(); await expect(drawer.getByRole('textbox', { name: '일감 거르기' })).toHaveValue('')
  expect(await win.locator('main.workspace').evaluate(element => (element as HTMLElement).inert)).toBe(true)
  const close = drawer.getByRole('button', { name: '일감 목록 닫기' })
  await close.focus(); await win.keyboard.press('Shift+Tab')
  expect(await drawer.evaluate(element => element.contains(document.activeElement))).toBe(true)
  await win.keyboard.press('Tab'); await expect(close).toBeFocused()
  await win.keyboard.press('Meta+t'); await win.keyboard.press('Meta+w')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('app:command', 'new-tab'))
  await expect(drawer).toBeVisible()
  await expect(win.getByTestId('tab')).toHaveCount(tabsBefore)
  await captureWindow(app, 'test-results/layout-ux/drawer-320-css.png')
  await win.keyboard.press('Escape')
  await expect(drawer).toHaveCount(0); await expect(opener).toBeFocused()
  expect(await win.locator('main.workspace').evaluate(element => (element as HTMLElement).inert)).toBe(false)
  await opener.click(); await drawer.getByRole('button', { name: '설정', exact: true }).click()
  await expect(drawer).toHaveCount(0); await expect(win.getByRole('dialog', { name: '설정', exact: true })).toBeVisible()
  await expect(win.getByTestId('tab')).toHaveCount(tabsBefore)
  await captureWindow(app, 'test-results/layout-ux/settings-from-drawer-320-css.png')
})

test('서랍에서 새 일감·작업 도구·다른 일감을 고르면 먼저 닫고 해당 동작만 실행한다', async () => {
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]!; window.setSize(640, 400); window.webContents.setZoomFactor(2) })
  const opener = win.getByRole('button', { name: '일감 목록', exact: true })
  const drawer = win.getByRole('dialog', { name: '일감 목록', exact: true })
  await opener.click(); await drawer.getByRole('button', { name: '새 일감', exact: true }).click()
  await expect(drawer).toHaveCount(0); await expect(win.getByRole('dialog', { name: '새 일감', exact: true })).toBeVisible()
  await win.keyboard.press('Escape')
  await opener.click(); await drawer.getByRole('combobox', { name: '작업 도구 선택' }).selectOption('workflow')
  await expect(drawer).toHaveCount(0); await expect(win.locator('.workflow-panel')).toBeVisible()
  await opener.click(); await drawer.locator('li[data-task-name="다른 일감"] .task-main').click()
  await expect(drawer).toHaveCount(0)
  await expect(win.getByTestId('task-view').filter({ visible: true })).toHaveAttribute('data-task-name', '다른 일감')
})
