import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstWindow, seedState } from './helpers'

// 11단계: 설정 창(⌘,) — 바꾸면 화면에 바로 반영 · 재시작 후 유지 · 단축키 겹침 경고 · 우클릭 메뉴 · 묶음 접기
let userData: string
let launched: ElectronApplication | undefined
let app: ElectronApplication
let win: Page

async function launch() {
  app = launched = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: userData } })
  win = await firstWindow(app)
}
async function restart() {
  await launched!.close()
  launched = undefined
  await launch()
}

test.beforeEach(async ({}, info) => {
  userData = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-e2e-')))
  seedState(
    userData,
    [
      { id: 'task-a', name: 'A 일감', paneId: 'pane-a', cwd: '/tmp' },
      { id: 'task-b', name: 'B 일감', paneId: 'pane-b', cwd: '/tmp', groupId: 'g-srv' },
    ],
    [{ id: 'g-srv', name: '서버' }],
    info.title.includes('끄기 전') ? { confirmQuit: true } : {},
  )
  launched = undefined
  await launch()
  await term('pane-a').click()
})
test.afterEach(async () => {
  await launched?.close()
  rmSync(userData, { recursive: true, force: true })
})

const term = (id: string) => win.getByTestId(`pane-${id}`)
const screenOf = (id: string) => term(id).locator('.xterm-rows').innerText()
const settings = () => win.getByTestId('settings')
const rowTitles = () => settings().getByTestId('setting-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-title')))
const taskRow = (name: string) => win.locator(`[data-testid="task-row"][data-task-name="${name}"]`)
const visibleTask = () => win.locator('[data-testid="task-view"]:visible')
const section = (name: string) => settings().getByRole('navigation', { name: '설정 칸' }).getByRole('button', { name })

async function openSettings(name?: string) {
  await win.keyboard.press('Meta+Comma')
  await expect(settings()).toBeVisible()
  if (name) await section(name).click()
}
async function closeSettings() {
  await settings().getByRole('button', { name: /일감으로 돌아가기/ }).click()
  await expect(settings()).toHaveCount(0)
}
async function type(command: string) {
  await win.keyboard.type(command)
  await win.keyboard.press('Enter')
}
async function waitText(id: string, re: RegExp) {
  await expect.poll(async () => re.test(await screenOf(id)), { timeout: 15_000 }).toBe(true)
}

test('⌘, 로 열고 찾기 · Esc 는 찾기 글자부터 지우고 다음 Esc 로 닫혀 터미널로', async () => {
  await expect(win.getByTestId('state-notice')).toHaveCount(0) // 새 설정 칸이 없는 옛 파일이어도 '일부를 읽지 못함' 경고 · 백업 없음
  await openSettings()
  await expect(settings().getByRole('searchbox', { name: '설정 찾기' })).toBeFocused()
  await expect(settings().getByRole('heading', { level: 1 })).toHaveText('설정 — 일반')
  await win.keyboard.type('커서')
  await expect.poll(rowTitles).toEqual(['커서', '커서 깜빡임'])
  await win.keyboard.type('zzz')
  await expect(settings().getByText('맞는 설정이 없습니다')).toBeVisible()
  await win.keyboard.press('Escape')
  await expect(settings()).toBeVisible()
  await expect(settings().getByRole('searchbox')).toHaveValue('')
  await win.keyboard.press('Escape')
  await expect(settings()).toHaveCount(0)
  await type('echo BACK_$((2*3))')
  await waitText('pane-a', /^BACK_6/m)
})

test('모양: 밝게 · 강조색 · 흐림 · 한 줄 — 바로 바뀌고 재시작 뒤에도 그대로', async () => {
  await openSettings('모양')
  await settings().getByRole('radio', { name: '밝게' }).click()
  await settings().getByRole('radio', { name: '주황' }).click()
  await settings().getByRole('slider', { name: '포커스 아닌 분할 밝기' }).fill('40')
  await settings().getByRole('radio', { name: '한 줄 (이름만)' }).click()
  await settings().getByRole('combobox', { name: '터미널 글꼴' }).selectOption('Menlo')
  await win.screenshot({ path: 'test-results/settings-look.png' })
  await closeSettings()

  // 페이지 안에서 도는 식 — e2e 는 DOM 타입 없이 컴파일하므로 문자열로
  const look = () =>
    win.evaluate(`(() => {
      const root = document.documentElement, css = getComputedStyle(root)
      return { theme: root.dataset.theme, body: getComputedStyle(document.body).backgroundColor,
        accent: css.getPropertyValue('--accent').trim(), dim: css.getPropertyValue('--dim-opacity').trim() }
    })()`)
  const expected = { theme: 'light', body: 'rgb(255, 255, 255)', accent: '#e5a54b', dim: '0.4' }
  await expect.poll(look).toEqual(expected)
  await expect(term('pane-a')).toHaveAttribute('data-theme', 'light')
  await expect(term('pane-a')).toHaveAttribute('data-font-family', 'Menlo')
  await expect(term('pane-a').locator('.xterm-scrollable-element')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await expect(win.locator('.task-sub')).toHaveCount(0)
  await win.keyboard.press('Meta+KeyD') // 분할 → 포커스 아닌 pane 이 0.4
  await expect(win.locator('.pane-slot.dimmed .terminal-pane')).toHaveCSS('opacity', '0.4')
  await win.screenshot({ path: 'test-results/settings-light.png' })

  await restart()
  await expect.poll(look).toEqual(expected)
  await expect(win.locator('.task-sub')).toHaveCount(0)
})

test('터미널: 커서 · 스크롤 줄 수 · Option=Meta 는 열린 터미널에 바로, 셸 통합을 끄면 새 터미널은 실행 표시가 없다', async () => {
  await openSettings('터미널')
  await settings().getByRole('radio', { name: '블록' }).click()
  const scroll = settings().getByRole('textbox', { name: '스크롤 보관 줄 수' })
  await scroll.fill('20000')
  await scroll.press('Enter')
  await settings().getByRole('switch', { name: 'Option 키를 Meta 로' }).click()
  await scroll.fill('abc') // 틀린 값은 원래대로
  await scroll.press('Enter')
  await expect(scroll).toHaveValue('20000')
  await settings().getByRole('switch', { name: '셸 통합' }).click()
  await closeSettings()
  await expect(term('pane-a')).toHaveAttribute('data-cursor-style', 'block')
  await expect(term('pane-a')).toHaveAttribute('data-scrollback', '20000')
  await expect(term('pane-a')).toHaveAttribute('data-option-meta', 'true')

  // 열려 있던 셸은 통합 그대로(실행 중 표시), 새 탭의 셸은 통합 없음
  const head = (id: string) => win.locator(`[data-testid="pane-slot"][data-pane-id="${id}"]`).getByTestId('pane-head')
  await waitText('pane-a', /%/)
  await type('sleep 2')
  await expect(head('pane-a')).toHaveAttribute('data-activity', 'running')
  await win.keyboard.press('Meta+KeyT')
  const newPane = await visibleTask().locator('[data-testid="pane-slot"]:visible').getAttribute('data-pane-id')
  await expect.poll(async () => (await term(newPane!).locator('.xterm-rows').innerText()).includes('%'), { timeout: 15_000 }).toBe(true)
  await type('sleep 2')
  await win.waitForTimeout(800)
  await expect(head(newPane!)).not.toHaveAttribute('data-activity', 'running')
})

test('단축키: 새 탭을 ⌘Y 로 바꾸면 ⌘Y 가 새 탭 · ⌘T 는 아무것도 · 메뉴도 ⌘Y, 겹치면 경고 · 기본값으로', async () => {
  await openSettings('단축키')
  const field = settings().getByTestId('key-new-tab')
  await field.click()
  await expect(field).toHaveText('키를 누르세요')
  await win.keyboard.press('KeyY') // ⌘ 없는 키는 받지 않고 계속 기다린다
  await expect(field).toHaveText('키를 누르세요')
  await win.keyboard.press('Meta+KeyY')
  await expect(field).toHaveText('⌘Y')
  await closeSettings()

  const tabs = () => visibleTask().getByTestId('tab')
  await expect(tabs()).toHaveCount(1)
  await win.keyboard.press('Meta+KeyT')
  await win.waitForTimeout(300)
  await expect(tabs()).toHaveCount(1)
  await win.keyboard.press('Meta+KeyY')
  await expect(tabs()).toHaveCount(2)
  await expect.poll(() => app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('new-tab')?.accelerator)).toBe('Command+Y')

  await openSettings('단축키')
  await field.click()
  await win.keyboard.press('Meta+KeyK') // 화면 지우기와 겹침
  await expect(settings().getByText('‘화면 지우기’와 겹쳐요')).toBeVisible()
  await expect(settings().getByText('‘새 탭’과 겹쳐요')).toBeVisible()
  await expect(settings().getByTestId('key-conflict-badge')).toHaveText('충돌 2')
  await win.screenshot({ path: 'test-results/settings-keys.png' })
  await settings().getByRole('button', { name: 'iTerm2 기본값으로' }).click()
  await expect(settings().getByTestId('key-conflict-badge')).toHaveCount(0)
  await expect(field).toHaveText('⌘T')
  await expect.poll(() => app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('new-tab')?.accelerator)).toBe('Command+T')
})

test('일감 관리: 상태를 지우면 그 일감은 첫 상태로, 묶음 추가는 새 일감 대화상자에 보인다', async () => {
  await openSettings('일감 관리')
  await settings().getByRole('button', { name: '+ 상태 추가' }).click()
  await expect(settings().getByTestId('status-item')).toHaveCount(4)
  const last = settings().getByTestId('status-item').last().getByRole('textbox', { name: '상태 이름' })
  await last.fill('리뷰 중')
  await last.press('Enter')
  await expect(settings().getByRole('button', { name: '리뷰 중 위로' })).toBeVisible()
  await settings().getByRole('button', { name: '진행 중 지우기' }).click() // A · B 는 '진행 중'
  await settings().getByRole('button', { name: '+ 묶음 추가' }).click()
  const group = settings().getByTestId('group-item').last().getByRole('textbox', { name: '묶음 이름' })
  await group.fill('개인')
  await group.press('Enter')
  await expect(settings().getByTestId('group-item')).toHaveCount(2)
  await win.screenshot({ path: 'test-results/settings-tasks.png' })
  await closeSettings()

  await expect(taskRow('A 일감').locator('.task-sub')).toContainText('대기')
  await win.keyboard.press('Meta+KeyN')
  const dialog = win.getByRole('dialog', { name: '새 일감' })
  await expect(dialog.getByLabel('묶음').locator('option')).toHaveText(['없음', '서버', '개인'])
  await expect(dialog.getByLabel('상태').locator('option')).toHaveText(['대기', '완료', '리뷰 중'])
})

test('우클릭 메뉴: 상태 · 묶음 · 색 · 이름 바꾸기, 키보드(⇧F10 · ↑↓ · Esc), 묶음 접기 — 재시작 뒤에도', async () => {
  const menu = () => win.getByTestId('task-menu')
  await taskRow('A 일감').click({ button: 'right' })
  await expect(menu()).toBeVisible()
  await expect(menu().getByRole('menuitem', { name: '이름 바꾸기' })).toBeFocused()
  await menu().getByRole('group', { name: '상태' }).getByRole('menuitemradio', { name: '완료' }).click()
  await expect(menu()).toHaveCount(0)
  await expect(taskRow('A 일감').locator('.task-sub')).toContainText('완료')

  await taskRow('A 일감').click({ button: 'right' })
  await menu().getByRole('group', { name: '묶음' }).getByRole('menuitemradio', { name: '서버' }).click()
  await taskRow('A 일감').click({ button: 'right' })
  await menu().getByRole('group', { name: '색' }).getByRole('menuitemradio', { name: '색 3' }).click()
  await expect(taskRow('A 일감').locator('.task-dot')).toHaveCSS('background-color', 'rgb(229, 181, 103)')

  // 키보드: 행에서 ⇧F10 → ↓ 로 '완료'(상태 셋째)까지 → Esc 는 아무것도 바꾸지 않음
  await taskRow('A 일감').getByRole('button', { name: /A 일감/ }).first().focus()
  await win.keyboard.press('Shift+F10')
  await expect(menu()).toBeVisible()
  await win.keyboard.press('ArrowDown')
  await expect(menu().getByRole('menuitemradio', { name: '진행 중' })).toBeFocused()
  await win.keyboard.press('Escape')
  await expect(menu()).toHaveCount(0)

  // 이름 바꾸기
  await taskRow('A 일감').click({ button: 'right' })
  await menu().getByRole('menuitem', { name: '이름 바꾸기' }).click()
  const input = win.getByRole('textbox', { name: '일감 이름' })
  await expect(input).toBeFocused()
  await input.fill('A 서버')
  await input.press('Enter')
  await expect(taskRow('A 서버')).toBeVisible()
  await win.screenshot({ path: 'test-results/settings-menu.png' })

  // 묶음 접기: 두 일감이 '서버' 묶음 — 접으면 숨고 개수
  const toggle = win.getByRole('button', { name: /서버/ }).and(win.locator('.group-toggle'))
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(toggle).toContainText('2')
  await expect(win.getByTestId('task-row')).toHaveCount(0)

  await restart()
  await expect(win.locator('.group-toggle')).toHaveAttribute('aria-expanded', 'false')
  await win.locator('.group-toggle').click()
  await expect(taskRow('A 서버').locator('.task-sub')).toContainText('완료')
})

test('일반: 기본 폴더 · 기본 템플릿이 새 일감 대화상자에, "일감 목록만" 이면 재시작 때 셸을 띄우지 않는다', async () => {
  await openSettings('일반')
  const folder = settings().getByRole('textbox', { name: '새 일감 기본 폴더' })
  await folder.fill(userData)
  await folder.press('Enter')
  await settings().getByRole('combobox', { name: '새 일감 기본 템플릿' }).selectOption('tpl-basic')
  await settings().getByRole('radio', { name: /일감 목록만/ }).click()
  await closeSettings()
  await win.keyboard.press('Meta+KeyN')
  const dialog = win.getByRole('dialog', { name: '새 일감' })
  await expect(dialog.getByLabel('작업 폴더')).toHaveValue(userData)
  await expect(dialog.getByTestId('new-task-template')).toHaveValue('tpl-basic')
  await win.keyboard.press('Escape')

  await restart()
  await expect(win.getByTestId('pick-view')).toBeVisible()
  await expect(win.locator('.terminal-pane')).toHaveCount(0) // 셸 없음
  await taskRow('B 일감').click()
  await expect(term('pane-b')).toBeVisible()
  await expect(win.getByTestId('pick-view')).toHaveCount(0)
})

test('알림: 보지 않는 일감의 실패는 macOS 알림, 보고 있으면 없음, 소리만 고르면 소리만 · Dock 배지', async () => {
  // 페이지의 Notification 을 가짜로 — 보낸 것을 모은다 (DOM 타입 없이 컴파일하므로 문자열 식)
  await win.evaluate(`(() => {
    const sent = []
    window.__sent = sent
    window.Notification = class { constructor(title, opts = {}) { this.onclick = null; sent.push({ title, body: opts.body ?? '', silent: Boolean(opts.silent) }) } }
  })()`)
  await app.evaluate(({ shell }) => {
    ;(globalThis as unknown as { beeps: number }).beeps = 0
    shell.beep = () => {
      ;(globalThis as unknown as { beeps: number }).beeps++
    }
  })
  const sent = () => win.evaluate<Array<{ title: string; body: string }>>('window.__sent')
  const beeps = () => app.evaluate(() => (globalThis as unknown as { beeps: number }).beeps)
  const badge = () => app.evaluate(({ app }) => app.dock?.getBadge())

  await waitText('pane-a', /%/)
  await type('sleep 1; false') // 보고 있는 pane — 알리지 않는다
  await expect.poll(async () => (await win.locator('[data-pane-id="pane-a"] [data-testid="pane-head"]').getAttribute('data-activity')) === 'failed', { timeout: 10_000 }).toBe(true)
  expect(await sent()).toEqual([])

  await type('sleep 2; (exit 3)')
  await win.keyboard.press('Meta+Alt+ArrowDown') // B 를 본다
  await expect.poll(sent, { timeout: 10_000 }).toEqual([expect.objectContaining({ title: '명령이 실패했습니다', body: expect.stringContaining('A 일감') })])
  expect((await sent())[0]!.body).toContain('exit 3')
  await expect.poll(badge).toBe('1') // 확인 필요 일감 하나

  // 실패: macOS 알림 끄고 소리만
  await openSettings('알림 · 활동')
  await settings().getByRole('switch', { name: '명령이 실패했을 때 — macOS 알림' }).click()
  await settings().getByRole('switch', { name: '명령이 실패했을 때 — 소리' }).click()
  await closeSettings()
  await win.keyboard.press('Meta+Alt+ArrowUp') // A 로 돌아와 실행하고 다시 B 로
  await type('sleep 2; false')
  await win.keyboard.press('Meta+Alt+ArrowDown')
  await expect.poll(beeps, { timeout: 10_000 }).toBe(1)
  expect(await sent()).toHaveLength(1)

  await openSettings('일반')
  await settings().getByRole('switch', { name: 'Dock 아이콘에 확인 필요 수 표시' }).click()
  await expect.poll(badge).toBe('')
})

test('끄기 전 확인: 실행 중이면 ⌥⌘Q(셸까지 모두 끝내기)가 묻고, 닫기면 그대로 · 모두 끝내기면 앱이 끝난다', async () => {
  await app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { asked: string[]; answer: number }
    g.asked = []
    g.answer = 0 // 닫기 (기본 · Esc)
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const opts = args.at(-1) as { message: string }
      g.asked.push(opts.message)
      return { response: g.answer, checkboxChecked: false }
    }) as typeof dialog.showMessageBox
  })
  const asked = () => app.evaluate(() => (globalThis as unknown as { asked: string[] }).asked)

  await waitText('pane-a', /%/)
  await type('sleep 30')
  await expect(win.locator('[data-pane-id="pane-a"] [data-testid="pane-head"]')).toHaveAttribute('data-activity', 'running')
  const quitAll = () => app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('quit-all')!.click())
  await quitAll()
  await expect.poll(asked).toEqual(['실행 중인 명령 1개를 끝낼까요?'])
  await win.waitForTimeout(300)
  await expect(term('pane-a')).toBeVisible() // 닫기 — 그대로

  const closed = new Promise<void>((resolve) => launched!.on('close', () => resolve()))
  await app.evaluate(() => {
    ;(globalThis as unknown as { answer: number }).answer = 1 // 모두 끝내기
  })
  await quitAll()
  await closed
  launched = undefined
})

test('리뷰 반영: 보고 있어도 알리기(설정 끔)면 보는 pane 의 벨도 알림', async () => {
  await win.evaluate(`(() => {
    const sent = []
    window.__sent = sent
    window.Notification = class { constructor(title, opts = {}) { this.onclick = null; sent.push({ title, body: opts.body ?? '' }) } }
  })()`)
  const sent = () => win.evaluate<Array<{ title: string }>>('window.__sent')
  await waitText('pane-a', /%/)
  await type(`printf '\\a'`) // 보고 있음 + 알리지 않기(기본) → 없음
  await win.waitForTimeout(500)
  expect(await sent()).toEqual([])
  await openSettings('알림 · 활동')
  await settings().getByRole('switch', { name: '보고 있는 일감은 알리지 않기' }).click()
  await closeSettings()
  await type(`printf '\\a'`)
  await expect.poll(sent).toEqual([expect.objectContaining({ title: '입력을 기다립니다' })])
})

test('리뷰 반영: 접힌 묶음의 일감을 확인 필요 칸에서 이름 바꾸면 묶음이 펴지고 입력칸이 뜬다', async () => {
  await win.keyboard.press('Meta+Alt+ArrowDown') // B 를 한 번 봐서 셸을 띄운다
  await waitText('pane-b', /%/)
  await type(`sleep 1; printf '\\a'`)
  await win.keyboard.press('Meta+Alt+ArrowUp') // A 를 보는 사이 B 가 벨
  const attentionRow = win.locator('[data-testid="attention-row"][data-task-name="B 일감"]')
  await expect(attentionRow).toBeVisible({ timeout: 10_000 })
  await win.locator('.group-toggle').click() // '서버' 접기
  await expect(win.locator('.group-toggle')).toHaveAttribute('aria-expanded', 'false')
  await attentionRow.click({ button: 'right' })
  await win.getByTestId('task-menu').getByRole('menuitem', { name: '이름 바꾸기' }).click()
  const input = win.getByRole('textbox', { name: '일감 이름' })
  await expect(input).toBeFocused()
  await expect(win.locator('.group-toggle')).toHaveAttribute('aria-expanded', 'true')
  await input.fill('B 서버')
  await input.press('Escape') // 취소 — 이름 그대로
  await expect(taskRow('B 일감')).toBeVisible()
})

test('리뷰 반영: /etc/shells 에 없는 셸을 적으면 로그인 셸로 연다고 알린다', async () => {
  await openSettings('터미널')
  const shell = settings().getByRole('combobox', { name: '셸' })
  await shell.fill('/tmp/not-a-shell')
  await shell.press('Enter')
  await expect(settings().getByTestId('shell-rejected')).toBeVisible()
  await shell.fill('/bin/zsh')
  await shell.press('Enter')
  await expect(settings().getByTestId('shell-rejected')).toHaveCount(0)
})
