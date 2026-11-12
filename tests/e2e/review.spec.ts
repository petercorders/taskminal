import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { firstWindow, seedState, waitLoaded } from './helpers'

// 23단계: 변경 검토 pane — 임시 git 저장소(로컬 설정으로 서명 끔)에서 줄 되돌리기 · ⌘Z · 되돌린 것 · 커밋 · 훅 실패 · 빈 화면 · 대화 카드 · 경고
const FAKE = resolve(__dirname, '../fixtures/fake-claude.mjs')
let userData: string
let repo: string
let app: ElectronApplication | undefined
let win: Page

const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
const read = (p: string) => readFileSync(join(repo, p), 'utf8')
const write = (p: string, s: string) => writeFileSync(join(repo, p), s)

async function launch() {
  app = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: userData, TASKMINAL_CLAUDE_BIN: FAKE } })
  win = await firstWindow(app)
  await waitLoaded(win)
}
async function command(c: string) {
  await app!.evaluate(({ BrowserWindow }, cmd) => BrowserWindow.getAllWindows()[0]!.webContents.send('app:command', cmd), c)
}
const pane = () => win.locator('[data-testid="task-view"][aria-hidden="false"] [data-testid="review-pane"]')
const files = () => pane().getByTestId('review-file')
const line = (text: string) => pane().getByTestId('review-line').filter({ hasText: text })
/** `덩어리:줄` — 글자로 찾으면 대소문자를 가리지 않아 b · B 가 겹친다 */
const at = (key: string) => pane().locator(`[data-testid="review-line"][data-key="${key}"]`)

test.describe.configure({ timeout: 90_000 })
test.beforeEach(() => {
  userData = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-e2e-')))
  repo = join(userData, 'repo')
  mkdirSync(repo)
  git('init', '-q', '-b', 'feat')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  git('config', 'commit.gpgsign', 'false')
  write('x.txt', 'a\nb\nc\nd\ne\nf\ng\n')
  write('keep.txt', 'k\n')
  git('add', '.')
  git('commit', '-qm', 'init')
  seedState(userData, [{ id: 'task-a', name: 'A 일감', paneId: 'pane-a', cwd: repo }])
})
test.afterEach(async () => {
  await app?.close()
  app = undefined
  rmSync(userData, { recursive: true, force: true })
})

test('⇧⌘G → 파일 · diff → 줄 2개 골라 ⌫ → 파일에서 빠짐 → ⌘Z 로 되살림', async () => {
  write('x.txt', 'a\nB1\nB2\nc\nd\nE\nf\ng\nh\n')
  write('keep.txt', 'K\n')
  await launch()
  await win.locator('[data-testid="pane-slot"]').first().click()
  await win.keyboard.press('Meta+Shift+g')
  await expect(pane()).toBeVisible()
  await expect(files()).toHaveCount(2)
  await expect(pane().getByTestId('review-summary')).toHaveText('파일 2개 · 2개 남음 · +5 −3')
  await files().filter({ hasText: 'x.txt' }).click()
  // 가운데 -e +E 만 고른다
  await expect(at('0:6')).toContainText('- e')
  await at('0:6').click()
  await at('0:7').click()
  await expect(pane().getByTestId('review-revert-bar')).toContainText('고른 줄 2개')
  await win.screenshot({ path: 'test-results/review-pick.png' })
  await pane().press('Backspace')
  await expect.poll(() => read('x.txt')).toBe('a\nB1\nB2\nc\nd\ne\nf\ng\nh\n')
  await expect(win.getByTestId('toast')).toContainText('줄 2개를 되돌렸어요')
  await win.keyboard.press('Meta+z')
  await expect.poll(() => read('x.txt')).toBe('a\nB1\nB2\nc\nd\nE\nf\ng\nh\n')
  // 다른 파일은 그대로
  expect(read('keep.txt')).toBe('K\n')
  // 봤음 ⌥↩ — 파일이 다시 바뀌면 풀린다
  await pane().press('Alt+Enter')
  await expect(files().filter({ hasText: 'x.txt' }).getByTestId('review-seen')).toHaveAttribute('data-seen', 'true')
  write('x.txt', 'a\nB1\nB2\nc\nd\nE\nf\ng\nh\nmore\n')
  await expect(files().filter({ hasText: 'x.txt' }).getByTestId('review-seen')).toHaveAttribute('data-seen', 'false') // 폴더 감시가 다시 읽음
  await win.screenshot({ path: 'test-results/review-diff.png' })
})

test('되돌린 것 — 되살리기 · 그 뒤로 같은 줄이 바뀌면 되살리지 못함', async () => {
  write('x.txt', 'a\nB\nc\nd\ne\nf\ng\n')
  write('n.txt', 'new\n')
  await launch()
  await command('review')
  await files().filter({ hasText: 'x.txt' }).click()
  await expect(at('0:2')).toContainText('+ B')
  await at('0:2').click()
  await pane().getByTestId('review-revert').click()
  await expect.poll(() => read('x.txt')).toBe('a\nc\nd\ne\nf\ng\n')
  // 새 파일 지우기는 확인을 묻는다
  await files().filter({ hasText: 'n.txt' }).click()
  await pane().getByTestId('review-revert-file').click()
  await win.getByRole('button', { name: '지우기', exact: true }).click()
  await expect.poll(() => existsSync(join(repo, 'n.txt'))).toBe(false)
  await command('review-reverted')
  await expect(pane().getByTestId('review-rev-row')).toHaveCount(2)
  await win.screenshot({ path: 'test-results/review-reverted.png' })
  await pane().getByTestId('review-rev-row').filter({ hasText: 'n.txt' }).getByTestId('review-restore').click()
  await expect.poll(() => existsSync(join(repo, 'n.txt'))).toBe(true)
  // x.txt 의 그 자리를 다시 바꾸면 되살리지 못한다
  write('x.txt', 'a\nZZ\nd\ne\nf\ng\n')
  await pane().getByTestId('review-rev-row').filter({ hasText: 'x.txt' }).getByTestId('review-restore').click()
  await expect(win.getByTestId('toast')).toContainText('되살리지 못했어요')
  expect(read('x.txt')).toBe('a\nZZ\nd\ne\nf\ng\n')
})

test('되돌린 것: 두 번째 버튼을 Enter로 실행하면 그 파일만 되살린다', async () => {
  write('first.txt', 'first\n')
  write('second.txt', 'second\n')
  await launch()
  await command('review')
  for (const name of ['first.txt', 'second.txt']) {
    await files().filter({ hasText: name }).click()
    await pane().getByTestId('review-revert-file').click()
    await win.getByRole('button', { name: '지우기', exact: true }).click()
    await expect.poll(() => existsSync(join(repo, name))).toBe(false)
  }
  await command('review-reverted')
  const rows = pane().getByTestId('review-rev-row')
  await expect(rows).toHaveCount(2)
  const second = rows.nth(1)
  const target = (await second.getAttribute('data-path'))!
  const untouched = (await rows.first().getAttribute('data-path'))!
  const button = second.getByTestId('review-restore')
  await expect(pane()).toBeFocused()
  await button.focus()
  await expect(button).toBeFocused()
  await button.press('Enter')
  await expect.poll(() => existsSync(join(repo, target))).toBe(true)
  await expect(rows).toHaveCount(1)
  expect(existsSync(join(repo, untouched))).toBe(false)
  await win.screenshot({ path: 'test-results/uiux-review-keyboard.png' })
  await rows.getByTestId('review-restore').focus()
  await win.keyboard.press('Escape')
  await expect(pane().getByTestId('review-reverted')).toHaveCount(0)
})

test('커밋 — 체크한 파일만 · 빠진 파일 한 줄 · git log · 커밋 취소', async () => {
  write('x.txt', 'X\n')
  write('keep.txt', 'K\n')
  write('new.txt', 'N\n')
  await launch()
  await command('review-commit')
  await expect(pane().getByTestId('review-commit')).toBeVisible()
  await expect(pane().getByTestId('review-msg')).toBeFocused()
  await files().filter({ hasText: 'keep.txt' }).click() // 체크 풀기
  await expect(files().filter({ hasText: 'keep.txt' }).getByTestId('review-check')).toHaveAttribute('data-checked', 'false')
  await expect(pane()).toContainText('1개는 빠져 있어요')
  await pane().getByTestId('review-msg').fill('고침: 두 파일만\n\n본문')
  await win.screenshot({ path: 'test-results/review-commit.png' })
  await pane().getByTestId('review-msg').press('Meta+Enter')
  await expect(pane().getByTestId('review-done')).toContainText('커밋했어요')
  expect(git('log', '-1', '--format=%s')).toBe('고침: 두 파일만')
  expect(git('show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual(['new.txt', 'x.txt'])
  expect(git('status', '--porcelain')).toBe('M keep.txt')
  await pane().getByTestId('review-undo-commit').click()
  await expect.poll(() => git('log', '-1', '--format=%s')).toBe('init')
  expect(read('x.txt')).toBe('X\n')
})

test('커밋 전 검사 실패 — 마지막 줄 · 아무것도 커밋 안 됨 · 대화에 고쳐 달라고 하기', async () => {
  const hook = join(repo, '.git', 'hooks', 'pre-commit')
  writeFileSync(hook, '#!/bin/sh\necho "lint 돌리는 중"\necho "src/main/scrollback-store.ts:44:5 error \'clearAll\' is not defined" >&2\nexit 1\n')
  chmodSync(hook, 0o755)
  write('x.txt', 'X\n')
  await launch()
  await command('review-commit')
  await pane().getByTestId('review-msg').fill('고침')
  await pane().getByTestId('review-commit-btn').click()
  await expect(pane().getByTestId('review-fail')).toContainText('커밋 전 검사가 실패했어요 — 아무것도 바꾸지 않았어요')
  await expect(pane().getByTestId('review-fail-tail')).toContainText("'clearAll' is not defined")
  await expect(pane().getByTestId('review-commit-btn')).toHaveText('다시 커밋 ⌘↩')
  expect(git('log', '-1', '--format=%s')).toBe('init')
  await win.screenshot({ path: 'test-results/review-hook-fail.png' })
  await pane().getByTestId('review-ask-fix').click()
  const chatInput = win.locator('[data-testid="task-view"][aria-hidden="false"] [data-testid="chat-input"]')
  await expect(chatInput).toBeVisible()
  await expect(chatInput).toHaveValue(/커밋 전 검사가 실패했어요[\s\S]*clearAll/)
})

test('빈 화면 — 바뀐 것 없음 → 셸에서 고치면 목록에 나타남 · 저장소 아님', async () => {
  await launch()
  await command('review')
  await expect(pane().getByTestId('review-empty')).toHaveAttribute('data-kind', 'clean')
  await expect(pane().getByTestId('review-empty')).toContainText('바뀐 파일이 없어요')
  write('x.txt', 'changed\n') // 폴더 감시
  await expect(files()).toHaveCount(1)
  await app!.close()
  app = undefined
  seedState(userData, [{ id: 'task-a', name: 'A 일감', paneId: 'pane-a', cwd: userData }])
  await launch()
  await command('review')
  await expect(pane().getByTestId('review-empty')).toHaveAttribute('data-kind', 'not-repo')
  await win.screenshot({ path: 'test-results/review-not-repo.png' })
  await pane().getByRole('button', { name: '터미널에 git init 넣기' }).click()
  await expect(win.locator('[data-testid="task-view"][aria-hidden="false"] [data-testid="pane-slot"]')).toHaveCount(3)
})

test('대화 diff 카드 — 에이전트가 고친 파일의 diff 열기 → 변경 pane 의 그 파일', async () => {
  await launch()
  await command('chat-new')
  const chat = win.locator('[data-testid="task-view"][aria-hidden="false"] [data-testid="chat-pane"]')
  await chat.getByTestId('chat-input').fill('edit please')
  await chat.getByTestId('chat-input').press('Enter')
  await expect(chat.getByTestId('chat-diff-card')).toContainText('x.txt')
  await chat.getByTestId('chat-diff-card').getByRole('button', { name: 'diff 열기 →' }).click()
  await expect(pane()).toBeVisible()
  await expect(files().filter({ hasText: 'x.txt' })).toHaveAttribute('aria-current', 'true')
  await expect(line('agent line')).toBeVisible()
  // diff 줄의 '대화에 묻기' 는 그 대화 입력칸으로
  await line('agent line').hover()
  await line('agent line').getByTestId('review-ask').click()
  await expect(chat.getByTestId('chat-input')).toHaveValue(/x\.txt:8 이 변경에 대해[\s\S]*\+agent line/)
})

test('커밋 경고 — main 에 바로 · 비밀값 줄 → 그래도 커밋', async () => {
  git('checkout', '-q', '-b', 'main')
  write('keys.txt', 'token=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789\n')
  await launch()
  await command('review-commit')
  const warns = pane().getByTestId('review-warning')
  await expect(warns).toHaveCount(2)
  await expect(warns.nth(0)).toContainText('main 에 바로 커밋해요')
  await expect(warns.nth(1)).toContainText('비밀값으로 보이는 줄이 1개 있어요 · keys.txt 1번째 줄')
  await expect(pane().getByTestId('review-commit-btn')).toHaveText('그래도 커밋 ⌘↩')
  await win.screenshot({ path: 'test-results/review-warn.png' })
  await pane().getByTestId('review-msg').fill('키 넣기')
  await pane().getByTestId('review-commit-btn').click()
  await expect(pane().getByTestId('review-done')).toBeVisible()
  expect(git('log', '-1', '--format=%s')).toBe('키 넣기')
})
