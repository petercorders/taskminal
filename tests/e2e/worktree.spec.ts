import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstWindow, seedState } from './helpers'

// 15f: 새 일감을 git worktree 에서 — 임시 저장소 · 임시 userData
let userData: string
let work: string
let repo: string
let app: ElectronApplication
let win: Page
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })

test.beforeEach(async () => {
  userData = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-e2e-')))
  work = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-wt-')))
  repo = join(work, 'app')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'a')
  git(repo, 'add', 'a.txt')
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'first')
  git(repo, 'branch', 'taken')
  mkdirSync(join(work, 'plain'))
  seedState(userData, [{ id: 't', name: '처음', paneId: 'p1' }])
  app = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: userData } })
  win = await firstWindow(app)
})
test.afterEach(async () => {
  await app.close()
  rmSync(userData, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
})

const dialog = () => win.getByRole('dialog')
const tasks = () => JSON.parse(readFileSync(join(userData, 'state.json'), 'utf8')).tasks as Array<{ name: string; cwd: string }>

async function openNew(folder: string, name: string): Promise<void> {
  await win.getByTestId('pane-p1').click() // 화면이 다 뜬 뒤에 — 바로 누르면 키를 받을 renderer 가 아직 없다
  await win.keyboard.press('Meta+KeyN')
  await dialog().getByPlaceholder('예: 찍계부 서버').fill(name)
  await dialog().locator('#new-task-cwd').fill(folder)
}

test('저장소 폴더 → worktree 를 고르면 저장소 옆 새 폴더 · 새 브랜치로 일감이 열린다', async () => {
  await openNew(repo, 'wt 일감')
  await dialog().getByLabel('새 git worktree 에서 시작').check()
  await dialog().getByLabel('새 브랜치 이름').fill('stage/15')
  await dialog().getByRole('button', { name: /만들기/ }).click()
  await expect(dialog()).toHaveCount(0)
  const path = join(work, 'app-stage-15')
  expect(existsSync(join(path, 'a.txt'))).toBe(true)
  await expect.poll(() => tasks().find((t) => t.name === 'wt 일감')?.cwd).toBe(path)
  await expect(win.getByTestId('sidebar').getByRole('listitem').filter({ hasText: 'wt 일감' }).locator('.task-where')).toHaveText('stage/15')
  await win.screenshot({ path: 'test-results/worktree.png' })
})

test('저장소가 아닌 폴더면 worktree 칸이 없다', async () => {
  await openNew(join(work, 'plain'), '그냥')
  await win.waitForTimeout(600) // 300ms 뒤 확인 — 나타나지 않아야 하는 것을 보는 자리
  await expect(dialog().getByTestId('new-task-worktree')).toHaveCount(0)
})

test('이미 있는 브랜치면 오류 줄이 나오고 일감은 만들지 않는다 · 이름을 고치면 다시 된다', async () => {
  await openNew(repo, '겹침')
  await dialog().getByLabel('새 git worktree 에서 시작').check()
  await dialog().getByLabel('새 브랜치 이름').fill('taken')
  await dialog().getByRole('button', { name: /만들기/ }).click()
  await expect(dialog().getByTestId('new-task-error')).toContainText('git worktree 를 만들지 못했습니다')
  expect(tasks().some((t) => t.name === '겹침')).toBe(false)
  await dialog().getByLabel('새 브랜치 이름').fill('fresh')
  await dialog().getByRole('button', { name: /만들기/ }).click()
  await expect(dialog()).toHaveCount(0)
  await expect.poll(() => tasks().find((t) => t.name === '겹침')?.cwd).toBe(join(work, 'app-fresh'))
})
