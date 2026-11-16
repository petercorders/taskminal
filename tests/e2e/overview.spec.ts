import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstWindow, seedState, waitLoaded } from './helpers'

let userData: string
let app: ElectronApplication | undefined
let win: Page

test.beforeEach(async () => {
  userData = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-overview-')))
  seedState(userData, [
    { id: 'server', name: '서버 API 작업', paneId: 'shell-one', cwd: userData },
    { id: 'ui', name: '화면 작업', paneId: 'shell-ui', cwd: userData, statusId: 'done' },
  ])
  const path = join(userData, 'state.json')
  const state = JSON.parse(readFileSync(path, 'utf8'))
  state.tasks[0].tabs.push({ id: 'server-extra', title: '검증 셸', layout: { type: 'pane', paneId: 'shell-two' }, activePaneId: 'shell-two' })
  state.tasks[0].panes['shell-two'] = { id: 'shell-two', cwd: userData }
  writeFileSync(path, JSON.stringify(state))
  app = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: userData } })
  win = await firstWindow(app)
  await waitLoaded(win)
})
test.afterEach(async () => {
  await app?.close()
  app = undefined
  rmSync(userData, { recursive: true, force: true, maxRetries: 5 })
})

async function openOverview() {
  const entry = win.locator('button.sidebar-overview:visible, button.compact-overview:visible')
  await expect(entry).toHaveCount(1)
  await entry.click()
  await expect(win.getByTestId('overview')).toBeVisible()
}

test('전체 보기에서 상태·검색을 거르고 선택한 탭의 정확한 pane으로 이동한다', async () => {
  await openOverview()
  const overview = win.getByTestId('overview')
  const search = overview.getByRole('textbox', { name: '전체 일감 찾기' })
  await expect(search).toBeFocused()
  for(const control of [search,overview.getByRole('combobox',{name:'전체 보기 상태'})]){
    const box=await control.boundingBox();expect(box!.height).toBeGreaterThanOrEqual(24)
  }
  await expect(overview.getByTestId('overview-card')).toHaveCount(2)
  await win.screenshot({ path: 'test-results/overview-wide.png' })
  await overview.getByRole('combobox', { name: '전체 보기 상태' }).selectOption('done')
  await expect(overview.getByTestId('overview-card')).toHaveCount(1)
  await expect(overview.getByTestId('overview-card')).toContainText('화면 작업')
  await search.fill('없는 일감')
  await expect(overview).toContainText('조건에 맞는 일감이 없습니다.')
  await overview.getByRole('button', { name: '검색과 필터 지우기' }).click()
  await expect(search).toBeFocused()
  await search.fill('서버')
  await expect(overview.getByTestId('overview-card')).toHaveCount(1)
  await overview.getByRole('button', { name: /검증 셸 · 터미널/ }).click()
  await expect(overview).toHaveCount(0)
  await expect(win.locator('[data-testid="tab-view"][data-tab-id="server-extra"]')).toBeVisible()
  await expect(win.getByTestId('pane-shell-two')).toBeVisible()
  await expect(win.getByTestId('pane-shell-one')).toBeHidden()
})

test('전체 보기를 열고 닫아도 이미 실행한 셸 프로세스와 출력은 이어진다', async () => {
  const term = win.getByTestId('pane-shell-one')
  await expect(term.locator('.xterm-rows')).toContainText('%')
  await win.evaluate(() => window.taskminal.pty.write('shell-one', 'sleep 1; echo OVERVIEW_LIVE_$((10+7))\r'))
  await openOverview()
  await expect(win.getByTestId('overview')).toContainText('실행 중')
  await win.getByRole('textbox', { name: '전체 일감 찾기' }).press('Escape')
  await expect(win.getByTestId('overview')).toHaveCount(0)
  await expect(term.locator('.xterm-rows')).toContainText('OVERVIEW_LIVE_17')
})

test('최소 창과 200% 확대에서 검색·상태·카드 이동을 키보드로 사용할 수 있다', async () => {
  await win.setViewportSize({ width: 640, height: 400 })
  await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(2))
  await expect.poll(() => win.evaluate(() => innerWidth)).toBe(320)
  await openOverview()
  const overview = win.getByTestId('overview')
  const search = overview.getByRole('textbox', { name: '전체 일감 찾기' })
  await search.fill('서버')
  const card = overview.getByTestId('overview-card')
  const target = card.getByRole('button', { name: '서버 API 작업', exact: true })
  await target.scrollIntoViewIfNeeded()
  await target.focus()
  await win.screenshot({ path: 'test-results/overview-small-zoom.png' })
  await win.keyboard.press('Enter')
  await expect(overview).toHaveCount(0)
  await expect(win.locator('[data-testid="task-view"][data-task-name="서버 API 작업"]')).toBeVisible()
})
