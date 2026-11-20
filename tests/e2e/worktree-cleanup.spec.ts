import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureWindow, firstWindow, runCli, seedState, waitLoaded, type SeedTask } from './helpers'

// 67단계: 병합된 worktree 를 찾아 정리 — 임시 git 저장소(기준 = 로컬 main, 원격 없음) · 임시 userData 로만.
// docs/stages/67-merged-worktree-cleanup.md '돌려야 할 e2e' 1~4 · 6~8 (9 는 기존 worktrees · archive e2e).
// 5(정리 중 이름 바꾸기 · 되살리기)는 겹치는 틈이 lsof 몇십 ms 뿐이라 시험용 대기 지점 없이는 못 쓴다 — 단계 문서에 남김.
// 8 의 200px 사이드바는 따로 두지 않고 좁은 창(320 CSS px) · 200% 로만 본다.
let base: string, repo: string, data: string, wtA: string, wtB: string, wtFresh: string, wtOpen: string
let app: ElectronApplication | undefined, win: Page
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const shots = 'test-results/stacked-e2e'

/** 기본 저장소 + 병합된 worktree 둘(feat-a · feat-b) + 커밋 없는 새 worktree(fresh) + 병합 안 된 worktree(open → 병합 모름) */
function makeRepo(longB = false) {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'tm-e2e-67-')))
  repo = join(base, 'repo'); data = join(base, 'app')
  wtA = join(base, 'wt-a'); wtB = join(base, longB ? 'wt-b-아주-긴-폴더-이름-좁은-창에서-넘치는지-보는-경로-segment-without-breaks-0123456789abcdefghijklmnopqrstuvwxyz' : 'wt-b')
  wtFresh = join(base, 'wt-fresh'); wtOpen = join(base, 'wt-open')
  mkdirSync(repo); mkdirSync(data)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.invalid'); git(repo, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(repo, 'a.txt'), 'a\n'); git(repo, 'add', 'a.txt'); git(repo, 'commit', '-qm', 'initial')
  for (const [path, branch] of [[wtA, 'feat-a'], [wtB, 'feat-b']] as const) {
    git(repo, 'worktree', 'add', '-q', '-b', branch, path, 'main')
    writeFileSync(join(path, `${branch}.txt`), branch + '\n'); git(path, 'add', '.'); git(path, 'commit', '-qm', `${branch} work`)
    git(repo, 'merge', '-q', '--no-ff', '-m', `merge ${branch}`, branch)
  }
  git(repo, 'worktree', 'add', '-q', '-b', 'fresh', wtFresh, 'main')
  git(repo, 'worktree', 'add', '-q', '-b', 'open', wtOpen, 'main')
  writeFileSync(join(wtOpen, 'open.txt'), 'open\n'); git(wtOpen, 'add', '.'); git(wtOpen, 'commit', '-qm', 'open work')
}

async function launch(tasks: SeedTask[], settings: Record<string, unknown> = {}) {
  seedState(data, tasks, [], settings)
  app = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: data } })
  win = await firstWindow(app)
  await waitLoaded(win)
}
const command = (c: string) => app!.evaluate(({ BrowserWindow }, cmd) => BrowserWindow.getAllWindows()[0]!.webContents.send('app:command', cmd), c)
const panel = () => win.getByRole('region', { name: '워크트리 관리', exact: true })
const cleanButton = () => panel().getByRole('button', { name: /^병합된 것 정리…/ })
const preview = () => panel().getByRole('region', { name: '병합된 워크트리 정리', exact: true })
const report = () => panel().getByRole('region', { name: '정리 결과', exact: true })
const reportRow = (path: string) => report().getByRole('listitem').filter({ hasText: path })
const pick = (path: string) => preview().locator('label.worktree-cleanup-item').filter({ hasText: path }).getByRole('checkbox')
const confirmDialog = () => win.getByRole('alertdialog', { name: /^워크트리 \d+개를 정리할까요\?$/ })
const row = (name: string) => win.locator(`[data-testid="task-row"][data-task-name="${name}"]`)
const savedTasks = () => JSON.parse(readFileSync(join(data, 'state.json'), 'utf8')).tasks as Array<{ id: string; name: string; archivedAt?: number }>
const ROOT: SeedTask = { id: 'root', name: '원본', paneId: 'root-pane', cwd: '' }
const LINKED: SeedTask = { id: 'linked', name: '연결', paneId: 'linked-pane', cwd: '' }

/** main 의 worktrees:clean 처리기를 감싸 몇 번 불렸는지 센다(취소 · 닫기는 git 을 부르지 않아야) */
async function countCleanCalls() {
  await app!.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>> })._invokeHandlers
    const original = handlers.get('worktrees:clean')!
    const g = globalThis as unknown as { cleanCalls: number }
    g.cleanCalls = 0
    ipcMain.removeHandler('worktrees:clean')
    ipcMain.handle('worktrees:clean', async (...args) => { g.cleanCalls++; return original(...args) })
  })
}
const cleanCalls = () => app!.evaluate(() => (globalThis as unknown as { cleanCalls: number }).cleanCalls)

test.describe.configure({ timeout: 90_000 })
test.beforeAll(() => mkdirSync(shots, { recursive: true }))
test.afterEach(async () => {
  try { await win?.evaluate(() => { window.taskminal.pty.kill('linked-pane') }) } catch { /* 창이 이미 닫힘 */ }
  await app?.close(); app = undefined
  rmSync(base, { recursive: true, force: true, maxRetries: 5 })
})

test('1: 병합된 worktree 둘(하나는 연결 일감) → 정리… (2) → 고르고 확인 → 정리함 · 폴더 없음 · 브랜치 남음 · 연결 일감은 보관함에', async () => {
  makeRepo()
  await launch([{ ...ROOT, cwd: repo }, { ...LINKED, cwd: wtA }])
  await command('worktrees')
  await expect(cleanButton()).toHaveText('병합된 것 정리… (2)')
  // 패널 카드: 병합됨 · 병합 모름 · 새 브랜치 이유
  await expect(panel().getByRole('article', { name: `feat-a · ${wtA}` })).toContainText('병합됨')
  await expect(panel().getByRole('article', { name: `open · ${wtOpen}` })).toContainText('병합 모름')
  await expect(panel().getByRole('article', { name: `fresh · ${wtFresh}` })).toContainText('만든 뒤 커밋이 없어요')
  await cleanButton().click()
  await expect(preview().getByRole('checkbox')).toHaveCount(2)
  await expect(preview().locator('label.worktree-cleanup-item').filter({ hasText: wtA })).toContainText('함께 보관할 일감: 연결')
  await expect(preview()).toContainText('병합 모름 1개 · 커밋 없는 새 브랜치 1개는 후보가 아니에요')
  await pick(wtA).check(); await pick(wtB).check()
  await preview().getByRole('button', { name: '고른 2개 정리…' }).click()
  await expect(confirmDialog()).toContainText('보관할 일감: 연결')
  await confirmDialog().getByRole('button', { name: '고른 워크트리 정리' }).click()
  await expect(reportRow(wtA)).toContainText('정리함', { timeout: 20_000 })
  await expect(reportRow(wtB)).toContainText('정리함')
  await expect(reportRow(wtA)).toContainText('보관한 일감: 연결')
  expect(existsSync(wtA)).toBe(false); expect(existsSync(wtB)).toBe(false)
  expect(git(repo, 'branch', '--list', 'feat-a', 'feat-b')).toMatch(/feat-a[\s\S]*feat-b/)
  await expect.poll(() => savedTasks().find((t) => t.id === 'linked')?.archivedAt).toBeGreaterThan(0)
  expect(savedTasks().find((t) => t.id === 'root')?.archivedAt).toBeUndefined()
  await win.screenshot({ path: `${shots}/67-1-report.png` })
  await command('archive-open')
  await expect(win.getByTestId('archive-row').filter({ hasText: '연결' })).toBeVisible()
})

test('2: 확인 취소는 git 을 부르지 않고 포커스는 고른 N개 정리…, 미리보기 닫기 · 결과 닫기는 병합된 것 정리… 로', async () => {
  makeRepo()
  await launch([{ ...ROOT, cwd: repo }])
  await command('worktrees')
  await countCleanCalls()
  await expect(cleanButton()).toHaveText('병합된 것 정리… (2)')
  await cleanButton().click()
  await pick(wtB).check()
  await preview().getByRole('button', { name: '고른 1개 정리…' }).click()
  await confirmDialog().getByRole('button', { name: '취소' }).click()
  await expect(confirmDialog()).toHaveCount(0)
  await expect(preview().getByRole('button', { name: '고른 1개 정리…' })).toBeFocused()
  await win.waitForTimeout(1000) // renderer 의 invoke 와 main 을 읽는 evaluate 는 다른 길 — 잘못 불렸다면 이 사이에 세어진다
  expect(await cleanCalls()).toBe(0)
  expect(existsSync(wtB)).toBe(true)
  // 미리보기 닫기 → 패널의 '병합된 것 정리…'
  await preview().getByRole('button', { name: '닫기', exact: true }).click()
  await expect(preview()).toHaveCount(0)
  await expect(cleanButton()).toBeFocused()
  expect(await cleanCalls()).toBe(0)
  // 실제로 정리한 뒤 결과 닫기 → '병합된 것 정리…'
  await cleanButton().click()
  await pick(wtB).check()
  await preview().getByRole('button', { name: '고른 1개 정리…' }).click()
  await confirmDialog().getByRole('button', { name: '고른 워크트리 정리' }).click()
  await expect(reportRow(wtB)).toContainText('정리함', { timeout: 20_000 })
  expect(await cleanCalls()).toBe(1)
  await expect(cleanButton()).toBeEnabled()
  await report().getByRole('button', { name: '결과 닫기' }).click()
  await expect(report()).toHaveCount(0)
  await expect(cleanButton()).toBeFocused()
})

test('3: 확인 대화상자를 연 뒤 그 worktree 에 커밋 → 확인 → 안 함 · 폴더 남음', async () => {
  makeRepo()
  await launch([{ ...ROOT, cwd: repo }])
  await command('worktrees')
  await countCleanCalls()
  await cleanButton().click()
  await pick(wtB).check()
  await preview().getByRole('button', { name: '고른 1개 정리…' }).click()
  await expect(confirmDialog()).toBeVisible()
  git(wtB, 'commit', '-q', '--allow-empty', '-m', 'after confirm opened')
  await confirmDialog().getByRole('button', { name: '고른 워크트리 정리' }).click()
  await expect(reportRow(wtB)).toContainText('안 함', { timeout: 20_000 })
  await expect(reportRow(wtB)).toContainText('바뀌었거나 더 이상 정리 후보가 아니에요')
  expect(existsSync(wtB)).toBe(true)
  expect(git(repo, 'worktree', 'list', '--porcelain')).toContain(wtB)
  // 다시 읽기에서 빠졌으므로 main 에는 요청조차 가지 않는다
  expect(await cleanCalls()).toBe(0)
})

test('4a: 연결 일감의 셸이 살아 있는 채 정리 → 보관이 셸을 끄고 정리됨', async () => {
  makeRepo()
  await launch([{ ...ROOT, cwd: repo }, { ...LINKED, cwd: wtA }])
  // 연결 일감을 한 번 열어 셸을 그 worktree 에서 띄운다
  await row('연결').click()
  await expect.poll(() => win.evaluate(async () => (await window.taskminal.host.sessions()).some((s) => s.paneId === 'linked-pane' && !s.exited)), { timeout: 15_000 }).toBe(true)
  await row('원본').click()
  await command('worktrees')
  await cleanButton().click()
  await pick(wtA).check()
  await preview().getByRole('button', { name: '고른 1개 정리…' }).click()
  await expect(confirmDialog()).toContainText('연결 일감은 셸을 끄고 보관해요')
  const started = Date.now()
  await confirmDialog().getByRole('button', { name: '고른 워크트리 정리' }).click()
  await expect(reportRow(wtA)).toContainText('정리함', { timeout: 20_000 })
  // 셸이 끝나기를 최대 3초 기다리고 39 remove 의 lsof 확인 — 넉넉히 15초 안
  expect(Date.now() - started).toBeLessThan(15_000)
  expect(existsSync(wtA)).toBe(false)
  await expect.poll(() => win.evaluate(async () => (await window.taskminal.host.sessions()).some((s) => s.paneId === 'linked-pane' && !s.exited))).toBe(false)
  await expect.poll(() => savedTasks().find((t) => t.id === 'linked')?.archivedAt).toBeGreaterThan(0)
})

test('4b: 연결 일감에서 명령이 돌면 후보에서 빠지고 이유가 보인다', async () => {
  makeRepo()
  await launch([{ ...ROOT, cwd: repo }, { ...LINKED, cwd: wtA }])
  await row('연결').click()
  const term = win.getByTestId('pane-linked-pane')
  await expect.poll(async () => /%|\$/.test(await term.locator('.xterm-rows').innerText()), { timeout: 15_000 }).toBe(true)
  await term.click()
  await win.keyboard.type('sleep 120')
  await win.keyboard.press('Enter')
  await expect(win.locator('[data-testid="pane-slot"][data-pane-id="linked-pane"]').getByTestId('pane-head')).toHaveAttribute('data-activity', 'running', { timeout: 15_000 })
  await row('원본').click()
  await command('worktrees')
  await expect(cleanButton()).toHaveText('병합된 것 정리… (1)')
  await cleanButton().click()
  await expect(preview().getByRole('checkbox')).toHaveCount(1)
  await expect(pick(wtB)).toBeVisible()
  const excluded = preview().locator('details.worktree-cleanup-excluded')
  await excluded.locator('summary').click()
  await expect(excluded).toContainText(wtA)
  await expect(excluded).toContainText('연결 일감에서 명령이 돌고 있어요')
})

test('6: 읽기 전용 상태에서는 패널이 목록부터 거절해 정리 · 보관이 없고, 오류 글에 IPC 머리가 없다', async () => {
  makeRepo()
  // 더 새 버전이 쓴 state.json → 읽기 전용(빈 상태로 시작) — 일감은 CLI 로 메모리에만 만든다
  writeFileSync(join(data, 'state.json'), JSON.stringify({ version: 999, tasks: [] }))
  app = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: data } })
  win = await firstWindow(app)
  await waitLoaded(win)
  expect((await runCli(data, 'task', 'new', '연결', '--cwd', wtA)).code).toBe(0)
  const made = await runCli(data, 'task', 'new', '원본', '--cwd', repo)
  expect(made.code, made.err).toBe(0)
  expect((await runCli(data, 'task', 'open', '원본')).code).toBe(0)
  await expect(win.locator('[data-testid="task-view"][aria-hidden="false"]')).toHaveAttribute('data-task-name', '원본')
  await command('worktrees')
  // 읽기 전용이면 renderer 가 상태를 main 에 보내지 않아(App canSave) 39 의 폴더 권한 검사가 목록부터 거절한다 —
  // 67 문서가 기대한 '정리 흐름까지 가고 그 줄만 안 함' 에는 닿지 않는다(안전한 쪽). 사용자가 보는 것: 이유 한 줄 · 다시 읽기, 정리 단추는 꺼짐.
  const alert = panel().getByRole('alert')
  await expect(alert).toContainText('현재 로컬 일감 폴더를 확인해 주세요', { timeout: 10_000 })
  await expect(alert).not.toContainText('Error invoking remote method')
  await expect(cleanButton()).toBeDisabled() // 목록(view)이 없으면 꺼져 있다
  expect(existsSync(wtA)).toBe(true)
  await expect(row('연결')).toBeVisible()
  expect(JSON.parse(readFileSync(join(data, 'state.json'), 'utf8')).version).toBe(999)
})

test('7: 패널을 읽은 뒤 연결 일감의 사이드바 · 전체 보기 카드에 병합됨, 그 일감에서 브랜치를 바꾸면 사라짐', async () => {
  makeRepo()
  await launch([{ ...ROOT, cwd: repo }, { ...LINKED, cwd: wtA }])
  await expect(row('연결').getByTestId('task-merge')).toHaveCount(0) // 패널을 읽기 전에는 없음
  await command('worktrees')
  await expect(cleanButton()).toHaveText('병합된 것 정리… (2)')
  await expect(row('연결').getByTestId('task-merge')).toHaveText('병합됨')
  await expect(row('원본').getByTestId('task-merge')).toHaveCount(0)
  await command('overview')
  const card = win.locator('.overview-merge.merged')
  await expect(card).toHaveCount(1)
  await expect(card).toContainText('병합됨')
  await win.screenshot({ path: `${shots}/67-7-chips.png` })
  await win.keyboard.press('Escape')
  git(wtA, 'checkout', '-q', '-b', 'feat-a-next')
  await expect(row('연결').getByTestId('task-merge')).toHaveCount(0, { timeout: 20_000 })
})

for (const theme of ['dark', 'light'] as const) {
  test(`8: 좁은 창 · 200% · ${theme} 에서 미리보기 줄이 넘치지 않고 체크박스가 첫 줄에, 긴 경로는 줄바꿈`, async () => {
    makeRepo(true)
    await launch([{ ...ROOT, cwd: repo }, { ...LINKED, cwd: wtA }], { theme })
    await app!.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]!; w.setSize(640, 400); w.webContents.setZoomFactor(2) })
    await command('worktrees')
    await expect(cleanButton()).toHaveText('병합된 것 정리… (2)')
    await cleanButton().click()
    await expect(preview().getByRole('checkbox')).toHaveCount(2)
    await preview().scrollIntoViewIfNeeded()
    const items = preview().locator('label.worktree-cleanup-item')
    for (let i = 0; i < 2; i++) {
      const g = await items.nth(i).evaluate((label) => {
        const box = (e: Element) => e.getBoundingClientRect()
        const l = box(label), cb = box(label.querySelector('input')!), strong = box(label.querySelector('strong')!)
        const texts = Array.from(label.querySelectorAll('.worktree-cleanup-text > *')).map((e) => ({ cls: e.className, right: box(e).right, sw: (e as HTMLElement).scrollWidth, cw: (e as HTMLElement).clientWidth }))
        return { fits: label.scrollWidth <= label.clientWidth + 1, labelRight: l.right, cbTop: cb.top, cbBottom: cb.bottom, strongTop: strong.top, strongBottom: strong.bottom, texts, viewport: document.documentElement.clientWidth }
      })
      expect(g.fits, JSON.stringify(g)).toBe(true)
      for (const t of g.texts) {
        expect(t.right, JSON.stringify(g)).toBeLessThanOrEqual(g.labelRight + 1)
        expect(t.sw, JSON.stringify(g)).toBeLessThanOrEqual(t.cw + 1)
      }
      // 체크박스가 이름(첫 줄)과 같은 높이에 걸친다 — 여러 줄 묶음의 가운데로 내려가지 않는다
      expect(g.cbTop, JSON.stringify(g)).toBeLessThan(g.strongBottom)
      expect(g.cbBottom, JSON.stringify(g)).toBeGreaterThan(g.strongTop)
      expect(g.labelRight, JSON.stringify(g)).toBeLessThanOrEqual(g.viewport + 1)
    }
    const whole = await win.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)
    expect(whole).toBe(true)
    await captureWindow(app!, `${shots}/67-8-narrow-${theme}.png`)
  })
}
