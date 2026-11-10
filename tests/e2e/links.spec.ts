import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstWindow, seedState } from './helpers'

// 15b: ⌘+클릭으로 링크 열기 — 실제 브라우저가 열리지 않게 main 의 shell.openExternal 을 가짜로 바꾼다.
let userData: string
let app: ElectronApplication
let win: Page

test.beforeEach(async () => {
  userData = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-e2e-')))
  seedState(userData, [{ id: 't', name: '링크', paneId: 'p1' }])
  app = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: userData } })
  win = await firstWindow(app)
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { opened: string[] }
    g.opened = []
    shell.openExternal = async (url: string) => {
      g.opened.push(url)
    }
  })
})
test.afterEach(async () => {
  await app.close()
  rmSync(userData, { recursive: true, force: true })
})

const opened = () => app.evaluate(() => (globalThis as unknown as { opened: string[] }).opened)
const screen = () => win.getByTestId('pane-p1').locator('.xterm-rows')

async function run(command: string): Promise<void> {
  await win.getByTestId('pane-p1').click()
  await win.keyboard.type(command)
  await win.keyboard.press('Enter')
}

test('글 속 https 주소: 그냥 클릭은 안 열고 ⌘+클릭은 바깥 브라우저로', async () => {
  await run('echo LINK https://example.com/x$((1+1))')
  const link = screen().getByText('https://example.com/x2').last()
  await expect(link).toBeVisible()
  await link.click()
  await win.waitForTimeout(300) // 열리지 않아야 하는 것을 보는 자리 — 기다릴 신호가 없다
  expect(await opened()).toEqual([])
  await link.click({ modifiers: ['Meta'] })
  await expect.poll(opened).toEqual(['https://example.com/x2'])
})

test('OSC 8 링크도 ⌘+클릭으로 연다 · file: 링크는 열지 않는다', async () => {
  await run(`printf '\\e]8;;https://example.com/osc8\\e\\\\OSCLINK\\e]8;;\\e\\\\ \\e]8;;file:///etc/passwd\\e\\\\FILELINK\\e]8;;\\e\\\\\\n'`)
  await expect(screen()).toContainText('OSCLINK')
  await screen().getByText('FILELINK').last().click({ modifiers: ['Meta'] })
  await screen().getByText('OSCLINK').last().click({ modifiers: ['Meta'] })
  await expect.poll(opened).toEqual(['https://example.com/osc8'])
})

test('main 은 renderer 가 보낸 http(s) 가 아닌 주소를 열지 않는다', async () => {
  await win.evaluate(() => {
    const t = (globalThis as unknown as { taskminal: { openLink(u: string): void } }).taskminal
    t.openLink('file:///etc/passwd')
    t.openLink('https://example.com/ok')
  })
  await expect.poll(opened).toEqual(['https://example.com/ok'])
})
