import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 임시 userData 로만 띄운다. 시험마다 저장 파일을 미리 깔고 시작한다.
let userData: string
let launched: ElectronApplication | undefined

test.beforeEach(() => {
  userData = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-e2e-')))
  launched = undefined
})
test.afterEach(async () => {
  await launched?.close()
  rmSync(userData, { recursive: true, force: true })
})

const statePath = () => join(userData, 'state.json')

async function launch(): Promise<{ app: ElectronApplication; win: Page }> {
  const app = (launched = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: userData } }))
  const win = await app.firstWindow()
  return { app, win }
}

async function quit(app: ElectronApplication): Promise<void> {
  await app.close()
  launched = undefined
}

type Api = { taskminal: { state: { load(): Promise<any>; save(s: unknown): void } } }

test('손상된 저장 파일로 시작해도 뜨고, 원본은 .bak 으로 남는다', async () => {
  writeFileSync(statePath(), '{nope')
  const { win } = await launch()
  await expect(win.getByTestId('state-notice')).toContainText('손상')
  await expect(win.locator('.xterm-rows')).toBeVisible() // 터미널도 뜬다
  await win.screenshot({ path: 'test-results/state-corrupt.png' })

  const baks = readdirSync(userData).filter((f) => /^state\.json\..+\.bak$/.test(f))
  expect(baks).toHaveLength(1)
  expect(readFileSync(join(userData, baks[0]!), 'utf8')).toBe('{nope')
  expect(() => JSON.parse(readFileSync(statePath(), 'utf8'))).not.toThrow()
})

test('더 새 버전 파일은 읽기 전용 — 저장을 불러도 앱 종료 뒤 바이트가 그대로', async () => {
  const original = JSON.stringify({ version: 2, tasks: [{ id: 'future', name: '새 앱의 일감', extra: { a: 1 } }], future: true })
  writeFileSync(statePath(), original)
  const { app, win } = await launch()
  await expect(win.getByTestId('state-notice')).toContainText('읽기 전용')
  await win.screenshot({ path: 'test-results/state-newer.png' })

  await win.evaluate(async () => {
    const api = (globalThis as unknown as Api).taskminal
    const loaded = await api.state.load()
    api.state.save(loaded.state)
  })
  await quit(app) // 종료 flush 까지 거친다
  expect(readFileSync(statePath(), 'utf8')).toBe(original)
})

test('저장한 상태는 앱을 껐다 켜도 남는다 (디바운스 안에 꺼도 종료 때 쓴다)', async () => {
  const first = await launch()
  await first.win.evaluate(async () => {
    const api = (globalThis as unknown as Api).taskminal
    const { state } = await api.state.load()
    state.tasks.push({
      id: 'task-1',
      name: '찍계부 서버',
      cwd: '~',
      statusId: state.settings.statuses[0].id,
      groupId: null,
      color: null,
      tabs: [{ id: 'tab-1', layout: { type: 'pane', paneId: 'p-1' }, activePaneId: 'p-1' }],
      activeTabId: 'tab-1',
      panes: { 'p-1': { id: 'p-1', cwd: '~' } },
      createdAt: 1,
    })
    state.activeTaskId = 'task-1'
    api.state.save(state)
  })
  await quit(first.app) // 300ms 디바운스를 기다리지 않고 바로 끈다

  const second = await launch()
  const loaded = await second.win.evaluate(() => (globalThis as unknown as Api).taskminal.state.load())
  expect(loaded.notice).toBeNull()
  expect(loaded.state.activeTaskId).toBe('task-1')
  expect(loaded.state.tasks.map((t: { name: string }) => t.name)).toEqual(['찍계부 서버'])
})

test('새로 고침해도 저장된 일감이 빈 상태로 덮이지 않는다', async () => {
  const { win } = await launch()
  await win.evaluate(async () => {
    const api = (globalThis as unknown as Api).taskminal
    const { state } = await api.state.load()
    state.settings.fontSize = 19
    api.state.save(state)
  })
  await win.reload() // 새 화면은 읽기가 끝나기 전에 빈 상태를 저장하려 한다
  await expect(win.locator('.xterm-rows')).toBeVisible()
  const loaded = await win.evaluate(() => (globalThis as unknown as Api).taskminal.state.load())
  expect(loaded.state.settings.fontSize).toBe(19)
})

test('아무것도 바꾸지 않으면 시작할 때 저장 파일을 다시 쓰지 않는다', async () => {
  // 앱이 쓰는 모양(들여쓰기 2칸)과 다른 한 줄 JSON — 다시 쓰면 바이트가 달라진다.
  const first = await launch()
  const compact = await first.win.evaluate(async () =>
    JSON.stringify((await (globalThis as unknown as Api).taskminal.state.load()).state),
  )
  await quit(first.app)
  writeFileSync(statePath(), compact)

  const { app, win } = await launch()
  await expect(win.locator('.xterm-rows')).toBeVisible()
  await win.waitForTimeout(700) // 디바운스(300ms)보다 길게
  await quit(app)
  expect(readFileSync(statePath(), 'utf8')).toBe(compact)
})
