import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstWindow, seedState } from './helpers'

// 임시 userData 에 일감 하나(탭 하나, 폴더 /tmp)를 깔고 시작한다.
let userData: string
let launched: ElectronApplication | undefined
let app: ElectronApplication
let win: Page

async function launch(): Promise<void> {
  app = launched = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: userData } })
  win = await firstWindow(app)
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

const tabs = () => win.getByTestId('tab')
const tab = (i: number) => tabs().nth(i)
const selected = () => win.locator('[role="tab"][aria-selected="true"]')
const tabId = async (i: number) => (await tab(i).getAttribute('data-tab-id'))!
const panel = (id: string) => win.locator(`[data-testid="tab-view"][data-tab-id="${id}"]`)
const screenOf = (id: string) => panel(id).locator('.xterm-rows').innerText()

async function runIn(id: string, command: string) {
  await panel(id).locator('.terminal-pane').click()
  await win.keyboard.type(command)
  await win.keyboard.press('Enter')
}

async function waitText(id: string, re: RegExp): Promise<RegExpMatchArray> {
  let m: RegExpMatchArray | null = null
  await expect.poll(async () => (m = (await screenOf(id)).match(re)) !== null, { timeout: 15_000 }).toBe(true)
  return m!
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 탭 3개(첫 탭 + "+" 두 번)를 만들고 탭마다 셸 pid 를 읽는다. */
async function threeTabs(): Promise<{ ids: string[]; pids: number[] }> {
  await expect(tabs()).toHaveCount(1)
  for (const n of [2, 3]) {
    await win.getByRole('button', { name: '새 탭' }).click()
    await expect(tabs()).toHaveCount(n)
    // 새 탭은 끝에 붙고 활성
    await expect(tab(n - 1).getByRole('tab')).toHaveAttribute('aria-selected', 'true')
  }
  const ids = [await tabId(0), await tabId(1), await tabId(2)]
  const pids: number[] = []
  for (const [i, id] of ids.entries()) {
    await tab(i).getByRole('tab').click()
    await runIn(id, `echo PID${i}_ $$ MARK${i}_$((${i}+10))`)
    pids.push(Number((await waitText(id, new RegExp(`PID${i}_ (\\d+) MARK${i}_${i + 10}`)))[1]))
  }
  return { ids, pids }
}

test('탭 3개: 새 탭은 끝에 붙어 활성, 탭마다 다른 셸 · 오가도 자기 출력만', async () => {
  const { ids, pids } = await threeTabs()
  // 새 탭의 셸은 지금 pane 폴더(/tmp)에서 뜨고, 탭 이름은 그 폴더 끝 이름 — 세 탭이 같은 폴더라 27단계부터 뒤의 것은 번호(tmp 3)
  await expect(tab(2).getByRole('tab')).toHaveText('tmp 3')
  await runIn(ids[2]!, 'echo CWD_$(pwd)')
  await waitText(ids[2]!, /CWD_\/(private\/)?tmp/)
  expect(new Set(pids).size).toBe(3)
  for (let round = 0; round < 2; round++) {
    for (const [i, id] of ids.entries()) {
      await tab(i).getByRole('tab').click()
      await expect(panel(id)).toBeVisible()
      for (const other of ids.filter((x) => x !== id)) await expect(panel(other)).toBeHidden()
    }
  }
  for (const [i, id] of ids.entries()) {
    const text = await screenOf(id)
    expect(text).toMatch(new RegExp(`MARK${i}_${i + 10}`))
    for (const j of [0, 1, 2].filter((x) => x !== i)) expect(text).not.toMatch(new RegExp(`MARK${j}_${j + 10}`))
  }
  await tab(1).getByRole('tab').click()
  await win.screenshot({ path: 'test-results/tabs.png' })
})

test('가운데 활성 탭을 닫으면 오른쪽이 활성 · 그 셸만 끝난다, 비활성을 닫으면 활성 그대로, 끝을 닫으면 왼쪽', async () => {
  const { ids, pids } = await threeTabs()
  await tab(1).getByRole('tab').click()
  await tab(1).locator('.tab-close').click()
  await expect(tabs()).toHaveCount(2)
  await expect(selected()).toHaveCount(1)
  expect(await selected().locator('xpath=..').getAttribute('data-tab-id')).toBe(ids[2])
  await expect(panel(ids[2]!)).toBeVisible()
  await expect.poll(() => alive(pids[1]!), { timeout: 10_000 }).toBe(false)
  expect(alive(pids[0]!)).toBe(true)
  expect(alive(pids[2]!)).toBe(true)

  // 활성(셋째)이 아닌 첫째를 닫는다 → 활성 그대로
  await tab(0).locator('.tab-close').click()
  await expect(tabs()).toHaveCount(1)
  expect(await tabId(0)).toBe(ids[2])
  await expect(panel(ids[2]!)).toBeVisible()
  await expect.poll(() => alive(pids[0]!), { timeout: 10_000 }).toBe(false)

  // 끝(활성)을 닫으면 왼쪽 — 새 탭을 하나 더 열고 그 탭을 닫는다
  await win.getByRole('button', { name: '새 탭' }).click()
  await expect(tabs()).toHaveCount(2)
  await tab(1).locator('.tab-close').click()
  await expect(tabs()).toHaveCount(1)
  await expect(tab(0).getByRole('tab')).toHaveAttribute('aria-selected', 'true')
  // 닫은 뒤 포커스가 남은 탭의 터미널로 — 바로 칠 수 있다
  await win.keyboard.type('echo AFTER_$((3*3))')
  await win.keyboard.press('Enter')
  await waitText(ids[2]!, /AFTER_9/)
})

test('이름 바꾸기: 더블클릭 → Enter 확정 · Esc 취소 · 빈 이름은 기본 이름, 껐다 켜도 유지', async () => {
  await win.getByRole('button', { name: '새 탭' }).click()
  await expect(tabs()).toHaveCount(2)

  await tab(0).getByRole('tab').dblclick()
  const input = win.getByRole('textbox', { name: '탭 이름' })
  await expect(input).toBeFocused()
  await input.fill('서버 로그')
  await win.keyboard.press('Enter')
  await expect(tab(0).getByRole('tab')).toHaveText('서버 로그')

  // Esc 는 취소
  await tab(0).getByRole('tab').dblclick()
  await win.getByRole('textbox', { name: '탭 이름' }).fill('버릴 이름')
  await win.keyboard.press('Escape')
  await expect(tab(0).getByRole('tab')).toHaveText('서버 로그')

  // 빈 이름 → 기본 이름(폴더 끝 이름)
  await tab(1).getByRole('tab').dblclick()
  await win.getByRole('textbox', { name: '탭 이름' }).fill('임시')
  await win.keyboard.press('Enter')
  await tab(1).getByRole('tab').dblclick()
  await win.getByRole('textbox', { name: '탭 이름' }).fill('   ')
  await win.keyboard.press('Enter')
  await expect(tab(1).getByRole('tab')).toHaveText('tmp')

  // 활성은 둘째 탭 — 껐다 켜도 탭 수 · 이름 · 활성 탭이 그대로
  await tab(1).getByRole('tab').click()
  const ids = [await tabId(0), await tabId(1)]
  await app.close()
  launched = undefined
  await launch()
  await expect(tabs()).toHaveCount(2)
  await expect(tab(0).getByRole('tab')).toHaveText('서버 로그')
  expect([await tabId(0), await tabId(1)]).toEqual(ids)
  await expect(tab(1).getByRole('tab')).toHaveAttribute('aria-selected', 'true')
  // 셸은 처음 볼 때 뜬다: 활성 탭만 터미널, 첫 탭은 아직 없음
  await expect(panel(ids[1]!).locator('.terminal-pane')).toHaveCount(1)
  await expect(panel(ids[0]!).locator('.terminal-pane')).toHaveCount(0)
  await tab(0).getByRole('tab').click()
  await expect(panel(ids[0]!).locator('.terminal-pane')).toHaveCount(1)
  await runIn(ids[0]!, 'echo LAZY_$((4*4))')
  await waitText(ids[0]!, /LAZY_16/)
})

test('키보드: F2 로 이름 바꾸기 → 확정하면 터미널로, Tab 으로 닫기 버튼에 닿는다', async () => {
  const id = await tabId(0)
  await tab(0).getByRole('tab').focus()
  await win.keyboard.press('F2')
  await expect(win.getByRole('textbox', { name: '탭 이름' })).toBeFocused()
  await win.keyboard.type('키보드')
  await win.keyboard.press('Enter')
  await expect(tab(0).getByRole('tab')).toHaveText('키보드')
  // 확정 뒤 포커스가 터미널로 돌아와 바로 칠 수 있다
  await win.keyboard.type('echo KEY_$((6+6))')
  await win.keyboard.press('Enter')
  await waitText(id, /KEY_12/)

  await win.getByRole('button', { name: '새 탭' }).click()
  await tab(0).getByRole('tab').focus()
  await win.keyboard.press('Tab')
  const close = win.getByRole('button', { name: '키보드 탭 닫기' })
  await expect(close).toBeFocused()
  await expect(close).toHaveCSS('opacity', '1')
})

test('탭이 넘쳐도 새 탭 · 고른 탭이 보이는 곳으로 온다', async () => {
  for (let n = 2; n <= 16; n++) {
    await win.getByRole('button', { name: '새 탭' }).click()
    await expect(tabs()).toHaveCount(n)
  }
  await expect(tab(15)).toBeInViewport({ ratio: 1 })
  await expect(tab(0)).not.toBeInViewport({ ratio: 1 })
  // 왼쪽 끝 탭으로 가면(← 로 포커스를 옮기고 Enter) 그 탭이 다시 보인다
  await tab(15).getByRole('tab').focus()
  await win.keyboard.press('ArrowRight') // 끝에서 → 는 처음으로 돈다
  await expect(tab(0).getByRole('tab')).toBeFocused()
  await win.keyboard.press('Enter')
  await expect(tab(0).getByRole('tab')).toHaveAttribute('aria-selected', 'true')
  await expect(tab(0)).toBeInViewport({ ratio: 1 })
  await win.screenshot({ path: 'test-results/tabs-overflow.png' })
})

test('← → 는 탭 사이 포커스만 옮기고, 탭과 내용이 aria 로 이어져 있다', async () => {
  await win.getByRole('button', { name: '새 탭' }).click()
  await expect(tabs()).toHaveCount(2)
  await tab(1).getByRole('tab').focus()
  await win.keyboard.press('ArrowLeft')
  await expect(tab(0).getByRole('tab')).toBeFocused()
  await expect(tab(1).getByRole('tab')).toHaveAttribute('aria-selected', 'true') // 아직 고르지 않음
  await win.keyboard.press('Space')
  await expect(tab(0).getByRole('tab')).toHaveAttribute('aria-selected', 'true')

  const id = await tabId(0)
  await expect(win.getByRole('tabpanel', { name: (await tab(0).getByRole('tab').innerText()).trim() })).toHaveAttribute(
    'data-tab-id',
    id,
  )
  await expect(tab(0).getByRole('tab')).toHaveAttribute('aria-controls', `tabpanel-${id}`)
})

test('마지막 탭을 닫아도 일감은 남고, 새 탭 버튼으로 셸이 다시 뜬다', async () => {
  const id = await tabId(0)
  await runIn(id, 'echo PIDL $$')
  const pid = Number((await waitText(id, /PIDL (\d+)/))[1])
  await tab(0).locator('.tab-close').click()
  await expect(tabs()).toHaveCount(0)
  await expect.poll(() => alive(pid), { timeout: 10_000 }).toBe(false)
  await expect(win.getByTestId('task-row')).toHaveCount(1)
  const empty = win.getByTestId('no-tabs')
  await expect(empty).toContainText('탭이 없습니다')
  await expect(empty.getByRole('button', { name: '새 탭' })).toBeFocused()
  await win.keyboard.press('Enter')
  await expect(tabs()).toHaveCount(1)
  const next = await tabId(0)
  await runIn(next, 'echo AGAIN_$((7+7))')
  await waitText(next, /AGAIN_14/)
})
