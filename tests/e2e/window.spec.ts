import { readFileSync } from 'node:fs'
import { firstWindow } from './helpers'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 실제 ~/Library/Application Support/Taskminal 을 건드리지 않게 시험마다 임시 userData 로만 띄운다.
let userData: string
let app: ElectronApplication
let launched: ElectronApplication | undefined // 이번 시험에서 실제로 뜬 앱 — afterEach 가 닫는다
let win: Page

test.beforeEach(async () => {
  userData = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-e2e-')))
  // 'out/main/index.js' 를 직접 주면 package.json 을 못 찾아 앱 이름 · 버전이 Electron 것이 된다 → 폴더로 띄운다.
  launched = undefined
  app = launched = await launch()
  win = await firstWindow(app)
})

const launch = () => electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: userData } })

test.afterEach(async () => {
  // launch 가 실패했으면 launched 가 비어 있어 앞 시험의 닫힌 app 을 다시 닫지 않는다.
  await launched?.close()
  rmSync(userData, { recursive: true, force: true })
})

test('창이 뜨고 preload → main 왕복으로 앱 정보를 받는다', async () => {
  await expect(win).toHaveTitle('Taskminal')
  const info = await win.evaluate(() =>
    (globalThis as unknown as { taskminal: { appInfo(): Promise<unknown> } }).taskminal.appInfo(),
  )
  expect(info).toMatchObject({ name: 'Taskminal', version: (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version })
  expect((info as { shells: string[] }).shells).toContain('/bin/zsh') // 설정에서 고를 수 있는 셸(/etc/shells)
})

test('보안 기본값: renderer 에 node 가 없고 preload API 는 좁다', async () => {
  const inPage = await win.evaluate(() => ({
    require: typeof (globalThis as Record<string, unknown>).require,
    process: typeof (globalThis as Record<string, unknown>).process,
    // contextBridge 는 contextIsolation 이 꺼져 있으면 노출에 실패하므로 키가 보이는 것 자체가 격리의 증거다.
    apiKeys: Object.keys((globalThis as unknown as { taskminal: object }).taskminal),
  }))
  expect(inPage).toEqual({ require: 'undefined', process: 'undefined', apiKeys: ['worktrees', 'schedules', 'workflows', 'conversations', 'accounts', 'workspace', 'gitWorkflow', 'appInfo', 'pickFolder', 'onCommand', 'setQuitGuard', 'setBadge', 'beep', 'gitWorktreeAdd', 'gitBranches', 'openLink', 'setMenuKeys', 'pty', 'sshHosts', 'scrollback', 'state', 'backup', 'redact', 'host', 'update', 'errlog', 'firstRunDone', 'history', 'chat', 'cli', 'review', 'ports'] }) // 18단계: 업데이트 · 오류 기록 · 첫 실행 끝 · 19단계: 명령 기록 · 20단계: 포트 · 21단계: 대화 · 23단계: 변경 검토 · 24단계: 명령줄(cli) · 25단계: ~/.ssh/config 호스트 목록(읽기만)

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
    // main 은 요청을 순서대로 처리한다 — 막혀야 할 file: 을 먼저 보내고, https 가 기록된 것을 보면 file: 도 처리가 끝난 것이다.
    w.open('file:///etc/passwd')
    w.open('https://example.com/a')
  })
  await expect.poll(() => app.evaluate(() => (globalThis as unknown as { opened: string[] }).opened)).toEqual([
    'https://example.com/a',
  ])
  // main 이 open 요청 두 개를 처리한 뒤(위 poll) 만들어진 창이 하나도 없어야 한다.
  expect(await app.evaluate(() => (globalThis as unknown as { created: number }).created)).toBe(0)
})

test('macOS: 창을 닫은 뒤 앱을 다시 실행하면 남아 있던 앱이 창을 연다', async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close())
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0)

  // 같은 userData 로 두 번째 실행 → 단일 인스턴스 잠금을 못 얻고 끝나며, 첫 앱에 second-instance 가 온다.
  // Playwright launch 는 곧바로 끝나는 프로세스를 실패로 보므로 그냥 자식 프로세스로 띄운다.
  const electronPath = (await import('electron')).default as unknown as string
  const code = await new Promise<number | null>((done) => {
    spawn(electronPath, ['.'], { env: { ...process.env, TASKMINAL_USER_DATA: userData }, stdio: 'ignore' }).on('exit', done)
  })
  expect(code).toBe(0)
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
})
