import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { firstWindow, seedState, waitLoaded } from './helpers'

// 28단계: 화면마다 '같은 왼쪽 끝 · 같은 오른쪽 끝 · 같은 줄 높이' 를 잰다 — 창 폭 3가지(좁게 · 보통 · 넓게).
// 어긋나면 한눈에 안 깔끔해 보이므로 차이는 1px 이하여야 한다(Orca 는 한 칸 폭 변수 하나를 글 · 카드 · 입력이 같이 쓴다).
const FAKE_CLAUDE = resolve(__dirname, '../fixtures/fake-claude.mjs')
const WIDTHS = [900, 1280, 1800]
let userData: string
let app: ElectronApplication | undefined
let win: Page

const view = () => win.locator('[data-testid="task-view"][aria-hidden="false"]')
const chat = () => view().getByTestId('chat-pane')

async function launch(width: number) {
  seedState(userData, [{ id: 'term', name: '터미널 일감', paneId: 'tp', cwd: userData }])
  const file = join(userData, 'state.json')
  const s = JSON.parse(readFileSync(file, 'utf8'))
  s.tasks.unshift({ ...s.tasks[0], id: 'chat', name: '대화 일감', tabs: [{ id: 'ct', layout: { type: 'pane', paneId: 'cp' }, activePaneId: 'cp' }], activeTabId: 'ct', panes: { cp: { id: 'cp', cwd: userData, kind: 'chat', chat: { agent: 'claude' } } } })
  s.activeTaskId = 'chat'
  writeFileSync(file, JSON.stringify(s))
  app = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: userData, TASKMINAL_CLAUDE_BIN: FAKE_CLAUDE } })
  win = await firstWindow(app)
  await waitLoaded(win)
  await app.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0]!.setContentSize(w, 900), width)
  await expect.poll(() => win.evaluate('window.innerWidth')).toBe(width)
}
async function command(c: string) {
  await app!.evaluate(({ BrowserWindow }, cmd) => BrowserWindow.getAllWindows()[0]!.webContents.send('app:command', cmd), c)
}
async function box(l: Locator) {
  const b = await l.boundingBox()
  if (!b) throw new Error(`안 보이는 요소: ${l}`)
  return { left: b.x, right: b.x + b.width, width: b.width, height: b.height }
}
const near = (a: number, b: number, what: string) => expect(Math.abs(a - b), `${what}: ${a} vs ${b}`).toBeLessThanOrEqual(1)

test.describe.configure({ timeout: 120_000 })
test.beforeEach(() => {
  userData = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-e2e-')))
})
test.afterEach(async () => {
  await app?.close()
  app = undefined
  rmSync(userData, { recursive: true, force: true })
})

for (const width of WIDTHS) {
  test(`대화 화면 (${width}px): 머리 · 글 · 도구 카드 · 허락 카드 · 입력이 같은 왼쪽 끝, 말풍선 · 머리 단추 · 입력이 같은 오른쪽 끝`, async () => {
    await launch(width)
    const input = chat().getByTestId('chat-input')
    await input.fill('안녕하세요')
    await input.press('Enter')
    await expect(chat().getByTestId('chat-status')).toContainText('끝남')
    await input.fill('가나다라마바사 '.repeat(40)) // 말풍선 · 글이 줄바꿈될 만큼 길게
    await input.press('Enter')
    await expect(chat().locator('[data-kind="text"]')).toHaveCount(2, { timeout: 15_000 })
    await expect(chat().getByTestId('chat-status')).toContainText('끝남')
    await input.fill('perm 파일 하나 만들어')
    await input.press('Enter')
    await expect(chat().getByTestId('perm-card')).toBeVisible()
    await chat().locator('.chat-tools-head').first().click() // 도구 줄을 펼쳐 안쪽 글도 보인다

    const head = await box(chat().locator('.chat-head > :first-child'))
    const headEnd = await box(chat().locator('.chat-head > :last-child'))
    const text = await box(chat().locator('[data-kind="text"]').first())
    const tools = await box(chat().locator('.chat-tools').first())
    const perm = await box(chat().getByTestId('perm-card'))
    const composer = await box(chat().locator('.chat-composer'))
    const bubble = await box(chat().locator('.chat-user').last())
    // 왼쪽 끝: 머리 · 글 · 도구 카드 · 허락 카드 · 입력 카드
    for (const [name, b] of Object.entries({ 머리: head, 도구: tools, 허락: perm, 입력: composer })) near(b.left, text.left, `${name} 왼쪽`)
    // 오른쪽 끝: 말풍선 · 머리 끝 단추 · 도구 · 허락 · 입력 카드
    for (const [name, b] of Object.entries({ 머리끝: headEnd, 도구: tools, 허락: perm, 입력: composer })) near(b.right, bubble.right, `${name} 오른쪽`)
    // 글 칸은 최대 760px 가운데 — 입력 카드 폭이 카드 폭과 같다
    expect(composer.width).toBeLessThanOrEqual(760 + 1)
    near(composer.width, tools.width, '입력 카드 폭')
    // 안쪽 글: 허락 카드의 명령 글과 입력 칸의 글이 같은 안쪽 여백
    const cmd = await box(chat().locator('.chat-card-cmd'))
    const typed = await box(chat().locator('.chat-input-row > :first-child'))
    near(cmd.left - perm.left, typed.left - composer.left, '카드 안쪽 여백')
  })
}

test('머리 줄 높이: 사이드바 머리 · 탭 줄 · 대화 머리 · 설정 머리가 모두 같다', async () => {
  await launch(1280)
  const heights = [await box(win.locator('.sidebar-head')), await box(view().getByTestId('tab-bar')), await box(chat().locator('.chat-head'))].map((b) => b.height)
  for (const h of heights) near(h, 40, '머리 줄 높이')
  await command('settings')
  near((await box(win.locator('.settings-head'))).height, 40, '설정 머리 높이')
  // 설정 왼쪽 칸 항목은 모두 같은 줄 높이
  const items = win.getByRole('navigation', { name: '설정 칸' }).locator('.settings-nav-item')
  const n = await items.count()
  expect(n).toBeGreaterThan(5)
  for (let i = 0; i < n; i++) near((await box(items.nth(i))).height, 36, `설정 칸 ${i} 높이`)
})

for (const width of WIDTHS) {
  test(`설정 (${width}px): 머리 글 · 칸 제목 · 묶음 제목 · 카드가 같은 왼쪽 끝, 한 줄짜리 설정 줄은 높이가 같다`, async () => {
    await launch(width)
    await command('settings')
    const body = win.getByTestId('settings-body')
    await expect(body).toBeVisible()
    const crumbs = await box(win.locator('.settings-crumbs'))
    const h1 = await box(body.locator('h1'))
    const groupTitle = await box(body.locator('.setting-group-title').first())
    const card = await box(body.locator('.setting-card').first())
    for (const [name, b] of Object.entries({ 머리글: crumbs, 칸제목: h1, 묶음제목: groupTitle, 카드: card })) near(b.left, h1.left, `${name} 왼쪽`)
    expect(card.width).toBeLessThanOrEqual(720 + 1)
    // 터미널 칸: 설명 없는 한 줄 설정 줄(커서 깜빡임 등)은 모두 같은 높이
    await win.getByRole('navigation', { name: '설정 칸' }).getByRole('button', { name: '터미널' }).click()
    const plain = body.locator('.setting-row:not(:has(.setting-desc)):not(:has(.choices))')
    const k = await plain.count()
    expect(k).toBeGreaterThan(0)
    for (let i = 0; i < k; i++) near((await box(plain.nth(i))).height, 48, `설정 줄 ${i} 높이`)
  })
}

test('설정 찾기 ‘커서’: 줄이 없는 묶음 제목 · 절 제목은 보이지 않고, 보이는 묶음 · 절에는 줄이 있다 (28c 리뷰)', async () => {
  await launch(1280)
  await command('settings')
  await expect(win.getByRole('searchbox', { name: '설정 찾기' })).toBeFocused()
  await win.keyboard.type('커서')
  const body = win.getByTestId('settings-body')
  await expect(body.locator('.setting-row')).toHaveCount(2)
  // 보이는 것(상자가 있는 것)만 센다 — 숨김 규칙이 다시 계산되지 않으면 줄 없는 묶음 제목이 남는다(28b 의 :has 함정)
  const seen = await body.evaluate((root) => {
    const shown = (el: Element | null) => !!el && el.getClientRects().length > 0
    const of = (sel: string, title: string) =>
      Array.from(root.querySelectorAll(sel)).map((el) => ({ title: el.querySelector(title)?.textContent ?? '', shown: shown(el.querySelector(title) ?? el), rows: el.querySelectorAll('.setting-row').length }))
    return { groups: of('.setting-group', '.setting-group-title'), sections: of('.settings-section', '.settings-section-title') }
  })
  for (const g of [...seen.groups, ...seen.sections]) expect(g.shown, `‘${g.title}’ 줄 ${g.rows}개`).toBe(g.rows > 0)
  expect(seen.groups.filter((g) => g.rows === 0).length, '줄이 빠진 묶음이 있어야 시험이 뜻이 있다').toBeGreaterThan(0)
  expect(seen.sections.filter((g) => g.rows === 0).length, '줄이 빠진 절이 있어야 시험이 뜻이 있다').toBeGreaterThan(0)
  await expect(body.getByRole('heading', { level: 3, name: '커서', exact: true })).toBeVisible()
  await expect(body.getByRole('heading', { level: 3, name: '스크롤', exact: true })).toBeHidden()
  await expect(body.getByRole('heading', { level: 2, name: '터미널', exact: true })).toBeVisible()
  await expect(body.getByRole('heading', { level: 2, name: '알림 · 활동', exact: true })).toBeHidden()
})

test('팔레트: 긴 목록에서 ↓ 로 내려갔다가 ↑ 로 묶음 첫 줄에 돌아오면 그 위 제목 줄도 보인다 (28c 리뷰)', async () => {
  await launch(1280)
  await command('palette')
  await expect(win.getByTestId('palette')).toBeVisible()
  const list = win.locator('#palette-list')
  const items = win.getByTestId('palette-item')
  const kinds = await items.evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')))
  const firstCmd = kinds.indexOf('command')
  expect(firstCmd).toBeGreaterThan(0) // 일감 묶음 뒤에 명령 묶음
  const deep = 15
  expect(kinds.length).toBeGreaterThan(firstCmd + deep)
  const headingShown = (i: number) =>
    list.evaluate((ul, idx) => {
      const h = document.getElementById(`palette-option-${idx}`)!.previousElementSibling!
      const a = h.getBoundingClientRect()
      const b = ul.getBoundingClientRect()
      return h.classList.contains('palette-group') && a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5
    }, i)
  for (let i = 0; i < firstCmd + deep; i++) await win.keyboard.press('ArrowDown')
  await expect.poll(() => list.evaluate((ul) => ul.scrollTop)).toBeGreaterThan(0) // 목록이 실제로 내려갔다
  for (let i = 0; i < deep; i++) await win.keyboard.press('ArrowUp')
  await expect(win.locator(`#palette-option-${firstCmd}`)).toHaveAttribute('aria-selected', 'true')
  await expect.poll(() => headingShown(firstCmd), '명령 묶음 제목').toBe(true)
  // 맨 위 묶음(일감)의 첫 줄로 돌아와도 제목이 보인다
  for (let i = 0; i < firstCmd; i++) await win.keyboard.press('ArrowUp')
  await expect(win.locator('#palette-option-0')).toHaveAttribute('aria-selected', 'true')
  await expect.poll(() => headingShown(0), '일감 묶음 제목').toBe(true)
})

test('팔레트: 결과 줄 높이가 같고, 종류 제목 줄은 ↑↓ 로 고를 수 없다', async () => {
  await launch(1280)
  await command('palette')
  await expect(win.getByTestId('palette')).toBeVisible()
  await expect(win.locator('.palette-group').first()).toBeVisible()
  const items = win.getByTestId('palette-item')
  const n = await items.count()
  expect(n).toBeGreaterThan(3)
  const first = (await box(items.first())).height
  for (let i = 1; i < n; i++) near((await box(items.nth(i))).height, first, `팔레트 줄 ${i} 높이`)
  near(first, 36, '팔레트 줄 높이')
  // ↓ 를 줄 수보다 많이 눌러도 고른 줄은 늘 항목 하나(제목은 option 이 아니다)
  for (let i = 0; i < n + 2; i++) {
    await win.keyboard.press('ArrowDown')
    await expect(win.locator('[role="option"][aria-selected="true"]')).toHaveCount(1)
  }
  await expect(win.locator('.palette-group[aria-selected]')).toHaveCount(0)
  await expect(win.locator('#palette-list [role="option"]')).toHaveCount(n) // 제목 줄은 option 이 아니다
})
