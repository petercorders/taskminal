import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { captureWindow, firstWindow, runCli, seedState, taskJson, visibleTextProblems, type SeedTask } from './helpers'

// 70단계: 저장소째 가져오기 — 임시 git 저장소 · 가짜 세션 기록(TASKMINAL_AGENT_SESSIONS_HOME) · 가짜 claude/TUI · 임시 userData 로만.
// 폴더 고르기 대화상자는 main 의 dialog.showOpenDialog 를 시험용으로 바꿔 끼운다.
// docs/stages/70-import-repo-worktrees.md '돌려야 할 e2e' 1~5 · 7~10 (6 은 기존 worktrees e2e).
const FAKE = resolve(__dirname, '../fixtures/fake-claude.mjs')
const shots = 'test-results/stacked-e2e'
const C1 = 'aaaaaaaa-1111-4111-8111-111111111111'
const X1 = 'bbbbbbbb-2222-4222-8222-222222222222'
const C2 = 'cccccccc-3333-4333-8333-333333333333'
const OLD = 'dddddddd-4444-4444-8444-444444444444'
let base: string, data: string, repo: string, home: string, log: string
let wtFeat: string, wtLocked: string, wtMerged: string, wtGone: string
let app: ElectronApplication | undefined, win: Page
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const jsonl = (...rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n'

function claudeSession(id: string, cwd: string, text: string, mtime: number) {
  const dir = join(home, '.claude', 'projects', '-fake-project')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${id}.jsonl`)
  writeFileSync(path, jsonl({ type: 'session-owner', sessionId: id }, { type: 'user', cwd, sessionId: id, timestamp: '2026-11-01T00:00:00.000Z', message: { role: 'user', content: text } }))
  utimesSync(path, mtime, mtime)
}
function codexSession(id: string, cwd: string, text: string, mtime: number) {
  const dir = join(home, '.codex', 'sessions', '2026', '11', '01')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `rollout-2026-11-01T00-00-00-${id}.jsonl`)
  writeFileSync(path, jsonl({ type: 'session_meta', payload: { id, cwd, timestamp: '2026-11-01T00:00:00.000Z', source: 'cli' } }, { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }))
  utimesSync(path, mtime, mtime)
}

/** 기본(main) + feat(진행 중) · locked-b(잠김) · merged-b(병합됨) · gone-b(폴더 지움 → 등록 복구 필요) */
function makeRepo(extra = 0) {
  repo = join(base, 'repo')
  wtFeat = join(base, 'wt-feat'); wtLocked = join(base, 'wt-locked'); wtMerged = join(base, 'wt-merged'); wtGone = join(base, 'wt-gone')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.invalid'); git(repo, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(repo, 'a.ts'), 'export const a = 1\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'initial')
  const add = (path: string, branch: string) => {
    git(repo, 'worktree', 'add', '-q', '-b', branch, path, 'main')
    writeFileSync(join(path, `${branch}.txt`), branch + '\n'); git(path, 'add', '.'); git(path, 'commit', '-qm', `${branch} work`)
  }
  add(wtFeat, 'feat'); add(wtLocked, 'locked-b'); add(wtMerged, 'merged-b'); add(wtGone, 'gone-b')
  git(repo, 'merge', '-q', '--no-ff', '-m', 'merge merged-b', 'merged-b')
  git(repo, 'worktree', 'lock', '--reason', 'e2e 잠금', wtLocked)
  rmSync(wtGone, { recursive: true, force: true })
  for (let i = 0; i < extra; i++) add(join(base, `wt-extra-${i}`), `extra-${i}`)
}
async function launch(tasks: SeedTask[], settings: Record<string, unknown> = {}, seed = true) {
  if (seed) seedState(data, tasks, [], settings)
  const tui = join(base, 'agent-tui')
  writeFileSync(tui, '#!/bin/sh\necho "FAKE-TUI $*"\n'); chmodSync(tui, 0o755)
  app = await electron.launch({
    args: ['.'],
    env: { ...process.env, TASKMINAL_USER_DATA: data, TASKMINAL_AGENT_SESSIONS_HOME: home, TASKMINAL_CLAUDE_BIN: FAKE, FAKE_CLAUDE_LOG: log, TASKMINAL_CLAUDE_TUI: tui, TASKMINAL_CODEX_TUI: tui },
  })
  win = await firstWindow(app)
  // helpers.waitLoaded 는 첫 task-view 를 본다 — 다시 열 때 활성 일감이 첫째가 아닐 수 있어 보이는 task-view 를 기다린다
  await expect(win.locator('[data-testid="task-view"][aria-hidden="false"], [data-testid="empty-view"]').first()).toBeVisible({ timeout: 20_000 })
}
/** 폴더 고르기 대화상자 대신 — 고른 폴더(없으면 취소) */
async function pickFolder(path: string | null) {
  await app!.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => (p ? { canceled: false, filePaths: [p] } : { canceled: true, filePaths: [] })) as typeof dialog.showOpenDialog
  }, path)
}
/** main 의 미리보기 처리기를 감싼다 — n 번째 부름부터 release() 까지 붙잡는다(누를 때 다시 읽기) */
async function holdPreviewFrom(n: number) {
  await app!.evaluate(({ ipcMain }, from) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>> })._invokeHandlers
    const original = handlers.get('worktrees:importPreview')!
    const g = globalThis as unknown as { previewCalls: number; releasePreview: () => void; gate: Promise<void> }
    g.previewCalls = 0
    g.gate = new Promise<void>((r) => (g.releasePreview = r))
    ipcMain.removeHandler('worktrees:importPreview')
    ipcMain.handle('worktrees:importPreview', async (...args) => { if (++g.previewCalls >= from) await g.gate; return original(...args) })
  }, n)
}
const previewCalls = () => app!.evaluate(() => (globalThis as unknown as { previewCalls: number }).previewCalls)
const releasePreview = () => app!.evaluate(() => (globalThis as unknown as { releasePreview: () => void }).releasePreview())
const command = (c: string) => app!.evaluate(({ BrowserWindow }, cmd) => BrowserWindow.getAllWindows()[0]!.webContents.send('app:command', cmd), c)
const dialog = () => win.getByRole('dialog', { name: '저장소째 가져오기' })
const importRow = (path: string) => dialog().locator('label.repo-import-row').filter({ has: win.locator('.repo-import-path', { hasText: new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) })
const runButton = () => dialog().getByRole('button', { name: /^고른 \d+개 가져오기$/ })
const view = () => win.locator('[data-testid="task-view"][aria-hidden="false"]')
const row = (name: string) => win.locator(`li[data-task-name="${name}"]`).first()
type Saved = { id: string; name: string; cwd: string; groupId: string | null; sessionHints?: Array<{ agent: string; id: string }> }
const savedState = () => JSON.parse(readFileSync(join(data, 'state.json'), 'utf8')) as { tasks: Saved[]; settings: { groups: Array<{ id: string; name: string }> }; activeTaskId: string }
const argvs = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { argv?: string[]; cwd?: string }).filter((l) => l.argv) : [])
const VIEWER: SeedTask = { id: 'viewer', name: '보던 일감', paneId: 'v-pane', cwd: '' }

/** 새 일감 대화상자 › 저장소째 가져오기… → (바꿔 낀) 고르기 → 미리보기 */
async function openFromNewTask(folder: string) {
  await pickFolder(folder)
  await command('new-task')
  const newTask = win.getByRole('dialog')
  await newTask.getByRole('button', { name: '저장소째 가져오기…' }).click()
  await expect(dialog()).toBeVisible()
  await expect(dialog().getByRole('group', { name: '가져올 worktree 고르기' })).toBeVisible({ timeout: 20_000 })
}

test.describe.configure({ timeout: 120_000 })
test.beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'tm-e2e-70-')))
  data = join(base, 'app'); home = join(base, 'agent-home'); log = join(base, 'fake-claude.log')
  mkdirSync(data); mkdirSync(home)
  mkdirSync(shots, { recursive: true })
})
test.afterEach(async () => {
  await app?.close(); app = undefined
  rmSync(base, { recursive: true, force: true, maxRetries: 5 })
})

test('1: 새 일감 › 저장소째 가져오기 → 미리보기(기본 · 잠김 · 병합됨 · 막힌 줄) → 고른 것만 일감 · 묶음 · 첫 일감 선택 · 결과, 다시 열면 이미 일감 있음', async () => {
  makeRepo()
  await launch([{ ...VIEWER, cwd: base }])
  await openFromNewTask(repo)
  await expect(dialog()).toContainText(`저장소: ${repo}`)
  await expect(dialog()).toContainText("새 묶음 ‘repo’에 넣어요")
  await expect(importRow(repo)).toContainText('기본')
  await expect(importRow(wtLocked)).toContainText('잠김')
  await expect(importRow(wtMerged).locator('.repo-import-chip.merged')).toHaveText('병합됨')
  await expect(importRow(wtGone)).toContainText('가져올 수 없어요')
  await expect(importRow(wtGone).getByRole('checkbox')).toBeDisabled()
  // 기본 고름: 가져올 수 있고 · 일감 없고 · 병합됨 아님
  await expect(importRow(repo).getByRole('checkbox')).toBeChecked()
  await expect(importRow(wtFeat).getByRole('checkbox')).toBeChecked()
  await expect(importRow(wtLocked).getByRole('checkbox')).toBeChecked()
  await expect(importRow(wtMerged).getByRole('checkbox')).not.toBeChecked()
  await expect(runButton()).toHaveText('고른 3개 가져오기')
  await win.screenshot({ path: `${shots}/70-1-preview.png` })
  await importRow(repo).getByRole('checkbox').uncheck()
  await runButton().click()
  const report = dialog().getByRole('region', { name: '가져오기 결과' })
  await expect(dialog().getByRole('status')).toContainText("2개 일감을 만들었어요 — 묶음 ‘repo’")
  await expect(report).toContainText(wtFeat)
  await expect(report).toContainText(wtLocked)
  await expect(dialog().getByRole('button', { name: '닫기' })).toBeFocused()
  await dialog().getByRole('button', { name: '닫기' }).click()
  await expect(dialog()).toHaveCount(0)
  await expect(view()).toHaveAttribute('data-task-name', 'feat')
  await expect.poll(() => savedState().tasks.map((t) => t.name).sort()).toEqual(['feat', 'locked-b', '보던 일감'])
  const s = savedState()
  const group = s.settings.groups.find((g) => g.name === 'repo')!
  expect(group).toBeTruthy()
  expect(s.tasks.filter((t) => t.groupId === group.id).map((t) => t.cwd).sort()).toEqual([wtFeat, wtLocked].sort())
  // 같은 저장소를 다시 → 가져온 줄은 '이미 일감 있음' · 고를 수 없음
  await openFromNewTask(repo)
  await expect(importRow(wtFeat)).toContainText('이미 일감 있음 — feat')
  await expect(importRow(wtFeat).getByRole('checkbox')).toBeDisabled()
  await expect(importRow(wtLocked)).toContainText('이미 일감 있음 — locked-b')
  await expect(dialog()).toContainText("있는 묶음 ‘repo’에 넣어요")
})

test('2: 워크트리 패널 › 이 저장소째 가져오기 → 패널을 연 일감의 줄은 이미 일감 있음 · 끈 체크박스, 닫으면 포커스가 그 단추로', async () => {
  makeRepo()
  await launch([{ id: 'root', name: '원본', paneId: 'root-pane', cwd: repo }])
  await command('worktrees')
  const trigger = win.getByRole('region', { name: '워크트리 관리', exact: true }).getByRole('button', { name: '이 저장소째 가져오기…' })
  await trigger.click()
  await expect(dialog().getByRole('group', { name: '가져올 worktree 고르기' })).toBeVisible({ timeout: 20_000 })
  await expect(importRow(repo)).toContainText('이미 일감 있음 — 원본')
  await expect(importRow(repo).getByRole('checkbox')).toBeDisabled()
  await expect(importRow(repo).getByRole('checkbox')).not.toBeChecked()
  await expect(importRow(wtFeat).getByRole('checkbox')).toBeChecked()
  await dialog().getByRole('button', { name: '닫기', exact: true }).click()
  await expect(dialog()).toHaveCount(0)
  await expect(trigger).toBeFocused()
})

test('3a: 미리보기를 연 채 worktree 폴더를 지움 → 결과에 미리보기 뒤 바뀌었어요 · 그 일감 없음', async () => {
  makeRepo()
  await launch([{ ...VIEWER, cwd: base }])
  await openFromNewTask(repo)
  await importRow(repo).getByRole('checkbox').uncheck()
  await importRow(wtLocked).getByRole('checkbox').uncheck()
  await expect(runButton()).toHaveText('고른 1개 가져오기')
  rmSync(wtFeat, { recursive: true, force: true })
  await runButton().click()
  const report = dialog().getByRole('region', { name: '가져오기 결과' })
  await expect(report).toContainText(wtFeat)
  await expect(report).toContainText('미리보기 뒤')
  await expect(report).toContainText('만들지 않았어요')
  await expect(dialog().getByRole('status')).toContainText('0개 일감을 만들었어요')
  await win.waitForTimeout(500)
  expect(savedState().tasks.map((t) => t.name)).toEqual(['보던 일감'])
})

test('3b: 가져오는 중(누를 때 다시 읽기)에 Esc → 닫히고 일감을 만들지 않는다', async () => {
  makeRepo()
  await launch([{ ...VIEWER, cwd: base }])
  await holdPreviewFrom(2)
  await openFromNewTask(repo)
  await runButton().click()
  await expect(dialog().getByRole('status')).toContainText('지금 닫으면 만들지 않아요')
  await expect.poll(previewCalls).toBe(2)
  await win.keyboard.press('Escape')
  await expect(dialog()).toHaveCount(0)
  await releasePreview()
  await win.waitForTimeout(1500) // 늦게 온 다시 읽기의 답이 일감을 만들지 않는지 — 나타나지 않아야 하는 것을 보는 자리
  await expect(row('feat')).toHaveCount(0)
  expect(savedState().tasks.map((t) => t.name)).toEqual(['보던 일감'])
})

test('4: 세션 기록이 있는 worktree 를 가져옴 → 머리 띠 → 대화로 이어 하기 · 터미널로 · 닫기(다시 열어도 없음)', async () => {
  makeRepo()
  const now = Math.floor(Date.now() / 1000)
  claudeSession(C1, wtFeat, '가짜 feat 결제 고치기', now - 120)
  codexSession(X1, wtFeat, '가짜 feat 코덱스 시험', now - 3600)
  claudeSession(C2, wtLocked, '가짜 잠긴 폴더 세션', now - 60)
  await launch([{ ...VIEWER, cwd: base }])
  await openFromNewTask(repo)
  await expect(importRow(wtFeat)).toContainText('가짜 feat 결제 고치기')
  await expect(importRow(wtFeat)).toContainText('가짜 feat 코덱스 시험')
  await importRow(repo).getByRole('checkbox').uncheck()
  await runButton().click()
  await expect(dialog().getByRole('region', { name: '가져오기 결과' })).toContainText('이어 하기 후보 2개')
  await dialog().getByRole('button', { name: '닫기' }).click()
  await expect(view()).toHaveAttribute('data-task-name', 'feat')
  const band = view().getByRole('region', { name: '이 폴더에서 하던 세션' })
  await expect(band).toBeVisible()
  await expect(band.locator('li.session-hint')).toHaveCount(2)
  // 자동으로 시작하지 않는다
  expect(argvs()).toHaveLength(0)
  await win.screenshot({ path: `${shots}/70-4-band.png` })
  await band.getByRole('button', { name: '대화로 이어 하기: 가짜 feat 결제 고치기' }).click()
  const chat = view().locator('[data-testid="chat-pane"]:visible')
  await expect(chat).toHaveCount(1)
  await expect(band.locator('li.session-hint')).toHaveCount(1)
  await expect(band.locator('li.session-hint')).toHaveAttribute('data-agent', 'codex')
  await chat.getByTestId('chat-input').fill('이어서')
  await chat.getByTestId('chat-input').press('Enter')
  await expect.poll(() => argvs().at(-1)?.argv?.join(' ')).toContain(`--resume ${C1}`)
  expect(argvs().at(-1)?.cwd).toBe(wtFeat)
  await band.getByRole('button', { name: '터미널로 이어 하기: 가짜 feat 코덱스 시험' }).click()
  const term = view().locator('[data-testid="tab-view"]:visible .xterm-rows')
  await expect(term).toContainText(`FAKE-TUI resume ${X1}`, { timeout: 15_000 })
  await expect(view().getByRole('region', { name: '이 폴더에서 하던 세션' })).toHaveCount(0)
  // 닫기: 다른 가져온 일감의 띠
  await row('locked-b').click()
  await expect(view()).toHaveAttribute('data-task-name', 'locked-b')
  const band2 = view().getByRole('region', { name: '이 폴더에서 하던 세션' })
  await expect(band2).toContainText('가짜 잠긴 폴더 세션')
  await band2.getByRole('button', { name: '이어 하기 후보 닫기' }).click()
  await expect(view().getByRole('region', { name: '이 폴더에서 하던 세션' })).toHaveCount(0)
  await expect.poll(() => savedState().tasks.find((t) => t.name === 'locked-b')?.sessionHints ?? []).toEqual([])
  await app!.close(); app = undefined
  await launch([], {}, false)
  await row('locked-b').click()
  await expect(view()).toHaveAttribute('data-task-name', 'locked-b')
  await expect(view().getByRole('region', { name: '이 폴더에서 하던 세션' })).toHaveCount(0)
})

for (const theme of ['dark', 'light'] as const) {
  test(`5: 좁은 창 · 200% · ${theme} — 가져오기 줄 · 새 일감 아래 줄 단추 셋이 넘치지 않고 목록만 스크롤`, async () => {
    makeRepo(6)
    await launch([{ ...VIEWER, cwd: base }], { theme })
    await app!.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]!; w.setSize(640, 400); w.webContents.setZoomFactor(2) })
    await expect.poll(() => win.evaluate(() => document.documentElement.clientWidth)).toBeLessThanOrEqual(330)
    // 새 일감 대화상자 아래 줄: 단추 셋이 대화상자 안(넘치면 줄을 넘김)
    await pickFolder(repo)
    await command('new-task')
    const newTask = win.getByRole('dialog')
    const footer = newTask.locator('footer.dialog-actions')
    await footer.scrollIntoViewIfNeeded()
    const f = await footer.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const buttons = Array.from(el.querySelectorAll('button')).map((b) => { const x = b.getBoundingClientRect(); return { text: b.textContent, left: x.left, right: x.right, sw: b.scrollWidth, cw: b.clientWidth } })
      return { left: r.left, right: r.right, fits: el.scrollWidth <= el.clientWidth + 1, buttons, vw: document.documentElement.clientWidth }
    })
    expect(f.buttons.length, JSON.stringify(f)).toBe(3)
    expect(f.fits, JSON.stringify(f)).toBe(true)
    for (const b of f.buttons) {
      expect(b.left, JSON.stringify(f)).toBeGreaterThanOrEqual(f.left - 1)
      expect(b.right, JSON.stringify(f)).toBeLessThanOrEqual(f.right + 1)
      expect(b.right, JSON.stringify(f)).toBeLessThanOrEqual(f.vw + 1)
      expect(b.sw, JSON.stringify(f)).toBeLessThanOrEqual(b.cw + 1) // 단추 글자가 단추 밖으로 나가지 않음
    }
    await captureWindow(app!, `${shots}/70-5-newtask-${theme}.png`)
    await newTask.getByRole('button', { name: '저장소째 가져오기…' }).click()
    await expect(dialog().getByRole('group', { name: '가져올 worktree 고르기' })).toBeVisible({ timeout: 20_000 })
    const list = dialog().locator('fieldset.repo-import-list')
    const g = await list.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const rows = Array.from(el.querySelectorAll('label.repo-import-row')).map((row) => {
        const rr = row.getBoundingClientRect()
        const inner = Array.from(row.querySelectorAll('.repo-import-path, .repo-import-meta, .repo-import-head')).map((x) => ({ right: x.getBoundingClientRect().right, sw: (x as HTMLElement).scrollWidth, cw: (x as HTMLElement).clientWidth }))
        return { right: rr.right, fits: row.scrollWidth <= row.clientWidth + 1, inner }
      })
      const firstRow = (el.querySelector('label.repo-import-row') as HTMLElement).offsetHeight
      return { right: r.right, overflowY: getComputedStyle(el).overflowY, scrolls: el.scrollHeight > el.clientHeight, fitsX: el.scrollWidth <= el.clientWidth + 1, rows, vw: document.documentElement.clientWidth, firstRow, height: el.clientHeight }
    })
    expect(g.fitsX, JSON.stringify(g)).toBe(true)
    expect(g.height, JSON.stringify(g)).toBeGreaterThanOrEqual(g.firstRow) // 낮은 창에서도 목록이 눌려 줄이 단추 밑으로 새지 않음
    expect(g.right, JSON.stringify(g)).toBeLessThanOrEqual(g.vw + 1)
    expect(['auto', 'scroll']).toContain(g.overflowY)
    expect(g.scrolls, JSON.stringify(g)).toBe(true) // worktree 11개 — 목록만 스크롤
    for (const r of g.rows) {
      expect(r.fits, JSON.stringify(r)).toBe(true)
      for (const x of r.inner) {
        expect(x.right, JSON.stringify(r)).toBeLessThanOrEqual(r.right + 1)
        expect(x.sw, JSON.stringify(r)).toBeLessThanOrEqual(x.cw + 1)
      }
    }
    // 상자가 아니라 사용자가 보는 글자 — 줄이 목록 밖(단추 밑)에 그려지거나 덮이지 않음. PR #24 에서 상자 단정은 이 버그에도 통과했다
    expect(await visibleTextProblems(list)).toEqual([])
    // 가져오기 단추는 목록이 길어도 닿는다
    await runButton().scrollIntoViewIfNeeded()
    await expect(runButton()).toBeInViewport()
    // 가져오기 대화상자 아래 줄: 단추 글자가 꺾이지 않고(한 줄 높이) 대화상자 안 · 목록과 겹치지 않음
    const actions = await dialog().locator('footer.dialog-actions').evaluate((el) => {
      const r = el.getBoundingClientRect()
      const listBottom = el.parentElement!.querySelector('fieldset.repo-import-list')!.getBoundingClientRect().bottom
      const buttons = Array.from(el.querySelectorAll('button')).map((btn) => {
        const x = btn.getBoundingClientRect()
        const lh = parseFloat(getComputedStyle(btn).lineHeight) || parseFloat(getComputedStyle(btn).fontSize) * 1.5
        const range = document.createRange()
        range.selectNodeContents(btn)
        return { text: btn.textContent, left: x.left, right: x.right, lines: range.getClientRects().length, textH: range.getBoundingClientRect().height, lh }
      })
      return { left: r.left, right: r.right, top: r.top, listBottom, buttons }
    })
    expect(actions.top, JSON.stringify(actions)).toBeGreaterThanOrEqual(actions.listBottom - 1)
    for (const b of actions.buttons) {
      expect(b.left, JSON.stringify(b)).toBeGreaterThanOrEqual(actions.left - 1)
      expect(b.right, JSON.stringify(b)).toBeLessThanOrEqual(actions.right + 1)
      expect(b.textH, JSON.stringify(b)).toBeLessThan(b.lh * 1.5) // 글자가 두 줄 이상으로 꺾이지 않음
    }
    expect(await visibleTextProblems(dialog().locator('footer.dialog-actions'))).toEqual([])
    await captureWindow(app!, `${shots}/70-5-import-${theme}.png`)
  })
}

test('7: worktree 안쪽 폴더를 쓰는 일감이 있으면 그 줄에 안내 · 기본으로 안 고름 · 골라서 가져오면 만들어짐', async () => {
  makeRepo()
  mkdirSync(join(wtFeat, 'packages', 'app'), { recursive: true })
  await launch([{ ...VIEWER, cwd: base }, { id: 'inner', name: '안쪽 일감', paneId: 'inner-pane', cwd: join(wtFeat, 'packages', 'app') }])
  await openFromNewTask(repo)
  await expect(importRow(wtFeat)).toContainText('이 폴더 안쪽을 쓰는 일감이 있어요 — 안쪽 일감')
  await expect(importRow(wtFeat).getByRole('checkbox')).toBeEnabled()
  await expect(importRow(wtFeat).getByRole('checkbox')).not.toBeChecked()
  await importRow(repo).getByRole('checkbox').uncheck()
  await importRow(wtLocked).getByRole('checkbox').uncheck()
  await importRow(wtFeat).getByRole('checkbox').check()
  await expect(runButton()).toHaveText('고른 1개 가져오기')
  await runButton().click()
  await expect(dialog().getByRole('status')).toContainText('1개 일감을 만들었어요')
  await expect.poll(() => savedState().tasks.find((t) => t.name === 'feat')?.cwd).toBe(wtFeat)
})

test('8: 53 패널에서 같은 세션을 여는 중에 띠의 대화로 이어 하기 → 후보가 남고 안내 · 끝난 뒤 다시 누르면 그 대화로 옮기며 후보가 사라짐', async () => {
  makeRepo()
  const now = Math.floor(Date.now() / 1000)
  claudeSession(C1, wtFeat, '가짜 feat 결제 고치기', now - 120)
  await launch([{ ...VIEWER, cwd: base }])
  await openFromNewTask(repo)
  await importRow(repo).getByRole('checkbox').uncheck()
  await importRow(wtLocked).getByRole('checkbox').uncheck()
  await runButton().click()
  await expect(dialog().getByRole('status')).toContainText('1개 일감을 만들었어요')
  await dialog().getByRole('button', { name: '닫기' }).click()
  await expect(view()).toHaveAttribute('data-task-name', 'feat')
  // main 의 세션 열기를 붙잡는다 — 53 패널의 이어 하기가 도는 중으로 남게
  await app!.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>> })._invokeHandlers
    const original = handlers.get('agent-sessions:open')!
    const g = globalThis as unknown as { releaseOpen: () => void }
    const gate = new Promise<void>((r) => (g.releaseOpen = r))
    ipcMain.removeHandler('agent-sessions:open')
    ipcMain.handle('agent-sessions:open', async (...args) => { await gate; return original(...args) })
  })
  await command('agent-sessions')
  const sessions = win.getByRole('dialog', { name: '에이전트 세션' })
  await sessions.locator(`li.agent-session[data-session-id="${C1}"]`).getByRole('button', { name: '대화로 이어 하기' }).click()
  await win.keyboard.press('Escape')
  await expect(sessions).toHaveCount(0)
  const band = view().getByRole('region', { name: '이 폴더에서 하던 세션' })
  await band.getByRole('button', { name: '대화로 이어 하기: 가짜 feat 결제 고치기' }).click()
  await expect(band.getByRole('alert')).toContainText('같은 세션을 다른 곳에서 여는 중이에요')
  await expect(band.locator('li.session-hint')).toHaveCount(1)
  await app!.evaluate(() => (globalThis as unknown as { releaseOpen: () => void }).releaseOpen())
  await expect(view().locator('[data-testid="chat-pane"]')).toHaveCount(1, { timeout: 15_000 })
  const tabs = await view().locator('[data-testid="tab-view"]').count()
  await band.getByRole('button', { name: '대화로 이어 하기: 가짜 feat 결제 고치기' }).click()
  await expect(view().getByRole('region', { name: '이 폴더에서 하던 세션' })).toHaveCount(0)
  await expect(view().locator('[data-testid="chat-pane"]:visible')).toHaveCount(1)
  await expect(view().locator('[data-testid="tab-view"]')).toHaveCount(tabs) // 새 탭이 아니라 그 대화로
})

test('9: 에이전트마다 300개를 넘는 기록 밖으로 밀린 가장 오래된 세션 후보도 대화로 이어 하기가 열린다', async () => {
  makeRepo()
  const now = Math.floor(Date.now() / 1000)
  // 오래된 후보 하나(이 worktree) + 다른 폴더의 더 새 기록 310개 → 53 목록(최근 300개) 밖
  claudeSession(OLD, wtFeat, '가짜 아주 오래된 세션', now - 90 * 86400)
  for (let i = 0; i < 310; i++) claudeSession(`eeeeeeee-${String(i).padStart(4, '0')}-4eee-8eee-eeeeeeeeeeee`, join(base, 'elsewhere'), `가짜 다른 기록 ${i}`, now - 3600 - i)
  // 전에 가져올 때 붙은 후보로 — 가져온 일감에 sessionHints 를 깔아 둔다
  seedState(data, [{ ...VIEWER, cwd: base }])
  const state = JSON.parse(readFileSync(join(data, 'state.json'), 'utf8'))
  state.tasks.push({ ...taskJson({ id: 'feat-task', name: 'feat', paneId: 'feat-pane', cwd: wtFeat }), sessionHints: [{ agent: 'claude', id: OLD, summary: '가짜 아주 오래된 세션', at: (now - 90 * 86400) * 1000 }] })
  writeFileSync(join(data, 'state.json'), JSON.stringify(state))
  await launch([], {}, false)
  // 53 목록에는 없다(최근 300개)
  const listed = await win.evaluate(async () => (await window.taskminal.agentSessions.list()).sessions.map((s: { id: string }) => s.id))
  expect(listed).not.toContain(OLD)
  await row('feat').click()
  const band = view().getByRole('region', { name: '이 폴더에서 하던 세션' })
  await band.getByRole('button', { name: '대화로 이어 하기: 가짜 아주 오래된 세션' }).click()
  await expect(band.getByRole('alert')).toHaveCount(0)
  const chat = view().locator('[data-testid="chat-pane"]:visible')
  await expect(chat).toHaveCount(1, { timeout: 20_000 })
  await expect(view().getByRole('region', { name: '이 폴더에서 하던 세션' })).toHaveCount(0)
  await chat.getByTestId('chat-input').fill('이어서')
  await chat.getByTestId('chat-input').press('Enter')
  await expect.poll(() => argvs().at(-1)?.argv?.join(' ')).toContain(`--resume ${OLD}`)
})

// 보관은 대화상자가 열린 동안 앱 명령 · 사이드바가 막혀(App runCommand 의 aria-modal 검사) 닿는 길이 없다 — 지우기만 CLI 로
test('10: 가져오는 중에 다른 일감을 지움(CLI) → 가져오기 대화상자가 닫히지 않고 끝까지', async () => {
  makeRepo()
  await launch([{ ...VIEWER, cwd: base }, { id: 'other', name: '지울 일감', paneId: 'o-pane', cwd: base }])
  await holdPreviewFrom(2)
  await openFromNewTask(repo)
  await importRow(repo).getByRole('checkbox').uncheck()
  await runButton().click()
  await expect.poll(previewCalls).toBe(2)
  expect((await runCli(data, 'task', 'remove', '지울 일감', '--force')).code).toBe(0)
  await expect(row('지울 일감')).toHaveCount(0)
  await expect(dialog()).toBeVisible()
  await releasePreview()
  await expect(dialog().getByRole('status')).toContainText('2개 일감을 만들었어요', { timeout: 15_000 })
  await expect.poll(() => savedState().tasks.map((t) => t.name).sort()).toEqual(['feat', 'locked-b', '보던 일감'])
})
