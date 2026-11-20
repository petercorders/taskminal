import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstWindow, seedState, waitLoaded } from './helpers'

// 58c 터미널 손동작: 파일 끌어 놓기 · OSC 52 복사 · 탭 순서 바꾸기 (docs/stages/58-remote-input-guide-gestures.md '돌려야 할 e2e').
let userData: string
let files: string
let launched: ElectronApplication | undefined
let app: ElectronApplication
let win: Page
let savedClipboard = ''

async function launch(): Promise<void> {
  app = launched = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: userData } })
  win = await firstWindow(app)
  await waitLoaded(win)
}

function seed(settings: Record<string, unknown> = {}): void {
  seedState(userData, [{ id: 'task-1', name: '손동작 시험', paneId: 'pane-1', cwd: '/tmp' }], [], settings)
}

test.beforeEach(async () => {
  userData = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-e2e-')))
  files = realpathSync(mkdtempSync('/tmp/tm-e2e-drop-')) // 짧은 경로 — 출력 줄이 접히지 않게
  launched = undefined
})
test.afterEach(async () => {
  // OSC 52 시험이 바꾼 실제 클립보드를 되돌린다
  if (launched) await launched.evaluate(({ clipboard }, t) => clipboard.writeText(t), savedClipboard).catch(() => {})
  await launched?.close()
  rmSync(userData, { recursive: true, force: true, maxRetries: 5 })
  rmSync(files, { recursive: true, force: true, maxRetries: 5 })
})

const pane = () => win.getByTestId('pane-pane-1')
const screenText = () => pane().locator('.xterm-rows').innerText()
async function waitText(re: RegExp): Promise<void> {
  await expect.poll(async () => re.test(await screenText()), { timeout: 15_000 }).toBe(true)
}
/** 셸 프롬프트가 뜬 뒤에 친다 — 프롬프트 전에 친 글자가 사라지는 무리를 피한다(development.md 함정) */
async function shellReady(): Promise<void> {
  await pane().click()
  await win.keyboard.type('echo READY_$((20+1))')
  await win.keyboard.press('Enter')
  await waitText(/^READY_21/m)
}
const clipboard = () => app.evaluate(({ clipboard }) => clipboard.readText())
const setClipboard = (t: string) => app.evaluate(({ clipboard }, v) => clipboard.writeText(v), t)

test('58c-1 Finder 파일을 터미널에 놓으면 셸 따옴표로 묶인 경로가 입력줄에만 들어간다(↩ 없음)', async () => {
  seed()
  await launch()
  await shellReady()
  const path = join(files, "내 파일's $HOME.txt")
  writeFileSync(path, 'x')

  await win.keyboard.type("printf 'ARG<%s>\\n' ")
  // 실제 디스크의 File(webUtils.getPathForFile 이 경로를 아는 것)을 얻으려고 숨은 file input 에 넣고, 그 File 로 drop 을 보낸다
  await win.evaluate(() => {
    const input = globalThis.document.createElement('input')
    input.type = 'file'
    input.id = 'e2e-drop-input'
    input.style.display = 'none'
    globalThis.document.body.appendChild(input)
  })
  await win.setInputFiles('#e2e-drop-input', path)
  const accepted = await win.evaluate(() => {
    const input = globalThis.document.getElementById('e2e-drop-input') as HTMLInputElement
    const dt = new DataTransfer()
    dt.items.add(input.files![0]!)
    const host = globalThis.document.querySelector('[data-testid="pane-pane-1"]')!
    const over = new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true })
    host.dispatchEvent(over)
    host.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    input.remove()
    return over.defaultPrevented
  })
  expect(accepted).toBe(true) // dragover 를 받아 놓을 수 있다고 알린다

  // 입력줄에 경로가 보이지만 실행되지는 않았다(ARG< 출력 없음)
  await waitText(new RegExp(`'\\\\''s \\$HOME\\.txt'`))
  await win.waitForTimeout(500)
  expect(await screenText()).not.toMatch(/^ARG</m)

  // ↩ 를 치면 셸이 한 낱말(따옴표 · $ · 공백 · 한글 그대로)로 읽는다
  await win.keyboard.press('Enter')
  await waitText(new RegExp(`^ARG<${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}>`, 'm'))
  await win.screenshot({ path: 'test-results/terminal-gestures-drop.png' })
})

const OSC52_TEXT = 'OSC52 copy 복사됨'
const osc52Command = () => `printf '\\033]52;c;${Buffer.from(OSC52_TEXT, 'utf8').toString('base64')}\\007'; echo DONE_$((40+2))`

test('58c-2 OSC 52 — 기본(켬)이면 셸 안 프로그램의 복사가 Mac 클립보드로 간다', async () => {
  seed() // osc52Copy 는 기본값(src/shared/settings.ts: true)
  await launch()
  savedClipboard = await clipboard()
  await setClipboard('E2E_SENTINEL_ON')
  await shellReady()
  await win.keyboard.type(osc52Command())
  await win.keyboard.press('Enter')
  await waitText(/^DONE_42/m)
  await expect.poll(clipboard, { timeout: 5_000 }).toBe(OSC52_TEXT)
})

test('58c-2 OSC 52 — 설정을 끄면 클립보드가 바뀌지 않는다', async () => {
  seed({ osc52Copy: false })
  await launch()
  savedClipboard = await clipboard()
  await setClipboard('E2E_SENTINEL_OFF')
  await shellReady()
  await win.keyboard.type(osc52Command())
  await win.keyboard.press('Enter')
  await waitText(/^DONE_42/m) // OSC 는 출력 차례대로 처리된다 — 뒤의 표식이 그려졌으면 처리기는 이미 돌았다
  await win.waitForTimeout(1_000) // 켠 경우의 writeText(비동기)가 닿을 여유
  expect(await clipboard()).toBe('E2E_SENTINEL_OFF')
})

test('58c-3 ⌘P 의 탭을 왼쪽으로 · 오른쪽으로가 순서만 바꾸고(활성 탭 그대로), 다시 띄워도 순서가 남는다', async () => {
  seed()
  await launch()
  const tabs = () => win.getByTestId('tab')
  const ids = () => tabs().evaluateAll((els) => els.map((e) => e.getAttribute('data-tab-id')))
  const selectedId = () => win.locator('[data-testid="tab"]:has([role="tab"][aria-selected="true"])').getAttribute('data-tab-id')
  await expect(tabs()).toHaveCount(1)
  for (const n of [2, 3]) {
    await win.getByRole('button', { name: '새 탭' }).click()
    await expect(tabs()).toHaveCount(n)
  }
  const [a, b, c] = (await ids()) as [string, string, string]
  expect(await selectedId()).toBe(c) // 새 탭이 활성

  const run = async (label: string) => {
    await win.keyboard.press('Meta+KeyP')
    const palette = win.getByTestId('palette')
    await expect(palette).toBeVisible()
    await win.keyboard.type(label)
    await expect(palette.locator('[aria-selected="true"]')).toContainText(label)
    await win.keyboard.press('Enter')
    await expect(palette).toHaveCount(0)
  }

  await run('탭을 왼쪽으로')
  await expect.poll(ids).toEqual([a, c, b])
  expect(await selectedId()).toBe(c)
  await run('탭을 왼쪽으로')
  await expect.poll(ids).toEqual([c, a, b])
  await run('탭을 왼쪽으로') // 맨 앞에서는 그대로
  await expect.poll(ids).toEqual([c, a, b])
  await run('탭을 오른쪽으로')
  await expect.poll(ids).toEqual([a, c, b])
  expect(await selectedId()).toBe(c)
  await win.screenshot({ path: 'test-results/terminal-gestures-tab-move.png' })

  await app.close()
  launched = undefined
  await launch()
  await expect(win.getByTestId('tab')).toHaveCount(3)
  await expect.poll(ids).toEqual([a, c, b])
})
