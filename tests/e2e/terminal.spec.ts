import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 임시 userData 로만 띄운다. 셸은 사용자의 실제 HOME · .zshrc 로 뜬다(로그인 셸).
let userData: string
let app: ElectronApplication
let launched: ElectronApplication | undefined
let win: Page

test.beforeEach(async () => {
  userData = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-e2e-')))
  launched = undefined
  app = launched = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: userData } })
  win = await app.firstWindow()
})

test.afterEach(async () => {
  await launched?.close()
  rmSync(userData, { recursive: true, force: true })
})

const pane = () => win.getByTestId('pane-pane-1')
const screenText = () => win.locator('.xterm-rows').innerText()

async function run(command: string): Promise<void> {
  await pane().click()
  await win.keyboard.type(command)
  await win.keyboard.press('Enter')
}

/** 출력에서 정규식이 처음 맞는 줄을 기다려 그 결과를 돌려준다 (명령 줄 자체는 숫자가 아니라 안 맞게 쓴다). */
async function waitFor(re: RegExp): Promise<RegExpMatchArray> {
  let m: RegExpMatchArray | null = null
  await expect.poll(async () => (m = (await screenText()).match(re)) !== null, { timeout: 15_000 }).toBe(true)
  return m!
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 셸 pid 와 백그라운드 자식 pid 를 읽는다. */
async function shellPids(tag: string): Promise<[number, number]> {
  await run(`sleep 300 & echo ${tag} $$ $!`)
  const m = await waitFor(new RegExp(`${tag} (\\d+) (\\d+)`))
  const pids: [number, number] = [Number(m[1]), Number(m[2])]
  expect(pids.every(alive)).toBe(true)
  return pids
}

async function expectGone(pids: number[]): Promise<void> {
  await expect.poll(() => pids.filter(alive), { timeout: 10_000 }).toEqual([])
}

test('셸에 친 한글이 그대로 나온다', async () => {
  await run('echo 안녕 터미널')
  await expect(win.locator('.xterm-rows')).toContainText('안녕 터미널')
  await expect.poll(async () => (await screenText()).split('안녕 터미널').length - 1).toBeGreaterThanOrEqual(2) // 입력 줄 + 출력 줄
  await win.screenshot({ path: 'test-results/terminal.png' })
})

test('stty size 가 화면의 터미널 크기와 같고, 창을 줄이면 따라 바뀐다', async () => {
  const sizeOf = async () => [await pane().getAttribute('data-rows'), await pane().getAttribute('data-cols')].join(' ')

  await run('echo SIZE1 $(stty size)')
  const first = await waitFor(/SIZE1 (\d+ \d+)/)
  expect(first[1]).toBe(await sizeOf())

  const before = await sizeOf()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(800, 500))
  await expect.poll(sizeOf).not.toBe(before)
  await run('echo SIZE2 $(stty size)')
  const second = await waitFor(/SIZE2 (\d+ \d+)/)
  expect(second[1]).toBe(await sizeOf())
})

test('종료 경로 ① 앱 종료: 셸과 그 자식이 남지 않는다', async () => {
  const pids = await shellPids('PIDA')
  await app.close()
  launched = undefined
  await expectGone(pids)
})

test('종료 경로 ② 창 닫기: macOS 는 앱이 남아도 셸은 끝난다', async () => {
  const pids = await shellPids('PIDB')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close())
  await expectGone(pids)
  expect(await app.evaluate(({ app }) => app.isReady())).toBe(true) // 앱은 그대로
})

test('종료 경로 ③ 새로 고침: 옛 셸은 끝나고 새 셸이 뜬다', async () => {
  const old = await shellPids('PIDC')
  await win.reload()
  await expectGone(old)
  const fresh = await shellPids('PIDD')
  expect(fresh[0]).not.toBe(old[0])
})

test('종료 경로 ④ 렌더러 충돌: 셸이 남지 않는다', async () => {
  const pids = await shellPids('PIDE')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.forcefullyCrashRenderer())
  await expectGone(pids)
})
