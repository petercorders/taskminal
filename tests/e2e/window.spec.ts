import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 실제 ~/Library/Application Support/Taskminal 을 건드리지 않게 시험마다 임시 userData 로만 띄운다.
let userData: string
let app: ElectronApplication
let win: Page

test.beforeEach(async () => {
  userData = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-e2e-')))
  // 'out/main/index.js' 를 직접 주면 package.json 을 못 찾아 앱 이름 · 버전이 Electron 것이 된다 → 폴더로 띄운다.
  app = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: userData } })
  win = await app.firstWindow()
})

test.afterEach(async () => {
  await app?.close()
  rmSync(userData, { recursive: true, force: true })
})

test('창이 뜨고 preload → main 왕복으로 버전을 보여 준다', async () => {
  await expect(win).toHaveTitle('Taskminal')
  await expect(win.getByRole('heading', { name: 'Taskminal' })).toBeVisible()
  await expect(win.getByTestId('app-version')).toHaveText('0.1.0')
  await win.screenshot({ path: 'test-results/window.png' })
})

test('보안 기본값: renderer 에 node 가 없고 preload API 는 좁다', async () => {
  const inPage = await win.evaluate(() => ({
    require: typeof (globalThis as Record<string, unknown>).require,
    process: typeof (globalThis as Record<string, unknown>).process,
    // contextBridge 는 contextIsolation 이 꺼져 있으면 노출에 실패하므로 키가 보이는 것 자체가 격리의 증거다.
    apiKeys: Object.keys((globalThis as unknown as { taskminal: object }).taskminal),
  }))
  expect(inPage).toEqual({ require: 'undefined', process: 'undefined', apiKeys: ['appInfo'] })

  // 설정값이 아니라 실제로 돌고 있는 renderer 프로세스가 OS 샌드박스 안인지 본다.
  const sandboxed = await app.evaluate(({ app, BrowserWindow }) => {
    const pid = BrowserWindow.getAllWindows()[0]!.webContents.getOSProcessId()
    return app.getAppMetrics().find((m) => m.pid === pid)?.sandboxed
  })
  expect(sandboxed).toBe(true)
})

test('userData 는 TASKMINAL_USER_DATA 임시 폴더다', async () => {
  const path = await app.evaluate(({ app }) => app.getPath('userData'))
  expect(path).toBe(userData)
})

test('window.open 은 새 창을 만들지 않고 http(s) 만 바깥 브라우저로 넘긴다', async () => {
  // 실제 브라우저가 열리지 않게 shell.openExternal 을 가짜로 바꾼다.
  await app.evaluate(({ app, shell }) => {
    const g = globalThis as unknown as { opened: string[]; created: number }
    g.opened = []
    g.created = 0
    shell.openExternal = async (url: string) => {
      g.opened.push(url)
    }
    app.on('browser-window-created', () => {
      g.created++
    })
  })
  await win.evaluate(() => {
    const w = globalThis as unknown as { open: (url: string) => unknown }
    w.open('https://example.com/a')
    w.open('file:///etc/passwd')
  })
  await expect.poll(() => app.evaluate(() => (globalThis as unknown as { opened: string[] }).opened)).toEqual([
    'https://example.com/a',
  ])
  // main 이 open 요청 두 개를 처리한 뒤(위 poll) 만들어진 창이 하나도 없어야 한다.
  expect(await app.evaluate(() => (globalThis as unknown as { created: number }).created)).toBe(0)
})
