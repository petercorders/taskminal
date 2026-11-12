import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { firstWindow, seedState, waitLoaded } from './helpers'

let data: string
let app: ElectronApplication | undefined
let win: Page
async function command(c: string) {
  await app!.evaluate(({ BrowserWindow }, cmd) => BrowserWindow.getAllWindows()[0]!.webContents.send('app:command', cmd), c)
}
// Playwright의 CSS viewport 캡처는 페이지 배율 2에서 네이티브 창 일부만 잘라 낼 수 있다.
async function nativeScreenshot(name: string) {
  const png = await app!.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG().toString('base64'))
  mkdirSync('test-results/ux-loop', { recursive: true })
  writeFileSync(`test-results/ux-loop/${name}.png`, Buffer.from(png, 'base64'))
}
test.beforeEach(async () => {
  data = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-e2e-')))
  seedState(data, [{ id: 'task', name: '결제 흐름 사용성 점검', paneId: 'pane', cwd: data }])
  app = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: data, TASKMINAL_CLAUDE_BIN: resolve('tests/fixtures/fake-claude.mjs') } })
  win = await firstWindow(app)
  await waitLoaded(win)
})
test.afterEach(async () => {
  await app?.close()
  app = undefined
  rmSync(data, { recursive: true, force: true, maxRetries: 5 })
})

test('640px에서 메모·명령 기록을 열어도 본문과 닫기 조작이 화면 안에 남는다', async () => {
  await win.setViewportSize({ width: 640, height: 400 })
  for (const [c, id] of [['notes', 'notes-panel'], ['history', 'history-panel']]) {
    await command(c!)
    const panel = win.getByTestId(id!)
    await expect(panel).toBeVisible()
    const width = await panel.evaluate((e) => e.getBoundingClientRect().width)
    expect(width).toBeLessThanOrEqual(640 / 2)
    const bounds = (await panel.boundingBox())!
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(640)
    const view = win.locator('[data-testid="task-view"][aria-hidden="false"] .split-view')
    expect((await view.boundingBox())!.width).toBeGreaterThanOrEqual(180)
    expect((await view.boundingBox())!.height).toBeGreaterThanOrEqual(180)
    await win.screenshot({ path: `test-results/ux-loop/${c}-640.png` })
    await panel.getByRole('button', { name: /닫기/ }).first().click()
  }
})

test('메모 입력은 접근 가능한 이름이 있고 IME 조합 Enter는 저장하지 않는다', async () => {
  await command('notes')
  const notes = win.getByTestId('notes-panel')
  const input = notes.getByRole('textbox', { name: '할 일 · 메모' })
  await expect(input).toBeVisible()
  await input.fill('한글 조합 중')
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true })
  await expect(notes.getByTestId('note')).toHaveCount(0)
  await expect(input).toHaveValue('한글 조합 중')
  await input.press('Enter')
  await expect(notes.getByTestId('note')).toContainText('한글 조합 중')
})

test('주간 정리 복사 실패는 오류와 재시도를 제공한다', async () => {
  await win.evaluate(() => {
    let calls = 0
    Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: () => ++calls === 1 ? Promise.reject(new Error('clipboard unavailable')) : Promise.resolve() })
  })
  await command('weekly')
  const weekly = win.getByTestId('weekly-panel')
  await weekly.getByTestId('weekly-copy').click()
  await expect(weekly.getByRole('alert')).toContainText('복사하지 못했어요')
  await win.screenshot({ path: 'test-results/ux-loop/weekly-copy-error.png' })
  await weekly.getByTestId('weekly-copy').click()
  await expect(win.getByTestId('toast')).toContainText('복사')
  await expect(weekly.getByRole('alert')).toHaveCount(0)
})

test('첫 실행 명령 복사 실패 뒤에도 같은 명령을 다시 복사할 수 있다', async () => {
  await win.evaluate(() => {
    let calls = 0
    Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: () => ++calls === 1 ? Promise.reject(new Error('clipboard unavailable')) : Promise.resolve() })
  })
  await command('first-run')
  const first = win.getByTestId('first-run')
  await first.getByRole('button', { name: '다음' }).click()
  await first.getByRole('button', { name: /명령 복사/ }).click()
  await expect(first.getByRole('alert')).toContainText('복사하지 못했어요')
  await win.screenshot({ path: 'test-results/ux-loop/onboarding-copy-error.png' })
  await first.getByRole('button', { name: /명령 복사/ }).click()
  await expect(first.getByRole('button', { name: '복사함' })).toBeVisible()
  await expect(first.getByRole('alert')).toHaveCount(0)
})

test('200% 확대에서 설정·새 일감·출력 찾기의 주요 액션은 스크롤로 도달한다', async () => {
  await app!.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]!
    w.setContentSize(1280, 800)
    w.webContents.setZoomFactor(2)
  })
  await command('settings')
  const settings = win.getByTestId('settings')
  await expect(settings).toBeVisible()
  await settings.getByRole('navigation').getByRole('button', { name: '일감 관리', exact: true }).click()
  await expect.poll(() => settings.getByTestId('settings-body').evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true)
  await nativeScreenshot('settings-200')
  await win.keyboard.press('Escape')
  for (const c of ['new-task', 'global-find']) {
    await command(c)
    const dialog = win.getByRole('dialog').last()
    await expect(dialog).toBeVisible()
    const button = dialog.getByRole('button').last()
    await button.scrollIntoViewIfNeeded()
    await expect(button).toBeInViewport({ ratio: 1 })
    await nativeScreenshot(`${c}-200`)
    await win.keyboard.press('Escape')
  }
})

test('복사 대기 중 중복 입력은 한 번만 실행하고 주·안내 페이지 변경 뒤 옛 실패는 버린다', async () => {
  await win.evaluate(() => {
    let calls = 0
    const rejects: Array<(reason: Error) => void> = []
    Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: () => {
      calls++
      return new Promise<void>((_done, reject) => rejects.push(reject))
    } })
    Object.assign(globalThis, { copyCalls: () => calls, rejectCopy: () => rejects.shift()?.(new Error('late clipboard failure')) })
  })
  await command('weekly')
  const weekly = win.getByTestId('weekly-panel')
  await weekly.getByTestId('weekly-copy').click()
  await expect(weekly.getByTestId('weekly-copy')).toBeDisabled()
  await win.keyboard.press('Meta+Shift+c')
  expect(await win.evaluate('copyCalls()')).toBe(1)
  await weekly.getByRole('button', { name: '앞 주' }).click()
  await win.evaluate('rejectCopy()')
  await win.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
  await expect(weekly.getByRole('alert')).toHaveCount(0)
  await expect(win.getByTestId('toast')).toHaveCount(0)
  await win.keyboard.press('Escape')

  await command('first-run')
  const first = win.getByTestId('first-run')
  await first.getByRole('button', { name: '다음' }).click()
  const copy = first.getByRole('button', { name: /명령 복사/ })
  await copy.click()
  await expect(first.getByRole('button', { name: '복사 중…' })).toBeDisabled()
  await win.keyboard.press('Meta+c')
  expect(await win.evaluate('copyCalls()')).toBe(2)
  await first.getByRole('button', { name: '다음' }).click()
  await win.evaluate('rejectCopy()')
  await win.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
  await expect(first).toHaveAttribute('data-page', '3')
  await expect(first.getByRole('alert')).toHaveCount(0)
})
