import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstWindow, seedState } from './helpers'

// 9단계: 셸 통합(OSC 133)으로 pane 활동 · 벨/알림 → 확인 필요 · 실행 중이면 닫기 전 확인.
// 셸은 사용자 실제 HOME 의 zsh 설정을 읽는다 — 통합이 그 환경을 깨지 않는지도 본다.
let userData: string
let launched: ElectronApplication | undefined
let app: ElectronApplication
let win: Page

test.beforeEach(async () => {
  userData = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-e2e-')))
  seedState(userData, [
    { id: 'task-a', name: 'A 일감', paneId: 'pane-a', cwd: '/tmp' },
    { id: 'task-b', name: 'B 일감', paneId: 'pane-b', cwd: '/tmp' },
  ])
  launched = undefined
  app = launched = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: userData } })
  win = await firstWindow(app)
  await term('pane-a').click()
})
test.afterEach(async () => {
  await launched?.close()
  rmSync(userData, { recursive: true, force: true })
})

const term = (id: string) => win.getByTestId(`pane-${id}`)
const screenOf = (id: string) => term(id).locator('.xterm-rows').innerText()
const slotOf = (id: string) => win.locator(`[data-testid="pane-slot"][data-pane-id="${id}"]`)
const headOf = (id: string) => slotOf(id).getByTestId('pane-head')
const row = (name: string) => win.locator(`[data-testid="task-row"][data-task-name="${name}"]`)
const attention = () => win.getByTestId('attention-section')
const visibleTask = () => win.locator('[data-testid="task-view"]:visible')

async function type(command: string) {
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

test('실패한 명령: pane 머리가 실행 중 → exit 1, 사이드바 아이콘도 실패 (보고 있으면 확인 필요는 아님)', async () => {
  await waitText('pane-a', /%/) // 첫 프롬프트
  await type('sleep 1; false')
  await expect(headOf('pane-a')).toHaveAttribute('data-activity', 'running')
  await expect(headOf('pane-a').getByTestId('pane-status')).toContainText('실행 중')
  await expect(headOf('pane-a')).toContainText('sleep 1; false') // 명령 글자(; 포함)
  await expect(headOf('pane-a')).toHaveAttribute('data-activity', 'failed', { timeout: 10_000 })
  await expect(headOf('pane-a').getByTestId('pane-status')).toContainText('exit 1')
  await expect(row('A 일감')).toHaveAttribute('data-activity', 'failed')
  await expect(row('A 일감').getByRole('img', { name: '실패' })).toBeVisible()
  await expect(attention()).toHaveCount(0)
  await win.screenshot({ path: 'test-results/activity-failed.png' })

  await type('true')
  await expect(headOf('pane-a')).toHaveAttribute('data-activity', 'done', { timeout: 10_000 })
  await expect(headOf('pane-a').getByTestId('pane-status')).toContainText('exit 0')
})

test('보지 않는 일감의 벨 → 확인 필요 · 탭 표시, ⇧⌘A 로 그 pane 으로 가면 사라진다', async () => {
  await win.keyboard.press('Meta+Alt+ArrowDown') // B
  await expect(visibleTask()).toHaveAttribute('data-task-name', 'B 일감')
  await waitText('pane-b', /%/)
  await type("sleep 2; printf '\\a'")
  await win.keyboard.press('Meta+Alt+ArrowUp') // A 로 돌아와 B 를 보지 않는다
  await expect(visibleTask()).toHaveAttribute('data-task-name', 'A 일감')

  await expect(attention().getByTestId('attention-row')).toHaveAttribute('data-task-name', 'B 일감', { timeout: 10_000 })
  await expect(win.locator('[data-task-name="B 일감"] [data-testid="tab"]')).toHaveAttribute('data-attention', 'true')
  await win.screenshot({ path: 'test-results/activity-attention.png' })

  await win.keyboard.press('Meta+Shift+KeyA')
  await expect(visibleTask()).toHaveAttribute('data-task-name', 'B 일감')
  await expect(attention()).toHaveCount(0)
})

test('보고 있는 pane 의 벨은 확인 필요가 아니다', async () => {
  await waitText('pane-a', /%/)
  await type("printf '\\a'; echo RANG_$((1+1))")
  await waitText('pane-a', /RANG_2/)
  await win.waitForTimeout(300)
  await expect(attention()).toHaveCount(0)
})

test('OSC 9 · OSC 777 알림도 확인 필요 (Claude Code 의 Notification 훅이 낼 수 있는 신호)', async () => {
  await win.keyboard.press('Meta+Alt+ArrowDown')
  await waitText('pane-b', /%/)
  await type("sleep 1; printf '\\e]9;CC9\\a'")
  await win.keyboard.press('Meta+Alt+ArrowUp')
  await expect(attention().getByTestId('attention-row')).toHaveCount(1, { timeout: 10_000 })
  await win.keyboard.press('Meta+Shift+KeyA')
  await expect(attention()).toHaveCount(0)

  await type("sleep 1; printf '\\e]777;notify;Claude;권한\\a'")
  await win.keyboard.press('Meta+Alt+ArrowUp')
  await expect(attention().getByTestId('attention-row')).toHaveAttribute('data-task-name', 'B 일감', { timeout: 10_000 })
})

test('실행 중인 pane 의 ⌘W · 탭 × 는 확인을 받는다 — 취소면 그대로, 닫기면 셸이 끝난다', async () => {
  await waitText('pane-a', /%/)
  await type('echo PID_ $$')
  const pid = Number((await waitText('pane-a', /PID_ (\d+)/))[1])
  await type('sleep 30')
  await expect(headOf('pane-a')).toHaveAttribute('data-activity', 'running')
  await expect(win.locator('[data-task-name="A 일감"] [data-testid="tab"]')).toHaveAttribute('data-running', '1')
  await expect(row('A 일감')).toHaveAttribute('data-activity', 'running')

  await win.keyboard.press('Meta+KeyW')
  const dialog = win.getByRole('alertdialog')
  await expect(dialog).toContainText('sleep 30')
  await win.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(slotOf('pane-a')).toHaveCount(1)
  expect(alive(pid)).toBe(true)

  await win.getByRole('button', { name: /탭 닫기/ }).click()
  await expect(dialog).toContainText('실행 중')
  await dialog.getByRole('button', { name: '취소' }).click()
  await expect(slotOf('pane-a')).toHaveCount(1)

  await term('pane-a').click()
  await win.keyboard.press('Meta+KeyW')
  await dialog.getByRole('button', { name: '닫기' }).click()
  await expect(slotOf('pane-a')).toHaveCount(0)
  await expect.poll(() => alive(pid), { timeout: 10_000 }).toBe(false)
})

test('셸 통합은 사용자 환경을 바꾸지 않는다 (ZDOTDIR 원래대로 · 안쪽 zsh 정상)', async () => {
  await waitText('pane-a', /%/)
  await type(`[[ -z \${ZDOTDIR+x} ]] && echo ZD_UNSET; [[ -z \${TASKMINAL_USER_ZDOTDIR+x} ]] && echo TU_UNSET; zsh -ic 'echo INNER_$((2+3))'`)
  await waitText('pane-a', /^INNER_5/m)
  const screen = await screenOf('pane-a')
  expect(screen).toMatch(/^ZD_UNSET/m)
  expect(screen).toMatch(/^TU_UNSET/m)
})

test('분할하면 포커스 아닌 pane 은 흐리고, 포커스 pane 머리에 강조 줄', async () => {
  await win.keyboard.press('Meta+KeyD')
  await expect(win.locator('[data-testid="pane-slot"]:visible')).toHaveCount(2)
  await expect(slotOf('pane-a')).toHaveClass(/dimmed/)
  const opacity = await slotOf('pane-a').locator('.terminal-pane').evaluate((el) => el.ownerDocument.defaultView!.getComputedStyle(el).opacity)
  expect(opacity).toBe('0.62')
  const other = win.locator('[data-testid="pane-slot"][data-focused="true"]:visible')
  await expect(other).not.toHaveClass(/dimmed/)
  await expect(other.getByTestId('pane-head')).toHaveClass(/focused/)
  await win.screenshot({ path: 'test-results/activity-split.png' })
})

test('확인 대화상자가 떠 있는 사이 셸이 스스로 끝나 탭이 사라지면, 닫기는 대화상자만 닫는다', async () => {
  await waitText('pane-a', /%/)
  await win.keyboard.press('Meta+KeyT') // 두 번째 탭 — 첫 탭이 사라져도 화면이 남게
  await expect(win.locator('[data-task-name="A 일감"] [data-testid="tab"]')).toHaveCount(2)
  await win.keyboard.press('Meta+Digit1')
  await term('pane-a').click()
  await type('sleep 1; exit')
  await expect(headOf('pane-a')).toHaveAttribute('data-activity', 'running')
  await win.getByRole('button', { name: /탭 닫기/ }).first().click()
  const dialog = win.getByRole('alertdialog')
  await expect(dialog).toBeVisible()
  await expect(win.locator('[data-task-name="A 일감"] [data-testid="tab"]')).toHaveCount(1, { timeout: 10_000 }) // 셸이 끝나 탭이 닫힘
  await dialog.getByRole('button', { name: '닫기' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(win.locator('[data-task-name="A 일감"] [data-testid="tab"]')).toHaveCount(1) // 남은 탭은 그대로
})
