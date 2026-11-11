import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstWindow, seedState, waitLoaded } from './helpers'

// 21b: 사이드바 흐름 보기 — 상태 칸 순서 · 끌어 놓아 상태 바꾸기 · / 거르기 · 보기 전환 · 안 본 끝남 → 확인 필요 + 점
let userData: string
let app: ElectronApplication | undefined
let win: Page

async function launch() {
  app = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: userData } })
  win = await firstWindow(app)
  await waitLoaded(win)
}
const sidebar = () => win.getByTestId('sidebar')
const section = (key: string) => sidebar().locator(`[data-testid="flow-section"][data-key="${key}"]`)
const anyRow = (name: string) => sidebar().locator(`[data-task-name="${name}"]`)
const saved = () => JSON.parse(readFileSync(join(userData, 'state.json'), 'utf8')) as { tasks: { name: string; statusId: string }[]; settings: { sidebarView: string; sidebarClosed: string[] } }

test.beforeEach(async () => {
  userData = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-e2e-')))
  seedState(
    userData,
    [
      { id: 'a', name: 'A 일감', paneId: 'pa', cwd: userData },
      { id: 'b', name: 'B 일감', paneId: 'pb', cwd: userData, statusId: 'wait' },
      { id: 'c', name: 'C 배포', paneId: 'pc', cwd: userData, statusId: 'done', groupId: 'g1' },
    ],
    [{ id: 'g1', name: '서버' }],
  )
  await launch()
})
test.afterEach(async () => {
  await app?.close()
  app = undefined
  rmSync(userData, { recursive: true, force: true })
})

test('기본은 흐름 보기: 상태 순서대로 칸, 일감은 제 칸에, 확인 필요 칸은 비면 없다', async () => {
  const keys = await sidebar().locator('[data-testid="flow-section"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-key')))
  expect(keys).toEqual(['doing', 'wait', 'done'])
  await expect(section('doing').getByTestId('task-row')).toHaveAttribute('data-task-name', 'A 일감')
  await expect(section('wait').getByTestId('task-row')).toHaveAttribute('data-task-name', 'B 일감')
  // 마지막 상태(완료)는 처음에 접혀 있다 — 개수만 보이고 열면 줄이 나온다
  await expect(section('done').getByTestId('task-row')).toHaveCount(0)
  await expect(section('done').locator('.group-count')).toHaveText('1')
  await expect(sidebar().getByTestId('attention-section')).toHaveCount(0)
  await win.screenshot({ path: 'test-results/sidebar-flow.png' })
  await section('done').getByRole('button', { name: /완료/ }).click()
  await expect(section('done').getByTestId('task-row')).toHaveAttribute('data-task-name', 'C 배포')
  // 흐름 보기의 둘째 줄은 묶음 이름
  await expect(section('done').locator('.task-group')).toHaveText('서버')
  await expect(sidebar().getByTestId('sidebar-bar')).toBeVisible()
})

test('끌어서 다른 칸에 놓으면 상태가 바뀌고 저장된다', async () => {
  await anyRow('B 일감').dragTo(section('doing'))
  await expect(section('doing').locator('[data-task-name="B 일감"]')).toBeVisible()
  await expect(section('wait').locator('.flow-empty')).toHaveText('여기로 끌어 놓기')
  await expect.poll(() => saved().tasks.find((t) => t.name === 'B 일감')?.statusId, { timeout: 5_000 }).toBe('doing')
  // 접힌 칸(완료)에도 놓을 수 있다
  await anyRow('B 일감').dragTo(section('done'))
  await expect.poll(() => saved().tasks.find((t) => t.name === 'B 일감')?.statusId, { timeout: 5_000 }).toBe('done')
  await expect(section('done').locator('.group-count')).toHaveText('2')
})

test('/ 로 거르기: 이름 · 묶음으로 걸러지고, Enter 는 첫 일감을 고르고, Esc 는 비운다', async () => {
  await sidebar().getByTestId('task-row').first().locator('.task-main').focus()
  await win.keyboard.press('/')
  const filter = sidebar().getByTestId('sidebar-filter')
  await expect(filter).toBeFocused()
  await filter.fill('서버')
  await expect(sidebar().getByTestId('task-row')).toHaveCount(1)
  await expect(section('doing').locator('.flow-empty')).toHaveText('맞는 일감 없음')
  await filter.press('Enter')
  await expect(win.locator('[data-testid="task-view"][aria-hidden="false"]')).toHaveAttribute('data-task-name', 'C 배포')
  // 묶음 보기에서도 같은 규칙: 폴더 · 묶음 이름으로 맞은 일감을 Enter 로 고른다
  await sidebar().getByRole('radio', { name: '묶음' }).click()
  await filter.fill('')
  await anyRow('A 일감').locator('.task-main').click()
  await filter.fill('서버')
  await filter.press('Enter')
  await expect(win.locator('[data-testid="task-view"][aria-hidden="false"]')).toHaveAttribute('data-task-name', 'C 배포')
  await sidebar().getByRole('radio', { name: '흐름' }).click()
  await filter.focus()
  await filter.press('Escape')
  await expect(filter).toHaveValue('')
  await expect(sidebar().getByTestId('task-row')).toHaveCount(2) // 거르는 동안만 접힌 완료 칸도 보였다
})

test('묶음 보기로 바꾸고 칸을 접으면 껐다 켜도 남는다', async () => {
  await section('wait').getByRole('button', { name: /대기/ }).click()
  await expect(section('wait').getByTestId('task-row')).toHaveCount(0)
  await sidebar().getByRole('radio', { name: '묶음' }).click()
  await expect(sidebar().getByRole('heading', { name: '서버' })).toBeVisible()
  await expect(sidebar().locator('[data-testid="flow-section"]')).toHaveCount(0)
  await expect.poll(() => saved().settings.sidebarView, { timeout: 5_000 }).toBe('group')
  expect(saved().settings.sidebarClosed).toEqual(['done', 'wait'])
  await app!.close()
  app = undefined
  await launch()
  await expect(sidebar().getByRole('radio', { name: '묶음' })).toHaveAttribute('aria-checked', 'true')
  await sidebar().getByRole('radio', { name: '흐름' }).click()
  await expect(section('wait').getByTestId('task-row')).toHaveCount(0) // 접힘도 남았다
})

test('보지 않는 일감의 명령이 끝나면 확인 필요 칸 + 점, 열어 보면 제 칸으로', async () => {
  await anyRow('B 일감').locator('.task-main').click()
  const term = win.locator('[data-testid="task-view"][data-task-name="B 일감"] .xterm-helper-textarea')
  await expect(win.locator('[data-testid="task-view"][data-task-name="B 일감"] .xterm-rows')).toContainText(/\S/, { timeout: 15_000 })
  await term.focus()
  await win.keyboard.type('sleep 1; echo DONE_B\n')
  await anyRow('A 일감').locator('.task-main').click()
  const need = sidebar().getByTestId('attention-section')
  await expect(need.getByTestId('attention-row')).toHaveAttribute('data-task-name', 'B 일감', { timeout: 15_000 })
  await expect(need.locator('[data-task-name="B 일감"]')).toHaveAttribute('data-unread', 'true')
  await expect(need.locator('.task-unread')).toBeVisible()
  await expect(section('wait').locator('[data-task-name="B 일감"]')).toHaveCount(0) // 두 칸에 겹쳐 나오지 않는다
  await win.screenshot({ path: 'test-results/sidebar-flow-need.png' })
  await need.locator('[data-task-name="B 일감"] .task-main').click()
  await expect(section('wait').locator('[data-task-name="B 일감"]')).toBeVisible()
  await expect(need).toHaveCount(0)
})

test('키보드만으로: 거르기 칸 ↓ → 첫 줄, ↑↓ 로 줄 사이, 맨 위 ↑ 는 거르기 칸', async () => {
  await sidebar().getByTestId('sidebar-filter').focus()
  await win.keyboard.press('ArrowDown')
  await expect(anyRow('A 일감').locator('.task-main')).toBeFocused()
  await win.keyboard.press('ArrowDown')
  await expect(anyRow('B 일감').locator('.task-main')).toBeFocused()
  await win.keyboard.press('Enter')
  await expect(win.locator('[data-testid="task-view"][aria-hidden="false"]')).toHaveAttribute('data-task-name', 'B 일감')
  await anyRow('B 일감').locator('.task-main').focus()
  await win.keyboard.press('ArrowUp')
  await win.keyboard.press('ArrowUp')
  await expect(sidebar().getByTestId('sidebar-filter')).toBeFocused()
})
