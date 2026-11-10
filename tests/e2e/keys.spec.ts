import { _electron as electron, expect, test, type CDPSession, type ElectronApplication, type Page } from '@playwright/test'
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SHORTCUTS } from '../../src/shared/keymap'
import { firstWindow, seedState } from './helpers'

// 8단계: 단축키 · 앱 메뉴 · 복사/붙여넣기 · 한글 조합.
// 단축키는 renderer 가 처리한다 — Playwright 의 합성 키는 네이티브 메뉴 단축키를 부르지 않는다(2026-11-10 측정).
// 그래서 키는 실제 키 이벤트로, 메뉴는 main 에서 메뉴 항목을 눌러 따로 시험한다.
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
const visibleTask = () => win.locator('[data-testid="task-view"]:visible')
const tabs = () => visibleTask().getByTestId('tab')
// 숨은 탭의 pane 도 마운트돼 있으므로 보이는 탭 안에서만 센다
const visibleTab = () => visibleTask().locator('[data-testid="tab-view"]:visible')
const slots = () => visibleTab().getByTestId('pane-slot')
const focusedSlotId = () => visibleTab().locator('[data-testid="pane-slot"][data-focused="true"]').getAttribute('data-pane-id')
const activeTabIndex = () => tabs().evaluateAll((els) => els.findIndex((e) => e.classList.contains('active')))

async function waitText(id: string, re: RegExp): Promise<RegExpMatchArray> {
  let m: RegExpMatchArray | null = null
  await expect.poll(async () => (m = (await screenOf(id)).match(re)) !== null, { timeout: 15_000 }).toBe(true)
  return m!
}

/** 클릭하지 않고 친다 — 단축키 뒤에 포커스가 맞는 터미널로 갔는지까지 본다 */
async function typeHere(command: string) {
  await win.keyboard.type(command)
  await win.keyboard.press('Enter')
}

/** 지금 포커스된 셸에서 표식을 출력하고, 그 표식이 나온 pane id 를 돌려준다 */
let marks = 0
async function whereTyping(): Promise<string> {
  const n = ++marks
  await typeHere(`echo HERE${n}_$((${n}+100))`)
  const re = new RegExp(`HERE${n}_${n + 100}`)
  let found: string | null = null
  await expect
    .poll(async () => {
      for (const el of await win.locator('.terminal-pane').all()) {
        if (re.test(await el.locator('.xterm-rows').innerText())) return (found = (await el.getAttribute('data-testid'))!.slice(5))
      }
      return null
    }, { timeout: 15_000 })
    .not.toBeNull()
  return found!
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('⌘T 새 탭은 바로 칠 수 있고, ⌘1 · ⌘9 · ⇧⌘[ · ⇧⌘] 로 탭을 옮긴다', async () => {
  await win.keyboard.press('Meta+KeyT')
  await win.keyboard.press('Meta+KeyT')
  await expect(tabs()).toHaveCount(3)
  expect(await activeTabIndex()).toBe(2)
  const third = await whereTyping()
  expect(third).not.toBe('pane-a') // 새 탭의 셸에 쳐졌다

  await win.keyboard.press('Meta+Digit1')
  await expect.poll(activeTabIndex).toBe(0)
  expect(await whereTyping()).toBe('pane-a') // 옮긴 탭의 터미널로 포커스
  await win.keyboard.press('Meta+Digit9')
  await expect.poll(activeTabIndex).toBe(2)
  await win.keyboard.press('Meta+Shift+BracketRight') // 끝에서 돈다
  await expect.poll(activeTabIndex).toBe(0)
  await win.keyboard.press('Meta+Shift+BracketLeft')
  await expect.poll(activeTabIndex).toBe(2)
  await win.keyboard.press('Meta+Digit2')
  await expect.poll(activeTabIndex).toBe(1)
  await win.screenshot({ path: 'test-results/keys-tabs.png' })
})

test('⌘D · ⇧⌘D 로 나누고 ⌘] · ⌘[ 로 pane 을 돌고, ⌘W 는 활성 pane 의 셸만 끝내고 닫는다', async () => {
  await win.keyboard.press('Meta+KeyD')
  await expect(slots()).toHaveCount(2)
  await win.keyboard.press('Meta+Shift+KeyD')
  await expect(slots()).toHaveCount(3)
  const ids = await slots().evaluateAll((els) => els.map((e) => e.getAttribute('data-pane-id')!))
  expect(await focusedSlotId()).toBe(ids[2]) // 새 pane(아래)이 활성
  expect(await whereTyping()).toBe(ids[2])

  await win.keyboard.press('Meta+BracketRight') // 끝에서 처음으로
  await expect.poll(focusedSlotId).toBe(ids[0])
  expect(await whereTyping()).toBe(ids[0])
  await win.keyboard.press('Meta+BracketLeft')
  await expect.poll(focusedSlotId).toBe(ids[2])

  // ⌘W: 활성 pane(아래)의 셸 pid 가 사라지고 나머지는 산다
  const pidOf = async (id: string, tag: string) => {
    await term(id).click()
    await typeHere(`echo PID${tag}_ $$`)
    return Number((await waitText(id, new RegExp(`PID${tag}_ (\\d+)`)))[1])
  }
  const keep = await pidOf(ids[0]!, 'K')
  const gone = await pidOf(ids[2]!, 'G')
  await win.keyboard.press('Meta+KeyW')
  await expect(slots()).toHaveCount(2)
  await expect.poll(() => alive(gone), { timeout: 10_000 }).toBe(false)
  expect(alive(keep)).toBe(true)
  const next = await focusedSlotId()
  expect(next).not.toBe(ids[2])
  expect(await whereTyping()).toBe(next) // 남은 pane 에 포커스
})

test('⌘W · ⌘D · ⌘T 를 누르고 있어도(키 반복) 한 번만', async () => {
  const cdp = await win.context().newCDPSession(win)
  await metaKey(cdp, 'd', 'KeyD', 68)
  await metaKey(cdp, 'd', 'KeyD', 68, { autoRepeat: true })
  await metaKey(cdp, 'd', 'KeyD', 68, { autoRepeat: true })
  await metaKey(cdp, 't', 'KeyT', 84, { autoRepeat: true }) // 반복 키만 오면 새 탭도 없다
  await win.keyboard.press('Meta+KeyD')
  await expect(slots()).toHaveCount(3)
  await expect(tabs()).toHaveCount(1)
  await metaKey(cdp, 'w', 'KeyW', 87)
  await metaKey(cdp, 'w', 'KeyW', 87, { autoRepeat: true })
  await metaKey(cdp, 'w', 'KeyW', 87, { autoRepeat: true })
  await expect(slots()).toHaveCount(2)
  await win.waitForTimeout(300)
  await expect(slots()).toHaveCount(2)
})

test('⌥⌘↓ · ⌥⌘↑ 는 사이드바 순서로 일감을 옮긴다', async () => {
  await expect(visibleTask()).toHaveAttribute('data-task-name', 'A 일감')
  await win.keyboard.press('Meta+Alt+ArrowDown')
  await expect(visibleTask()).toHaveAttribute('data-task-name', 'B 일감')
  expect(await whereTyping()).toBe('pane-b')
  await win.keyboard.press('Meta+Alt+ArrowDown') // 끝에서 처음으로
  await expect(visibleTask()).toHaveAttribute('data-task-name', 'A 일감')
  await win.keyboard.press('Meta+Alt+ArrowUp')
  await expect(visibleTask()).toHaveAttribute('data-task-name', 'B 일감')
})

test('⌘K 는 화면을 지우고 셸은 그대로', async () => {
  await typeHere('echo WIPE_$((6*7))')
  await waitText('pane-a', /WIPE_42/)
  await win.keyboard.press('Meta+KeyK')
  await expect.poll(() => screenOf('pane-a')).not.toMatch(/WIPE_42/)
  await typeHere('echo AFTER_$((1+1))')
  await waitText('pane-a', /AFTER_2/)
})

test('⌘= · ⌘− · ⌘0 로 글자 크기를 바꾸면 셸 크기도 맞고, 크기는 저장된다', async () => {
  const cols = async () => Number(await term('pane-a').getAttribute('data-cols'))
  const base = await cols()
  await win.keyboard.press('Meta+Equal')
  await win.keyboard.press('Meta+Equal')
  await expect.poll(cols).toBeLessThan(base)
  const bigger = await cols()
  await typeHere('echo SZ_$(stty size | tr " " x)')
  const [, , c] = await waitText('pane-a', /SZ_(\d+)x(\d+)/)
  expect(Number(c)).toBe(bigger)
  const saved = () => JSON.parse(readFileSync(join(userData, 'state.json'), 'utf8')).settings.fontSize
  await expect.poll(saved).toBe(15)

  await win.keyboard.press('Meta+Minus')
  await expect.poll(saved).toBe(14)
  await win.keyboard.press('Meta+Digit0')
  await expect.poll(cols).toBe(base)
  await expect.poll(saved).toBe(13)
})

/** ⌘ 와 함께 누른 키를 CDP 로 보낸다 — key 와 code 를 따로 줄 수 있다(한글 입력 상태 흉내) */
async function metaKey(cdp: CDPSession, key: string, code: string, vk: number, extra: Record<string, unknown> = {}) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, modifiers: 4, ...extra })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers: 4 })
}

test('한글 입력 상태의 ⌘T(key 는 ㅅ)도 새 탭', async () => {
  const cdp = await win.context().newCDPSession(win)
  await metaKey(cdp, 'ㅅ', 'KeyT', 84)
  await expect(tabs()).toHaveCount(2)
})

// 입력기 흉내: 글자마다 조합(ㅎ → 하 → 한) 뒤 확정. 실제 macOS 한글 입력기 그대로는 아니다(미확인).
// 확정 직후 같은 순간(1ms 안)에 다른 키가 오면 xterm 이 확정 글자를 setTimeout(0) 뒤에 읽는 사이에 글자가 빠지는 것을
// 한 번 봤다(2026-11-10, CDP 로 연달아 보냄) — 사람이 치는 간격(수십 ms)으로 보낸다.
test('한글 조합 입력이 셸에 그대로 간다 (자모가 새거나 겹치지 않음)', async () => {
  const cdp = await win.context().newCDPSession(win)
  const compose = async (steps: string[], commit: string) => {
    for (const text of steps) await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length })
    await cdp.send('Input.insertText', { text: commit })
    await win.waitForTimeout(30)
  }
  await win.keyboard.type("x='", { delay: 20 })
  await compose(['ㅎ', '하', '한'], '한')
  await compose(['ㄱ', '그', '글'], '글')
  await compose(['ㅇ', '이', '입'], '입')
  await compose(['ㄹ', '려', '력'], '력')
  await win.keyboard.type(`'; echo "<$x>" \${#x}`, { delay: 20 })
  await win.keyboard.press('Enter')
  await waitText('pane-a', /^<한글입력> 4$/m)
  await win.screenshot({ path: 'test-results/keys-hangul.png' })
})

test('대화상자가 열려 있으면 단축키가 뒤의 화면을 바꾸지 않는다', async () => {
  await win.keyboard.press('Meta+KeyN')
  await expect(win.getByRole('dialog')).toBeVisible()
  await win.keyboard.press('Meta+KeyT')
  await win.keyboard.press('Meta+KeyD')
  await win.keyboard.press('Escape')
  await expect(win.getByRole('dialog')).toHaveCount(0)
  await expect(tabs()).toHaveCount(1)
  await expect(slots()).toHaveCount(1)
  await win.keyboard.press('Meta+KeyT') // 닫은 뒤에는 된다
  await expect(tabs()).toHaveCount(2)
})

test('탭 이름을 고치는 중에는 ⌘W · ⌘K 같은 단축키가 뒤의 터미널을 건드리지 않는다', async () => {
  await typeHere('echo KEEP_$((3*3))')
  await waitText('pane-a', /KEEP_9/)
  await tabs().first().getByRole('tab').dblclick()
  const input = win.getByRole('textbox', { name: '탭 이름' })
  await expect(input).toBeFocused()
  await win.keyboard.press('Meta+KeyW')
  await win.keyboard.press('Meta+KeyK')
  await win.keyboard.press('Meta+KeyD')
  await expect(input).toBeFocused()
  await expect(slots()).toHaveCount(1)
  await expect.poll(() => screenOf('pane-a')).toMatch(/KEEP_9/)
  await win.keyboard.press('Escape')
})

test('저장 파일을 읽지 못한 실행에서도 단축키는 된다', async () => {
  await launched!.close()
  launched = undefined
  chmodSync(join(userData, 'state.json'), 0o000) // 읽기 실패 → 이번 실행은 저장하지 않음
  try {
    app = launched = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: userData } })
    win = await firstWindow(app)
    await expect(win.getByTestId('state-notice')).toContainText('읽지 못해')
    await win.keyboard.press('Meta+KeyN')
    await expect(win.getByRole('dialog')).toBeVisible()
  } finally {
    chmodSync(join(userData, 'state.json'), 0o644)
  }
})

test('앱 메뉴: 항목을 누르면 같은 명령, 단축키 표시는 키 표와 같고, 새로 고침은 없다', async () => {
  const info = await app.evaluate(({ Menu }) => {
    const all: Electron.MenuItem[] = []
    const walk = (m: Electron.Menu) => m.items.forEach((i) => (all.push(i), i.submenu && walk(i.submenu)))
    walk(Menu.getApplicationMenu()!)
    const t = Menu.getApplicationMenu()!.getMenuItemById('new-tab')!
    return {
      roles: all.map((i) => i.role ?? ''),
      newTab: { accel: t.accelerator, registered: t.registerAccelerator },
      roleAccels: all.filter((i) => i.role).map((i) => `${i.role}:${i.accelerator ?? ''}`),
      commands: all.filter((i) => i.id && !i.role).map((i) => `${i.id}:${i.accelerator}`),
    }
  })
  // 키 표의 명령(키가 있는 것)이 모두 메뉴에 한 번씩, 같은 단축키로 (표와 메뉴가 따로 놀지 않게) — 키 없는 명령은 ⌘P 에만
  expect([...info.commands].sort()).toEqual(SHORTCUTS.filter((s) => s.accel).map((s) => `${s.command}:${s.accel}`).sort())
  expect(info.roles).not.toContain('reload')
  expect(info.roles).not.toContain('forcereload')
  expect(info.roles).toEqual(expect.arrayContaining(['copy', 'paste', 'close']))
  expect(info.newTab).toEqual({ accel: 'Command+T', registered: false }) // 키는 renderer 가 — 두 번 돌지 않게
  expect(info.roleAccels).toContain('close:Shift+Command+W') // ⌘W 는 창이 아니라 pane

  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('new-tab')!.click())
  await expect(tabs()).toHaveCount(2)
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('split-right')!.click())
  await expect(slots()).toHaveCount(2)
})

test('복사 · 붙여넣기: 선택한 글자가 클립보드로, 클립보드 글자가 셸로', async () => {
  const before = await app.evaluate(({ clipboard }) => clipboard.readText())
  try {
    await typeHere('echo COPY_$((40+2))')
    await waitText('pane-a', /^COPY_42$/m)
    const row = term('pane-a').locator('.xterm-rows > div', { hasText: /^COPY_42\s*$/ })
    const box = (await row.boundingBox())!
    await win.mouse.dblclick(box.x + 10, box.y + box.height / 2) // 낱말 선택
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.copy()) // 편집 > 복사 role 과 같은 일
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('COPY_42')

    await app.evaluate(({ clipboard }) => clipboard.writeText('echo PASTE_$((50+5))'))
    await term('pane-a').click()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.paste())
    await win.keyboard.press('Enter')
    await waitText('pane-a', /^PASTE_55$/m)
  } finally {
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), before) // 사용자 클립보드를 되돌린다
  }
})
