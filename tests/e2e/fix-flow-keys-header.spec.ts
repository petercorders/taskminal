import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstWindow, seedState, waitLoaded } from './helpers'

// 작은 고침(2026-11-11 사용자 결정): ① 흐름 보기 상태 옮기기 ⌃⌘← / ⌃⌘→ ② 칸 머리 등 화면에 보이는 명령 글의 비밀값 가리기
let userData: string
let app: ElectronApplication | undefined
let win: Page

async function launch() {
  app = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: userData } })
  win = await firstWindow(app)
  await waitLoaded(win)
}
const menu = (id: string) => app!.evaluate(({ Menu }, id) => Menu.getApplicationMenu()!.getMenuItemById(id)!.click(), id)
const sidebar = () => win.getByTestId('sidebar')
const section = (key: string) => sidebar().locator(`[data-testid="flow-section"][data-key="${key}"]`)
const saved = () => JSON.parse(readFileSync(join(userData, 'state.json'), 'utf8')) as { tasks: { name: string; statusId: string }[] }
const statusOf = (name: string) => saved().tasks.find((t) => t.name === name)?.statusId

test.afterEach(async () => {
  await app?.close()
  app = undefined
  rmSync(userData, { recursive: true, force: true })
})

test.describe('상태 옮기기', () => {
  test.beforeEach(async () => {
    userData = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-e2e-')))
    seedState(userData, [
      { id: 'a', name: 'A 일감', paneId: 'pa', cwd: userData },
      { id: 'b', name: 'B 일감', paneId: 'pb', cwd: userData, statusId: 'wait' },
    ])
    await launch()
  })

  test('메뉴 다음 · 이전 상태로: 지금 일감이 옆 칸으로 가고 저장된다, 끝에서는 그대로, 재시작 뒤 유지', async () => {
    // 메뉴에 ⌃⌘→ / ⌃⌘← 로 보인다
    const accels = await app!.evaluate(({ Menu }) => ['status-next', 'status-prev'].map((id) => String(Menu.getApplicationMenu()!.getMenuItemById(id)!.accelerator)))
    expect(accels).toEqual(['Control+Command+Right', 'Control+Command+Left'])

    await menu('status-next')
    await expect(section('wait').locator('[data-task-name="A 일감"]')).toBeVisible()
    await expect(win.getByTestId('toast')).toContainText('‘A 일감’ → 대기')
    await expect.poll(() => statusOf('A 일감'), { timeout: 5_000 }).toBe('wait')

    await menu('status-next')
    await expect.poll(() => statusOf('A 일감'), { timeout: 5_000 }).toBe('done')
    // 마지막 상태에서 다음은 그대로 — 첫 상태로 돌지 않는다
    await menu('status-next')
    await expect(win.getByTestId('toast')).toContainText('이미 마지막 상태예요')
    expect(statusOf('A 일감')).toBe('done')

    await menu('status-prev')
    await expect.poll(() => statusOf('A 일감'), { timeout: 5_000 }).toBe('wait')
    expect(statusOf('B 일감')).toBe('wait') // 다른 일감은 그대로

    await app!.close()
    app = undefined
    await launch()
    await expect(section('wait').locator('[data-task-name="A 일감"]')).toBeVisible()
  })

  test('⌃⌘→ 키도 같은 명령 (renderer 가 capture 로 받는다)', async () => {
    await win.getByTestId('pane-pa').click()
    await win.keyboard.press('Control+Meta+ArrowRight')
    await expect.poll(() => statusOf('A 일감'), { timeout: 5_000 }).toBe('wait')
    await win.keyboard.press('Control+Meta+ArrowLeft')
    await expect.poll(() => statusOf('A 일감'), { timeout: 5_000 }).toBe('doing')
  })
})

test.describe('명령 글 가리기', () => {
  const KEY = 'sk-ant-api03-' + 'Hx7qP_m-2'.repeat(6)
  test.beforeEach(async () => {
    userData = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-e2e-')))
    seedState(userData, [{ id: 'a', name: 'A 일감', paneId: 'pa', cwd: '/tmp' }])
    await launch()
  })

  test('실행 중 명령의 비밀값: 칸 머리 · 사이드바 둘째 줄 · 닫기 확인에 원문이 없다, ⇧⌘H 로 끄면 원문', async () => {
    const term = win.getByTestId('pane-pa')
    await expect.poll(async () => /%/.test(await term.locator('.xterm-rows').innerText()), { timeout: 15_000 }).toBe(true)
    await term.click()
    await win.keyboard.type(`echo ${KEY} >/dev/null; sleep 30`)
    await win.keyboard.press('Enter')
    const head = win.locator('[data-testid="pane-slot"][data-pane-id="pa"]').getByTestId('pane-head')
    await expect(head).toHaveAttribute('data-activity', 'running')
    await expect(head).toContainText('‹가림:')
    await expect(head).not.toContainText(KEY)
    expect(await head.locator('.pane-head-command').getAttribute('title')).not.toContain(KEY)
    const last = sidebar().getByTestId('task-last')
    await expect(last).toContainText('‹가림:')
    await expect(last).not.toContainText(KEY)
    await win.screenshot({ path: 'test-results/command-mask.png' })

    // 실행 중 닫기 확인 창
    await menu('close-pane')
    const dialog = win.locator('[aria-modal="true"]')
    await expect(dialog).toContainText('‹가림:')
    await expect(dialog).not.toContainText(KEY)
    await win.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    // 가리기를 끄면 원문 — 캐시가 낡은 가림을 남기지 않는다
    await menu('mask-toggle')
    await expect(head).toContainText(KEY)
    await menu('mask-toggle')
    await expect(head).not.toContainText(KEY)
  })

  test('⌘Y 실행 중 줄 · 시스템 알림 본문은 화면 가리기를 꺼도 늘 가린다 (저장 기록 · 알림 센터 = 디스크 규칙)', async () => {
    await app!.close()
    seedState(userData, [{ id: 'a', name: 'A 일감', paneId: 'pa', cwd: '/tmp' }], [], { maskScreen: false, muteViewed: false })
    await launch()
    await win.evaluate(`(() => {
      const sent = []
      window.__sent = sent
      window.Notification = class { constructor(title, opts = {}) { this.onclick = null; sent.push({ title, body: opts.body ?? '' }) } }
    })()`)
    const term = win.getByTestId('pane-pa')
    await expect.poll(async () => /%/.test(await term.locator('.xterm-rows').innerText()), { timeout: 15_000 }).toBe(true)
    await term.click()
    await win.keyboard.type(`echo ${KEY} >/dev/null; sleep 3; false`)
    await win.keyboard.press('Enter')
    const head = win.locator('[data-testid="pane-slot"][data-pane-id="pa"]').getByTestId('pane-head')
    await expect(head).toContainText(KEY) // 화면 가리기 끔 — 칸 머리는 원문
    await menu('history')
    const running = win.getByTestId('history-running')
    await expect(running).toContainText('‹가림:')
    await expect(running).not.toContainText(KEY)
    await win.keyboard.press('Escape')
    const sent = () => win.evaluate<Array<{ title: string; body: string }>>('window.__sent')
    await expect.poll(async () => (await sent()).length, { timeout: 15_000 }).toBe(1)
    const body = (await sent())[0]!.body
    expect(body).toContain('‹가림:')
    expect(body).not.toContain(KEY)
  })
})
