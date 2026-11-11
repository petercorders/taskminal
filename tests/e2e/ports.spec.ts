import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstWindow, seedState, waitLoaded } from './helpers'

// 20단계: 포트 감지 — 셸 자손이 듣는 포트를 탭 · 사이드바 칩으로, 누르면 바깥 브라우저(가짜 openExternal)
let userData: string
let app: ElectronApplication | undefined
let win: Page

async function launch() {
  app = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: userData, TASKMINAL_PORT_POLL_MS: '300' } })
  win = await firstWindow(app)
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { opened: string[] }
    g.opened = []
    shell.openExternal = async (url: string) => {
      g.opened.push(url)
    }
  })
  await waitLoaded(win)
}

test.describe.configure({ timeout: 90_000 })
test.beforeEach(async () => {
  userData = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-e2e-')))
  seedState(userData, [
    { id: 'task-a', name: 'A 일감', paneId: 'pane-a', cwd: '/tmp' },
    { id: 'task-b', name: 'B 일감', paneId: 'pane-b', cwd: '/tmp' },
  ])
  await launch()
})
test.afterEach(async () => {
  await app?.close()
  app = undefined
  rmSync(userData, { recursive: true, force: true })
})

const opened = () => app!.evaluate(() => (globalThis as unknown as { opened: string[] }).opened)
const term = (id: string) => win.getByTestId(`pane-${id}`)
const screenOf = (id: string) => term(id).locator('.xterm-rows').innerText()
const tabChip = (port: number) => win.locator(`[data-testid="tab-bar"] [data-testid="port-chip"][data-port="${port}"]`).first()
const sideRow = (name: string) => win.locator(`[data-testid="task-row"][data-task-name="${name}"]`)
async function run(id: string, command: string) {
  await term(id).click()
  await win.keyboard.type(command)
  await win.keyboard.press('Enter')
}
async function serve(id: string, port: number) {
  await run(id, `python3 -m http.server ${port} --bind 127.0.0.1`)
  await expect(tabChip(port)).toBeVisible({ timeout: 15_000 })
}
const port = () => 20000 + Math.floor(Math.random() * 20000)

test('python 서버 → 탭 · 사이드바에 칩, 누르면 http://localhost:포트 를 연다 · 처음 한 번 알림 (verify)', async () => {
  const p = port()
  await serve('pane-a', p)
  await expect(sideRow('A 일감').getByTestId('sidebar-ports')).toContainText(`:${p}`)
  await expect(win.getByTestId('toast')).toContainText(`${p} 에서 서버가 떴어요`)
  await win.screenshot({ path: 'test-results/ports-chip.png' })
  await tabChip(p).click()
  await expect.poll(opened).toEqual([`http://localhost:${p}/`])
  // 처음 알림은 한 번만 — 저장된다
  await expect.poll(() => JSON.parse(readFileSync(join(userData, 'state.json'), 'utf8')).settings.portTipSeen).toBe(true)
})

test('^C 로 서버를 끄면 칩이 닫힘(취소선)으로 남았다 사라진다', async () => {
  const p = port()
  await serve('pane-a', p)
  await term('pane-a').click()
  await win.keyboard.press('Control+c')
  await expect(tabChip(p)).toHaveAttribute('data-closed', 'true', { timeout: 10_000 })
  await expect(tabChip(p)).toContainText('닫힘')
  await win.screenshot({ path: 'test-results/ports-closed.png' })
  await expect(tabChip(p)).toHaveCount(0, { timeout: 15_000 })
})

test('칩 메뉴: 숨기기 → 되돌리기, 끄기… → 확인 → 서버만 꺼지고 셸은 남는다', async () => {
  const p = port()
  await serve('pane-a', p)
  await tabChip(p).click({ button: 'right' })
  const menu = win.getByTestId('port-menu')
  await expect(menu).toContainText(`:${p}`)
  await menu.getByRole('menuitem', { name: '이 포트 숨기기' }).click()
  await expect(tabChip(p)).toHaveCount(0)
  await win.getByTestId('toast-action').click()
  await expect(tabChip(p)).toBeVisible()

  await tabChip(p).focus()
  await win.keyboard.press('Shift+F10')
  await win.getByTestId('port-menu').getByRole('menuitem', { name: '이 포트 끄기…' }).click()
  const dlg = win.getByTestId('port-kill-dialog')
  await expect(dlg).toContainText('셸은 남아요')
  // 기본 포커스는 취소 — ↩ 로는 끄지 않는다
  await win.keyboard.press('Enter')
  await expect(dlg).toHaveCount(0)
  await expect(tabChip(p)).not.toHaveAttribute('data-closed', 'true')

  await tabChip(p).click({ button: 'right' })
  await win.getByTestId('port-menu').getByRole('menuitem', { name: '이 포트 끄기…' }).click()
  await win.getByTestId('port-kill').click()
  await expect(win.getByTestId('toast')).toContainText('껐어요')
  await expect(tabChip(p)).toHaveAttribute('data-closed', 'true', { timeout: 10_000 })
  // 셸은 남아 있다 — 다음 명령이 돈다
  await run('pane-a', 'echo ALIVE$((6*7))')
  await expect.poll(async () => (await screenOf('pane-a')).includes('ALIVE42'), { timeout: 10_000 }).toBe(true)
})

test('⌘P 에서 "포트" 로 모든 포트 · ↩ 로 열기', async () => {
  const p = port()
  await serve('pane-a', p)
  await app!.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('palette')!.click())
  await win.getByRole('combobox', { name: '찾기' }).fill('포트')
  const item = win.locator('[data-testid="palette-item"][data-kind="port"]')
  await expect(item).toHaveCount(1)
  await expect(item).toContainText(`:${p}`)
  await expect(item).toContainText('A 일감')
  await win.keyboard.press('Enter')
  await expect.poll(opened).toEqual([`http://localhost:${p}/`])
})

test('다른 일감이 쓰는 포트 때문에 다음 번호로 뜨면 겹침 알림', async () => {
  // 'p 가 쓰는 중이면 p+1' 하는 서버 흉내 — 다른 일감(A)이 p 를 듣는 동안 B 가 p+1 로 뜬다
  const p = port()
  await serve('pane-a', p)
  await sideRow('B 일감').locator('.task-main').click()
  await run('pane-b', `python3 -m http.server ${p + 1} --bind 127.0.0.1`)
  const bar = win.getByTestId('port-conflict')
  await expect(bar).toContainText(`${p} 은 ‘A 일감’ 이 쓰고 있어서 이 서버는 ${p + 1} 로 떴어요`, { timeout: 15_000 })
  await win.screenshot({ path: 'test-results/ports-conflict.png' })
  await bar.getByRole('button', { name: 'A 일감 으로 가기' }).click()
  await expect(win.locator('[data-testid="task-view"][aria-hidden="false"]')).toHaveAttribute('data-task-name', 'A 일감')
})
