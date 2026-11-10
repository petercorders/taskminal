import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstWindow, seedState } from './helpers'

// 15c: 사이드바 일감 둘째 줄의 git 브랜치 — 임시 저장소 · 임시 userData.
let userData: string
let work: string
let app: ElectronApplication
let win: Page

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })

test.beforeEach(async () => {
  userData = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-e2e-')))
  work = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-git-')))
  const repo = join(work, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'a')
  git(repo, 'add', 'a.txt')
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'first')
  mkdirSync(join(work, 'plain'))
  seedState(userData, [
    { id: 'g', name: '저장소 일감', paneId: 'p1', cwd: repo },
    { id: 'n', name: '그냥 폴더', paneId: 'p2', cwd: join(work, 'plain') },
  ])
  app = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: userData } })
  win = await firstWindow(app)
})
test.afterEach(async () => {
  await app.close()
  rmSync(userData, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
})

const where = (name: string) => win.getByTestId('sidebar').getByRole('listitem').filter({ hasText: name }).locator('.task-where')

test('저장소 일감은 브랜치, 아닌 일감은 폴더 — 고정폭 글꼴', async () => {
  await expect(where('저장소 일감')).toHaveText('main')
  await expect(where('그냥 폴더')).toHaveText(/\/plain$/) // 긴 임시 경로는 shortPath 가 '…/…/plain' 으로 줄인다 (15c 리뷰)
  expect(await where('저장소 일감').evaluate((el) => (globalThis as unknown as { getComputedStyle(e: unknown): { fontFamily: string } }).getComputedStyle(el).fontFamily)).toMatch(/JetBrains Mono|Menlo/)
  await win.screenshot({ path: 'test-results/branch-sidebar.png' })
})

test('셸에서 브랜치를 바꾸면 몇 초 안에 따라간다', async () => {
  await win.getByTestId('pane-p1').click()
  await win.keyboard.type('git switch -q -c feat/side && echo SWITCHED$((1+1))')
  await win.keyboard.press('Enter')
  await expect(win.getByTestId('pane-p1').locator('.xterm-rows')).toContainText('SWITCHED2')
  await expect(where('저장소 일감')).toHaveText('feat/side', { timeout: 8_000 }) // 5초 주기
})

test('창이 포커스를 받으면 바로 다시 읽는다', async () => {
  await win.evaluate(() => (globalThis as unknown as { dispatchEvent(e: Event): void }).dispatchEvent(new Event('blur')))
  git(join(work, 'repo'), 'switch', '-q', '-c', 'from-outside')
  await win.evaluate(() => (globalThis as unknown as { dispatchEvent(e: Event): void }).dispatchEvent(new Event('focus')))
  await expect(where('저장소 일감')).toHaveText('from-outside', { timeout: 2_000 })
})
