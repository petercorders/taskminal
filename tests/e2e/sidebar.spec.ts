import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstWindow, seedState } from './helpers'

// 임시 userData 로만 띄운다. 묶음 만들기 화면(11단계) 전이라 묶음은 저장 파일에 미리 깐다.
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
  seedState(userData, [], [{ id: 'g1', name: '서버' }])
  launched = undefined
  await launch()
})
test.afterEach(async () => {
  await launched?.close()
  rmSync(userData, { recursive: true, force: true })
})

const row = (name: string) => win.locator(`[data-testid="task-row"][data-task-name="${name}"]`)
const view = (name: string) => win.locator(`[data-testid="task-view"][data-task-name="${name}"]`)
// 일감을 고르는 버튼 (같은 줄의 '지우기' 버튼과 구별)
const selectButton = (name: string) => row(name).locator('.task-main')
const screenOf = (name: string) => view(name).locator('.xterm-rows').innerText()

async function createTask(name: string, opts: { cwd?: string; group?: string; colorIndex?: number } = {}) {
  await win.getByRole('button', { name: '새 일감' }).first().click()
  const dialog = win.getByRole('dialog', { name: '새 일감' })
  await dialog.getByLabel('이름').fill(name)
  if (opts.cwd) await dialog.getByLabel('작업 폴더').fill(opts.cwd)
  if (opts.group) await dialog.getByLabel('묶음').selectOption({ label: opts.group })
  if (opts.colorIndex !== undefined) await dialog.locator('.swatch').nth(opts.colorIndex).click()
  await dialog.getByRole('button', { name: /만들기/ }).click()
  await expect(dialog).toBeHidden()
  await expect(view(name)).toBeVisible()
}

async function runIn(name: string, command: string) {
  await view(name).locator('.terminal-pane').click()
  await win.keyboard.type(command)
  await win.keyboard.press('Enter')
}

async function waitText(name: string, re: RegExp): Promise<RegExpMatchArray> {
  let m: RegExpMatchArray | null = null
  await expect.poll(async () => (m = (await screenOf(name)).match(re)) !== null, { timeout: 15_000 }).toBe(true)
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

test('일감 두 개를 오가도 각 터미널의 출력과 폴더가 남는다', async () => {
  await createTask('A 일감', { cwd: '/tmp' })
  await runIn('A 일감', 'echo MARK_A_$((1+1)); echo PWD_A $(pwd)')
  await waitText('A 일감', /MARK_A_2/)
  await createTask('B 일감', { cwd: userData, group: '서버', colorIndex: 3 })
  await runIn('B 일감', 'echo MARK_B_$((1+2)); echo PWD_B $(pwd)')
  await waitText('B 일감', /MARK_B_3/)

  for (let i = 0; i < 2; i++) {
    await selectButton('A 일감').click()
    await expect(view('A 일감')).toBeVisible()
    await expect(view('B 일감')).toBeHidden()
    await selectButton('B 일감').click()
    await expect(view('B 일감')).toBeVisible()
    await expect(view('A 일감')).toBeHidden()
  }
  const a = await screenOf('A 일감')
  const b = await screenOf('B 일감')
  expect(a).toMatch(/MARK_A_2/)
  expect(a).not.toMatch(/MARK_B_3/)
  expect(a).toMatch(/PWD_A \/(private\/)?tmp/)
  expect(b).toMatch(/MARK_B_3/)
  expect(b).not.toMatch(/MARK_A_2/)
  expect(b).toContain(`PWD_B ${userData}`)

  // 묶음 칸과 둘째 줄(폴더 · 상태)
  await expect(win.getByTestId('sidebar').getByRole('heading', { name: '서버' })).toBeVisible()
  await expect(row('A 일감')).toContainText('/tmp · 진행 중')
  await win.screenshot({ path: 'test-results/sidebar.png' })
})

test('지우기: 확인에서 취소하면 그대로, 지우면 그 일감의 셸만 끝난다', async () => {
  await createTask('A 일감')
  await runIn('A 일감', 'echo PIDA $$')
  const pidA = Number((await waitText('A 일감', /PIDA (\d+)/))[1])
  await createTask('B 일감')
  await runIn('B 일감', 'sleep 300 & echo PIDB $$ $!')
  const m = await waitText('B 일감', /PIDB (\d+) (\d+)/)
  const pidsB = [Number(m[1]), Number(m[2])]

  await row('B 일감').hover()
  await win.getByRole('button', { name: 'B 일감 지우기' }).click()
  const confirm = win.getByRole('alertdialog', { name: '일감 지우기' })
  await expect(confirm).toContainText('터미널 1개가 함께 종료됩니다')
  await confirm.getByRole('button', { name: '취소' }).click()
  await expect(confirm).toBeHidden()
  await expect(row('B 일감')).toBeVisible()
  expect(pidsB.every(alive)).toBe(true)

  await row('B 일감').hover()
  await win.getByRole('button', { name: 'B 일감 지우기' }).click()
  await win.getByRole('alertdialog').getByRole('button', { name: '지우기' }).click()
  await expect(row('B 일감')).toHaveCount(0)
  await expect.poll(() => pidsB.filter(alive), { timeout: 10_000 }).toEqual([])
  expect(alive(pidA)).toBe(true)
  await expect(view('A 일감')).toBeVisible() // 남은 일감이 활성
})

test('폴더 선택…: 고르면 칸에 들어가고, 취소하면 그대로', async () => {
  await app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { nextPick: string | null }
    g.nextPick = '/private/tmp'
    dialog.showOpenDialog = (async () => {
      const p = g.nextPick
      return p ? { canceled: false, filePaths: [p] } : { canceled: true, filePaths: [] }
    }) as typeof dialog.showOpenDialog
  })
  await win.getByRole('button', { name: '새 일감' }).first().click()
  const dialog = win.getByRole('dialog', { name: '새 일감' })
  await dialog.getByRole('button', { name: '폴더 선택…' }).click()
  await expect(dialog.getByLabel('작업 폴더')).toHaveValue('/private/tmp')

  await app.evaluate(() => {
    ;(globalThis as unknown as { nextPick: string | null }).nextPick = null
  })
  await dialog.getByRole('button', { name: '폴더 선택…' }).click()
  await win.waitForTimeout(200)
  await expect(dialog.getByLabel('작업 폴더')).toHaveValue('/private/tmp')
})

test('껐다 켜면 일감 · 묶음 · 활성 일감이 그대로', async () => {
  await createTask('A 일감')
  await createTask('B 일감', { group: '서버' })
  await selectButton('A 일감').click()
  await expect(view('A 일감')).toBeVisible()
  await app.close()
  launched = undefined

  await launch()
  await expect(row('A 일감')).toBeVisible()
  await expect(row('B 일감')).toBeVisible()
  await expect(win.getByTestId('sidebar').getByRole('heading', { name: '서버' })).toBeVisible()
  await expect(view('A 일감')).toBeVisible()
  await expect(view('B 일감')).toBeHidden()
})

test('일감이 없으면 빈 화면 안내 — 새 일감 버튼과 Esc', async () => {
  await expect(win.getByTestId('empty-view')).toContainText('일감이 없습니다')
  await win.getByTestId('empty-view').getByRole('button', { name: '새 일감' }).click()
  const dialog = win.getByRole('dialog', { name: '새 일감' })
  await expect(dialog.getByLabel('이름')).toBeFocused()
  await win.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(win.getByTestId('task-row')).toHaveCount(0)
})

test('키보드: Tab 으로 지우기 버튼에 갈 수 있다', async () => {
  await createTask('A 일감')
  await selectButton('A 일감').focus()
  await win.keyboard.press('Tab')
  await expect(win.getByRole('button', { name: 'A 일감 지우기' })).toBeFocused()
  await expect(win.getByRole('button', { name: 'A 일감 지우기' })).toHaveCSS('opacity', '1')
})

test('대화상자를 닫으면 포커스가 터미널로 돌아와 바로 칠 수 있다', async () => {
  await createTask('A 일감')
  await win.getByRole('button', { name: '새 일감' }).first().click()
  await win.keyboard.press('Escape')
  await win.keyboard.type('echo BACK_$((5+5))')
  await win.keyboard.press('Enter')
  await waitText('A 일감', /BACK_10/)
})

test('대화상자가 열려 있는 동안 Tab · Shift+Tab 이 밖으로 나가지 않는다', async () => {
  await createTask('A 일감')
  await row('A 일감').hover()
  await win.getByRole('button', { name: 'A 일감 지우기' }).click()
  const confirm = win.getByRole('alertdialog')
  await expect(confirm.getByRole('button', { name: '취소' })).toBeFocused()
  await win.keyboard.press('Shift+Tab')
  await expect(confirm.getByRole('button', { name: '지우기' })).toBeFocused()
  await win.keyboard.press('Tab')
  await expect(confirm.getByRole('button', { name: '취소' })).toBeFocused()
})

test('저장된 일감의 셸은 처음 볼 때 뜬다 — 시작할 때 한꺼번에 띄우지 않는다', async () => {
  await createTask('A 일감')
  await createTask('B 일감')
  await app.close()
  launched = undefined
  await launch()
  // 활성은 B(마지막에 만든 일감). A 는 아직 열지 않았으니 터미널이 없다.
  await expect(view('B 일감').locator('.terminal-pane')).toHaveCount(1)
  await expect(view('A 일감').locator('.terminal-pane')).toHaveCount(0)
  await selectButton('A 일감').click()
  await expect(view('A 일감').locator('.terminal-pane')).toHaveCount(1)
  await runIn('A 일감', 'echo LAZY_$((2*4))')
  await waitText('A 일감', /LAZY_8/)
})
