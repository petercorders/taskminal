import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstWindow, seedState } from './helpers'

// 10단계: 명령 팔레트(⌘P) — 키보드만으로 일감 · 명령 · 템플릿 · 터미널 출력을 찾아 간다.
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
const palette = () => win.getByTestId('palette')
const items = () => palette().getByTestId('palette-item')
const selected = () => palette().locator('[aria-selected="true"]')
const visibleTask = () => win.locator('[data-testid="task-view"]:visible')
const visibleSlots = () => win.locator('[data-testid="pane-slot"]:visible')

async function waitText(id: string, re: RegExp) {
  await expect.poll(async () => re.test(await screenOf(id)), { timeout: 15_000 }).toBe(true)
}
async function open(query: string) {
  await win.keyboard.press('Meta+KeyP')
  await expect(palette()).toBeVisible()
  await expect(palette().getByRole('combobox')).toBeFocused()
  if (query) await win.keyboard.type(query)
}
/** 지금 포커스된 셸에 표식을 쳐서 그 pane 에 나오는지 */
async function typesInto(id: string) {
  const mark = `HERE_${Date.now() % 100000}`
  await win.keyboard.type(`echo ${mark}`)
  await win.keyboard.press('Enter')
  await waitText(id, new RegExp(`^${mark}`, 'm'))
}

test('키보드만으로 일감 이동: ⌘P → 이름 → ↩ 이면 그 일감, 바로 칠 수 있다', async () => {
  await open('B 일')
  await expect(selected()).toHaveAttribute('data-kind', 'task')
  await expect(selected()).toContainText('B 일감')
  await win.screenshot({ path: 'test-results/palette-task.png' })
  await win.keyboard.press('Enter')
  await expect(palette()).toHaveCount(0)
  await expect(visibleTask()).toHaveAttribute('data-task-name', 'B 일감')
  await typesInto('pane-b')
})

test('터미널 출력 찾기: 다른 일감의 출력 줄을 고르면 그 pane 으로 가서 그 줄을 선택한다', async () => {
  await win.keyboard.type('echo NEEDLE_$((7*6))')
  await win.keyboard.press('Enter')
  await waitText('pane-a', /^NEEDLE_42/m)
  await win.keyboard.press('Meta+Alt+ArrowDown') // B 로
  await expect(visibleTask()).toHaveAttribute('data-task-name', 'B 일감')

  await open('NEEDLE_42')
  const output = items().filter({ hasText: /^출력/ })
  await expect(output).toHaveCount(1)
  await expect(output).toContainText('A 일감')
  await win.screenshot({ path: 'test-results/palette-output.png' })
  await win.keyboard.press('ArrowDown') // 출력 줄은 맨 아래 — 위 항목을 지나 고른다
  while ((await selected().getAttribute('data-kind')) !== 'output') await win.keyboard.press('ArrowDown')
  await win.keyboard.press('Enter')
  await expect(visibleTask()).toHaveAttribute('data-task-name', 'A 일감')
  await expect(term('pane-a').locator('.xterm-selection div')).not.toHaveCount(0) // 찾은 글자가 선택됨
  await typesInto('pane-a')
})

test('명령: "아래로" ↩ 이면 나뉘고, 일감에서 ⌘↩ 이면 그 일감에 새 탭', async () => {
  await open('아래로')
  await expect(selected()).toHaveAttribute('data-kind', 'command')
  await expect(selected()).toContainText('⇧⌘D')
  await win.keyboard.press('Enter')
  await expect(visibleSlots()).toHaveCount(2)

  await open('B 일감')
  await win.keyboard.press('Meta+Enter')
  await expect(visibleTask()).toHaveAttribute('data-task-name', 'B 일감')
  await expect(visibleTask().getByTestId('tab')).toHaveCount(2)
})

test('맞는 게 없으면 그 이름으로 새 일감 · 템플릿을 고르면 그 템플릿으로 새 일감 대화상자', async () => {
  await open('찍계부 서버')
  await expect(items()).toHaveCount(1)
  await expect(selected()).toHaveAttribute('data-kind', 'create')
  await win.keyboard.press('Enter')
  const dialog = win.getByRole('dialog', { name: '새 일감' })
  await expect(dialog.getByLabel('이름')).toHaveValue('찍계부 서버')
  await win.keyboard.press('Escape')

  await open('기본')
  await expect(selected()).toHaveAttribute('data-kind', 'template')
  await win.keyboard.press('Enter')
  await expect(dialog.getByTestId('new-task-template')).toContainText('기본')
})

test('⇥ 로 범위: 전체 → 일감 → 명령', async () => {
  await open('일감')
  const kinds = () => items().evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute('data-kind')))])
  expect(await kinds()).toEqual(['task', 'command', 'create']) // 이름이 '일감' 인 일감은 없으니 맨 끝에 새 일감
  await win.keyboard.press('Tab')
  await expect(palette().getByTestId('palette-scope')).toHaveText('일감')
  expect(await kinds()).toEqual(['task', 'create'])
  await win.keyboard.press('Tab')
  await expect(palette().getByTestId('palette-scope')).toHaveText('명령')
  expect(await kinds()).toEqual(['command'])
  await win.keyboard.press('Shift+Tab')
  await expect(palette().getByTestId('palette-scope')).toHaveText('일감')
})

test('Esc · 바깥 클릭은 아무것도 바꾸지 않고 터미널로 포커스, ↩ 두 번은 한 번만 실행', async () => {
  await open('아래로')
  await win.keyboard.press('Escape')
  await expect(palette()).toHaveCount(0)
  await expect(visibleSlots()).toHaveCount(1)
  await typesInto('pane-a')

  await open('')
  await win.mouse.click(5, 5) // 바깥
  await expect(palette()).toHaveCount(0)

  await open('오른쪽으로')
  await win.keyboard.press('Enter')
  await win.keyboard.press('Enter') // 두 번째는 터미널로 간다
  await expect(visibleSlots()).toHaveCount(2)
  await win.waitForTimeout(300)
  await expect(visibleSlots()).toHaveCount(2)
})

test('탭 이름을 고치는 중에는 ⌘P 가 열리지 않는다', async () => {
  await visibleTask().getByRole('tab').first().dblclick()
  await expect(win.getByRole('textbox', { name: '탭 이름' })).toBeFocused()
  await win.keyboard.press('Meta+KeyP')
  await win.waitForTimeout(200)
  await expect(palette()).toHaveCount(0)
  await win.keyboard.press('Escape')
})

test('한글을 조합하는 중의 ↩ 는 글자 확정 — 실행하지 않는다', async () => {
  await open('')
  const cdp = await win.context().newCDPSession(win)
  for (const t of ['ㅇ', '아', '아ㄹ', '아래']) await cdp.send('Input.imeSetComposition', { text: t, selectionStart: t.length, selectionEnd: t.length })
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 229 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 229 })
  await win.waitForTimeout(200)
  await expect(palette()).toBeVisible() // 조합 중 ↩ 로 닫히지 않음
  await cdp.send('Input.insertText', { text: '아래' })
  await win.keyboard.type('로')
  await expect(selected()).toContainText('아래로 나누기')
  await win.keyboard.press('Enter')
  await expect(visibleSlots()).toHaveCount(2)
})

test('화면 폭에서 접힌 줄에 걸친 글자도 찾고, 찾은 뒤 출력이 넘쳐 옛 줄이 버려져도 그 줄로 간다', async () => {
  // 접힌 자리에 걸치게: 칸 수 - 5 개의 x 뒤에 표식
  const cols = Number(await term('pane-a').getAttribute('data-cols'))
  await win.keyboard.type(`seq 1 3000; printf 'x%.0s' {1..${cols - 5}}; echo WRAPPEDMARK_$((5*5))`)
  await win.keyboard.press('Enter')
  await waitText('pane-a', /^EDMARK_25/m) // 접혀서 둘째 행에 'EDMARK_25'
  await win.keyboard.press('Meta+Alt+ArrowDown') // B 로
  await open('WRAPPEDMARK_25')
  await expect(items().filter({ hasText: /^출력/ })).toHaveCount(1) // 접힌 두 행을 이어 찾았다

  // 팔레트가 열린 사이 A 에서 3000줄이 더 나와 5000줄 스크롤 버퍼의 앞이 버려진다 → 찾을 때 잰 줄 번호가 밀린다
  // (숨은 터미널은 다시 그리지 않으므로 A 를 보이게 둔 채 그 위에 팔레트를 연다)
  await win.keyboard.press('Escape')
  await win.keyboard.press('Meta+Alt+ArrowUp')
  await win.keyboard.type('sleep 1; seq 5001 8000')
  await win.keyboard.press('Enter')
  await open('WRAPPEDMARK_25')
  await expect(items().filter({ hasText: /^출력/ })).toHaveCount(1)
  await expect.poll(async () => /^8000$/m.test(await screenOf('pane-a')), { timeout: 15_000 }).toBe(true) // 넘친 뒤
  expect(await screenOf('pane-a')).not.toMatch(/EDMARK_25/) // 맨 아래를 보는 중이라 그 줄은 화면 밖
  while ((await selected().getAttribute('data-kind')) !== 'output') await win.keyboard.press('ArrowDown')
  await win.keyboard.press('Enter')
  await expect(visibleTask()).toHaveAttribute('data-task-name', 'A 일감')
  await expect.poll(async () => /EDMARK_25/.test(await screenOf('pane-a'))).toBe(true) // 그 줄이 화면에 보인다
})

test('팔레트에서 대화상자를 여는 명령(새 일감)을 고르면 포커스는 대화상자에 — 터미널이 가져가지 않는다', async () => {
  await open('새 일감')
  await expect(selected()).toHaveAttribute('data-kind', 'command')
  await win.keyboard.press('Enter')
  const dialog = win.getByRole('dialog', { name: '새 일감' })
  await expect(dialog.getByLabel('이름')).toBeFocused()
  await win.waitForTimeout(200)
  await expect(dialog.getByLabel('이름')).toBeFocused()
})
