import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedState } from './helpers'

// 임시 userData 에 일감 하나(탭 하나 · pane 하나, 폴더 /tmp)를 깔고 시작한다.
let userData: string
let launched: ElectronApplication | undefined
let app: ElectronApplication
let win: Page

async function launch(): Promise<void> {
  app = launched = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: userData } })
  win = await app.firstWindow()
}

test.beforeEach(async () => {
  userData = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-e2e-')))
  seedState(userData, [{ id: 'task-a', name: 'A 일감', paneId: 'pane-a', cwd: '/tmp' }])
  launched = undefined
  await launch()
})
test.afterEach(async () => {
  await launched?.close()
  rmSync(userData, { recursive: true, force: true })
})

const slots = () => win.getByTestId('pane-slot')
const slot = (id: string) => win.locator(`[data-testid="pane-slot"][data-pane-id="${id}"]`)
const term = (id: string) => win.getByTestId(`pane-${id}`)
const screenOf = (id: string) => term(id).locator('.xterm-rows').innerText()
const slotIds = async () => slots().evaluateAll((els) => els.map((e) => e.getAttribute('data-pane-id')!))
const split = (dir: '오른쪽으로 나누기' | '아래로 나누기') => win.getByRole('button', { name: dir }).click()

async function runIn(id: string, command: string) {
  await term(id).click()
  await win.keyboard.type(command)
  await win.keyboard.press('Enter')
}

async function waitText(id: string, re: RegExp): Promise<RegExpMatchArray> {
  let m: RegExpMatchArray | null = null
  await expect.poll(async () => (m = (await screenOf(id)).match(re)) !== null, { timeout: 15_000 }).toBe(true)
  return m!
}

let probe = 0
/** 그 pane 의 셸이 보는 크기(stty size)가 xterm 크기(data-rows · data-cols)와 같아질 때까지 — 크기 맞춤은 다음 프레임에 일어난다. */
async function expectShellSizeMatches(id: string) {
  await expect
    .poll(
      async () => {
        const n = ++probe
        await runIn(id, `echo SZ${n}_$(stty size | tr ' ' x)`)
        const [, rows, cols] = await waitText(id, new RegExp(`SZ${n}_(\\d+)x(\\d+)`))
        const el = term(id)
        return `${rows}x${cols}` === `${await el.getAttribute('data-rows')}x${await el.getAttribute('data-cols')}`
      },
      { timeout: 20_000, intervals: [300, 600, 1000] },
    )
    .toBe(true)
}

const cols = async (id: string) => Number(await term(id).getAttribute('data-cols'))

test('오른쪽 · 아래로 나누면 pane 3개, 각 셸 크기가 그 pane 크기와 같고 원래 pane 의 출력이 남는다', async () => {
  await runIn('pane-a', 'echo BEFORE_$((20+1))')
  await waitText('pane-a', /BEFORE_21/)
  const fullCols = await cols('pane-a')

  await split('오른쪽으로 나누기')
  await expect(slots()).toHaveCount(2)
  await split('아래로 나누기') // 활성 pane(새 오른쪽 pane)을 위아래로
  await expect(slots()).toHaveCount(3)
  const [left, top, bottom] = (await slotIds()) as [string, string, string]
  expect(left).toBe('pane-a')
  await expect(slot(bottom)).toHaveAttribute('data-focused', 'true') // 새 pane 이 활성

  // 원래 pane 은 다시 마운트되지 않았다 — 분할 전 출력이 그대로
  expect(await screenOf(left)).toMatch(/BEFORE_21/)
  await expect.poll(() => cols(left)).toBeLessThan(fullCols * 0.6)

  for (const id of [left, top, bottom]) await expectShellSizeMatches(id)
  // 새 pane 은 활성 pane 폴더(/tmp)에서 뜬다
  await runIn(bottom, 'echo CWD_$(pwd)')
  await waitText(bottom, /CWD_\/(private\/)?tmp/)
  await win.screenshot({ path: 'test-results/split.png' })
})

test('분할선을 끌면 비율이 바뀌고 셸 크기도 따라간다, 껐다 켜도 모양 · 비율 · 활성 pane 이 그대로', async () => {
  await split('오른쪽으로 나누기')
  const [left, right] = (await slotIds()) as [string, string]
  await expectShellSizeMatches(left)
  const before = await cols(left)

  const divider = win.getByTestId('divider')
  await expect(divider).toHaveAttribute('aria-valuenow', '50')
  const box = (await divider.boundingBox())!
  await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await win.mouse.down()
  await win.mouse.move(box.x - 250, box.y + box.height / 2, { steps: 5 })
  await win.mouse.up()
  const after = Number(await divider.getAttribute('aria-valuenow'))
  expect(after).toBeLessThan(40)
  await expect.poll(() => cols(left)).toBeLessThan(before)
  await expectShellSizeMatches(left)
  await expectShellSizeMatches(right)

  await term(left).click() // 활성 pane = 왼쪽
  await expect(slot(left)).toHaveAttribute('data-focused', 'true')
  await app.close()
  launched = undefined
  await launch()
  await expect(slots()).toHaveCount(2)
  expect(await slotIds()).toEqual([left, right])
  await expect(win.getByTestId('divider')).toHaveAttribute('aria-valuenow', String(after))
  await expect(slot(left)).toHaveAttribute('data-focused', 'true')
  await expectShellSizeMatches(right)
})

test('다른 pane 을 누르면 거기가 활성 — 글자가 그 pane 으로 간다', async () => {
  await split('오른쪽으로 나누기')
  const [left, right] = (await slotIds()) as [string, string]
  await expect(slot(right)).toHaveAttribute('data-focused', 'true')
  await term(left).click()
  await expect(slot(left)).toHaveAttribute('data-focused', 'true')
  await expect(slot(right)).toHaveAttribute('data-focused', 'false')
  await win.keyboard.type('echo LEFT_$((1+6))')
  await win.keyboard.press('Enter')
  await waitText(left, /LEFT_7/)
  expect(await screenOf(right)).not.toMatch(/LEFT_7/)
})

test('셸 exit: 그 pane 만 닫히고 형제가 자리를 채운다, 마지막 pane 이면 탭이 닫힌다', async () => {
  await split('오른쪽으로 나누기')
  const [left, right] = (await slotIds()) as [string, string]
  await expectShellSizeMatches(left)
  const half = await cols(left)
  await runIn(right, 'exit')
  await expect(slots()).toHaveCount(1)
  await expect(slot(left)).toBeVisible()
  await expect(slot(left)).toHaveAttribute('data-focused', 'true')
  await expect.poll(() => cols(left)).toBeGreaterThan(half * 1.5)
  await expectShellSizeMatches(left)
  // 남은 pane 으로 바로 칠 수 있다
  await win.keyboard.type('echo ALIVE_$((2+2))')
  await win.keyboard.press('Enter')
  await waitText(left, /ALIVE_4/)

  await runIn(left, 'exit')
  await expect(win.getByTestId('tab')).toHaveCount(0)
  await expect(win.getByTestId('no-tabs')).toBeVisible()
})

test('새로 고침해도 분할 pane 이 그대로 — 끝낸 옛 셸이 pane 을 닫지 않는다', async () => {
  await split('아래로 나누기')
  const ids = await slotIds()
  expect(ids).toHaveLength(2)
  await win.waitForTimeout(500) // 4단계: 상태 저장 디바운스(300ms)
  await win.reload()
  await expect(slots()).toHaveCount(2)
  await win.waitForTimeout(1500) // 옛 셸이 끝나는 시간 (SIGHUP)
  await expect(slots()).toHaveCount(2)
  expect(await slotIds()).toEqual(ids)
  for (const id of ids) {
    await runIn(id, `echo RELOADED_${id.length}`)
    await waitText(id, new RegExp(`RELOADED_${id.length}`))
  }
})

test('분할선은 키보드로도 — Tab 으로 닿고 ← → 로 5%씩', async () => {
  await split('오른쪽으로 나누기')
  const divider = win.getByTestId('divider')
  await divider.focus()
  await expect(divider).toBeFocused()
  await win.keyboard.press('ArrowRight')
  await expect(divider).toHaveAttribute('aria-valuenow', '55')
  await win.keyboard.press('ArrowLeft')
  await win.keyboard.press('ArrowLeft')
  await expect(divider).toHaveAttribute('aria-valuenow', '45')
  await win.keyboard.press('ArrowUp') // 좌우 선에는 위아래 키가 없다
  await expect(divider).toHaveAttribute('aria-valuenow', '45')
})
