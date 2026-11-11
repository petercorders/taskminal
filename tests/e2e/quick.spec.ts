import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstWindow, seedState, waitLoaded, type SeedTask } from './helpers'

// 20단계: 빠른 명령 — 단추 줄 · 실행 · ✓/✗ · 바쁘면 새 탭 · 실행 전 확인 · ⌥숫자 · 메뉴 · ⌘P
let userData: string
let app: ElectronApplication | undefined
let win: Page

async function launch() {
  app = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: userData } })
  win = await firstWindow(app)
  await waitLoaded(win)
}
function seed(a: Partial<SeedTask> = {}, settings: Record<string, unknown> = {}) {
  seedState(
    userData,
    [
      { id: 'task-a', name: 'A 일감', paneId: 'pane-a', cwd: '/tmp', ...a },
      { id: 'task-b', name: 'B 일감', paneId: 'pane-b', cwd: '/tmp' },
    ],
    [],
    settings,
  )
}

test.describe.configure({ timeout: 90_000 })
test.beforeEach(() => {
  userData = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-e2e-')))
})
test.afterEach(async () => {
  await app?.close()
  app = undefined
  rmSync(userData, { recursive: true, force: true })
})

const view = () => win.locator('[data-testid="task-view"][aria-hidden="false"]')
const button = (label: string) => view().locator(`[data-testid="quick-button"][data-label="${label}"]`)
const term = (id: string) => win.getByTestId(`pane-${id}`)
const screenOf = (id: string) => term(id).locator('.xterm-rows').innerText()
const activeScreen = () => view().locator('[data-testid="tab-view"]:visible .xterm-rows').first().innerText()
async function waitText(read: () => Promise<string>, re: RegExp) {
  await expect.poll(async () => re.test((await read()).replace(/\n/g, '')), { timeout: 15_000 }).toBe(true)
}
/** 셸 통합 프롬프트가 한 번 뜬 뒤 — 그 전에는 '지금 pane' 이 통합 없음으로 보여 새 탭으로 간다 */
async function prompt(id: string) {
  await term(id).click()
  await win.keyboard.type('echo READY$((40+2))')
  await win.keyboard.press('Enter')
  await waitText(() => screenOf(id), /READY42/)
}
async function create(label: string, command: string, opts: { where?: string; scope?: 'task' | 'all' } = {}) {
  await view().getByTestId('quick-add').click()
  const ed = win.getByTestId('quick-editor')
  await expect(ed).toBeVisible()
  await ed.getByTestId('quick-label').fill(label)
  await ed.getByTestId('quick-command').fill(command)
  if (opts.where) await ed.getByTestId('quick-where').selectOption(opts.where)
  if (opts.scope) await ed.getByTestId('quick-scope').selectOption(opts.scope)
  await ed.getByTestId('quick-save').click()
  await expect(ed).toHaveCount(0)
}

test('처음 안내 → + 명령으로 만들기 → 누르면 지금 pane 에서 실행 · ✓, 실패는 ✗ 코드 (verify)', async () => {
  seed()
  await launch()
  await expect(view().getByTestId('quick-empty')).toBeVisible()
  await prompt('pane-a')
  await create('인사', 'echo QK$((1+1))')
  await create('실패', 'sh -c "echo OOPS-LINE; exit 3"')
  await button('인사').click()
  await waitText(() => screenOf('pane-a'), /QK2/)
  await expect(button('인사')).toHaveAttribute('data-state', 'done')
  await expect(button('인사').getByTestId('quick-state')).toHaveText(/✓/)
  await button('실패').click()
  await expect(button('실패')).toHaveAttribute('data-state', 'failed')
  await expect(button('실패').getByTestId('quick-state')).toHaveText(/✗ 3/)
  // 같은 pane 의 다음 명령이 실패해도 앞 단추는 자기 결과(✓) 그대로
  await expect(button('인사')).toHaveAttribute('data-state', 'done')
  // 실패 말풍선(title) — 그 실행의 마지막 출력 줄
  await expect.poll(async () => button('실패').getAttribute('title')).toMatch(/OOPS-LINE/)
  // 같은 pane 에서 돌았다 — 탭이 늘지 않았다
  await expect(view().getByTestId('tab')).toHaveCount(1)
  await win.screenshot({ path: 'test-results/quick-bar.png' })
  // 저장 파일에 남는다
  const saved = JSON.parse(readFileSync(join(userData, 'state.json'), 'utf8')) as { tasks: Array<{ id: string; quickCommands?: Array<{ label: string }> }> }
  await expect.poll(() => JSON.parse(readFileSync(join(userData, 'state.json'), 'utf8')).tasks[0].quickCommands?.length).toBe(2)
  expect(saved.tasks.length).toBe(2)
})

test('지금 pane 이 바쁘면 끼워 넣지 않고 새 탭에서 실행 + 알림', async () => {
  seed({ quickCommands: [{ id: 'q1', label: '바쁨', command: 'echo BUSY$((2+3))', where: 'current' }] })
  await launch()
  await prompt('pane-a')
  await term('pane-a').click()
  await win.keyboard.type('sleep 30')
  await win.keyboard.press('Enter')
  await expect(win.locator('[data-testid="task-row"][data-task-name="A 일감"]')).toHaveAttribute('data-activity', 'running')
  await button('바쁨').click()
  await expect(view().getByTestId('tab')).toHaveCount(2)
  await expect(win.getByTestId('toast')).toContainText('바빠서')
  await waitText(activeScreen, /BUSY5/)
  // 바쁜 pane 에는 입력되지 않았다
  expect(await screenOf('pane-a')).not.toMatch(/BUSY5/)
})

test('위험 명령은 만들 때 실행 전 확인이 켜지고, 누르면 묻는다 — Esc 는 실행 안 함 · 다시 묻지 않기', async () => {
  seed()
  await launch()
  await prompt('pane-a')
  await view().getByTestId('quick-add').click()
  const ed = win.getByTestId('quick-editor')
  await ed.getByTestId('quick-label').fill('배포')
  await ed.getByTestId('quick-command').fill('echo DEPLOY$((1+1)) # ./deploy.sh')
  await expect(ed.getByTestId('quick-confirm')).toBeChecked()
  await expect(ed.getByTestId('quick-confirm-reason')).toContainText('위험')
  await ed.getByTestId('quick-save').click()
  await expect(button('배포')).toContainText('배포…')

  await button('배포').click()
  const dlg = win.getByTestId('quick-confirm-dialog')
  await expect(dlg).toContainText('echo DEPLOY$((1+1))')
  await win.keyboard.press('Escape')
  await expect(dlg).toHaveCount(0)
  await win.waitForTimeout(500)
  expect(await screenOf('pane-a')).not.toMatch(/DEPLOY2/)

  await button('배포').click()
  await dlg.getByTestId('quick-dont-ask').check()
  await win.keyboard.press('Enter')
  await waitText(() => screenOf('pane-a'), /DEPLOY2/)
  await expect(button('배포')).toHaveText(/^배포(?!…)/)
  // 다시 누르면 묻지 않는다
  await button('배포').click()
  await expect(dlg).toHaveCount(0)
})

test('⌥1 로 실행 · 우클릭 › 지우기 → 되돌리기, 모든 일감 단추는 다른 일감에도 · 재시작 뒤에도', async () => {
  seed()
  await launch()
  await prompt('pane-a')
  await create('하나', 'echo ONE$((0+1))')
  await create('공통', 'echo ALL$((3+4))', { scope: 'all' })
  await expect(button('공통')).toContainText('◎')

  await term('pane-a').click()
  await win.keyboard.press('Alt+Digit1')
  await waitText(() => screenOf('pane-a'), /ONE1/)

  await button('하나').click({ button: 'right' })
  const menu = win.getByTestId('quick-menu')
  await expect(menu.getByRole('menuitem', { name: '표시 지우기' })).toHaveCount(0) // 성공한 단추엔 없다
  await menu.getByRole('menuitem', { name: '지우기', exact: true }).click()
  await expect(button('하나')).toHaveCount(0)
  await win.getByTestId('toast-action').click()
  await expect(button('하나')).toHaveCount(1)

  // 다른 일감
  await win.locator('[data-testid="task-row"][data-task-name="B 일감"] .task-main').click()
  await expect(button('공통')).toHaveCount(1)
  await expect(button('하나')).toHaveCount(0)

  // 재시작 — waitLoaded 는 첫 일감 화면을 기다리므로 A 로 돌아와서 끈다
  await win.locator('[data-testid="task-row"][data-task-name="A 일감"] .task-main').click()
  await app!.close()
  await launch()
  await expect(button('하나')).toHaveCount(1)
  await expect(button('공통')).toHaveCount(1)
})

test('⌘P 에서 다른 일감의 빠른 명령 → 그 일감으로 가서 실행 · ⇧↩ 는 입력줄에 넣기만', async () => {
  seed({ quickCommands: [{ id: 'q1', label: '빌드 시험', command: 'echo BUILT$((5+5))', where: 'current' }] })
  await launch()
  await prompt('pane-a')
  await win.locator('[data-testid="task-row"][data-task-name="B 일감"] .task-main').click()
  await prompt('pane-b')
  await app!.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('palette')!.click())
  await win.getByRole('combobox', { name: '찾기' }).fill('빌드 시험')
  const item = win.locator('[data-testid="palette-item"][data-kind="quick"]').first()
  await expect(item).toContainText('A 일감')
  await win.keyboard.press('Shift+Enter')
  // 넣기만 — A 일감으로 가서 입력줄에 글자만
  await expect(win.locator('[data-testid="task-view"][aria-hidden="false"]')).toHaveAttribute('data-task-name', 'A 일감')
  await waitText(() => screenOf('pane-a'), /echo BUILT\$\(\(5\+5\)\)/)
  expect(await screenOf('pane-a')).not.toMatch(/BUILT10/)
  await win.keyboard.press('Enter')
  await waitText(() => screenOf('pane-a'), /BUILT10/)
})

test('명령 기록 ⋯ › 빠른 명령으로 저장 — 그 명령이 채워진 만들기 창', async () => {
  seed()
  await launch()
  await prompt('pane-a')
  await app!.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('history')!.click())
  await win.getByRole('checkbox', { name: '짧은 명령 숨기기' }).uncheck()
  const row = win.getByTestId('history-row').filter({ hasText: 'READY' }).first()
  await row.locator('.history-line').click()
  await row.getByTestId('history-more').click()
  await win.getByTestId('history-save-quick').click()
  const ed = win.getByTestId('quick-editor')
  await expect(ed.getByTestId('quick-command')).toHaveValue('echo READY$((40+2))')
  await ed.getByTestId('quick-label').fill('준비')
  await ed.getByTestId('quick-save').click()
  await expect(button('준비')).toHaveCount(1)
})

test('새 탭에서 실행 중인 단추의 탭을 닫으면 실행 중으로 남지 않는다 (상태 모름)', async () => {
  seed({ quickCommands: [{ id: 'q1', label: '오래', command: 'sleep 30', where: 'newTab' }] })
  await launch()
  await prompt('pane-a')
  await button('오래').click()
  await expect(view().getByTestId('tab')).toHaveCount(2)
  await expect(button('오래')).toHaveAttribute('data-state', 'running')
  await view().getByRole('button', { name: /탭 닫기/ }).nth(1).click()
  const dialog = win.getByRole('alertdialog')
  await dialog.getByRole('button', { name: '닫기' }).click()
  await expect(view().getByTestId('tab')).toHaveCount(1)
  await expect(button('오래')).toHaveAttribute('data-state', 'unknown')
})

test('Option 을 Meta 로 켜 두면 ⌥1 은 단추가 아니라 셸로 간다', async () => {
  seed({ quickCommands: [{ id: 'q1', label: '하나', command: 'echo ONE$((0+1))', where: 'current' }] }, { optionAsMeta: true })
  await launch()
  await prompt('pane-a')
  await term('pane-a').click()
  await win.keyboard.press('Alt+Digit1')
  await win.waitForTimeout(500)
  expect(await screenOf('pane-a')).not.toMatch(/ONE1/)
  await expect(button('하나')).toHaveAttribute('data-state', 'idle')
})
