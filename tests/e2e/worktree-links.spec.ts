import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstWindow, seedState, waitLoaded } from './helpers'

// 62: 환경 설정에 links 가 있는 저장소에서 워크트리 관리로 만들기 → 환경 준비 미리보기가 바로 열리고(실행은 확인 뒤),
// 확인하면 원본을 가리키는 링크가 생긴다 · 대상에 이미 있는 것은 그대로 (docs/stages/61-65-orca-gap-v5.md).
let base: string, repo: string, data: string, app: ElectronApplication | undefined, win: Page
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

test.describe.configure({ timeout: 90_000 })
test.beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'tm-worktree-links-')))
  repo = join(base, 'repo')
  data = join(base, 'app')
  mkdirSync(data)
  mkdirSync(repo)
  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'config', 'user.email', 'test@example.invalid')
  git(repo, 'config', 'commit.gpgsign', 'false')
  // node_modules 는 끝의 / 없이 — 링크(폴더 아님)도 무시되게
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n*.cache\n')
  mkdirSync(join(repo, '.taskminal'))
  writeFileSync(join(repo, '.taskminal/environment.json'), JSON.stringify({ copies: [], links: ['node_modules', 'shared.cache'], commands: [] }))
  git(repo, 'add', '.gitignore', '.taskminal/environment.json')
  git(repo, 'commit', '-m', 'initial')
  // 원본의 무시된 폴더 · 파일
  mkdirSync(join(repo, 'node_modules/pkg'), { recursive: true })
  writeFileSync(join(repo, 'node_modules/pkg/index.js'), 'module.exports = 1\n')
  writeFileSync(join(repo, 'shared.cache'), 'from-source')
  seedState(data, [{ id: 'source', name: '원본', paneId: 'shell', cwd: repo }])
  app = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: data } })
  win = await firstWindow(app)
  await waitLoaded(win)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('app:command', 'worktrees'))
})
test.afterEach(async () => {
  await app?.close()
  app = undefined
  rmSync(base, { recursive: true, force: true, maxRetries: 5 })
})

const panel = () => win.getByRole('region', { name: '워크트리 관리', exact: true })

test('links 가 있는 저장소: 워크트리를 만들면 미리보기가 바로 열리고, 확인 뒤 링크가 생기며 대상에 이미 있는 것은 그대로', async () => {
  const destination = join(base, 'new-checkout')
  await panel().getByRole('textbox', { name: '브랜치 이름', exact: true }).fill('feature/links')
  await panel().getByRole('textbox', { name: '기준 커밋 또는 ref', exact: true }).fill('HEAD')
  await panel().getByRole('textbox', { name: '새 워크트리 폴더의 절대 경로', exact: true }).fill(destination)
  await panel().getByRole('button', { name: '워크트리 만들기', exact: true }).click()

  // 만든 직후 환경 준비 패널로 넘어가 미리보기까지 읽어 보인다 — 아직 실행은 없다
  const dev = win.getByTestId('development-panel')
  await expect(dev).toBeVisible({ timeout: 15_000 })
  await expect(dev.getByRole('combobox', { name: '준비할 워크트리' })).toHaveValue(destination)
  const preview = dev.getByTestId('environment-preview')
  await expect(preview).toBeVisible()
  await expect(preview.locator('strong').first()).toHaveText(destination)
  const links = preview.getByRole('list', { name: '원본에 연결' }).getByRole('listitem')
  await expect(links).toHaveText(['node_modules · 원본에 연결 · 원본과 함께 바뀌어요', 'shared.cache · 원본에 연결 · 원본과 함께 바뀌어요'])
  await expect(preview).toContainText('원본과 함께 쓰여')
  await expect(dev.getByTestId('preparation-record')).toHaveCount(0)
  expect(existsSync(join(destination, 'node_modules'))).toBe(false)
  await win.screenshot({ path: 'test-results/worktree-links-preview.png' })

  // 대상에 이미 있는 것(사용자 파일)을 두고 다시 미리 보면 '기존 것 보존'
  writeFileSync(join(destination, 'shared.cache'), 'mine')
  await dev.getByRole('button', { name: '환경 준비 미리보기', exact: true }).click()
  await expect(links).toHaveText(['node_modules · 원본에 연결 · 원본과 함께 바뀌어요', 'shared.cache · 기존 것 보존'])

  await preview.getByRole('button', { name: '확인하고 환경 준비' }).click()
  const record = dev.getByTestId('preparation-record').first()
  await expect(record.locator('strong')).toHaveText('완료', { timeout: 15_000 })
  await expect(record.getByLabel('환경 준비 출력')).toContainText('node_modules — 원본에 연결')
  await expect(record.getByLabel('환경 준비 출력')).toContainText('shared.cache — 기존 것 보존')

  // 링크는 원본 절대 경로를 가리키고, 그 안으로 원본 내용이 보인다
  const nm = join(destination, 'node_modules')
  expect(lstatSync(nm).isSymbolicLink()).toBe(true)
  expect(readlinkSync(nm)).toBe(join(repo, 'node_modules'))
  expect(readFileSync(join(nm, 'pkg/index.js'), 'utf8')).toBe('module.exports = 1\n')
  // 이미 있던 것은 그대로(링크로 바꾸지 않고 내용도 그대로)
  const kept = join(destination, 'shared.cache')
  expect(lstatSync(kept).isSymbolicLink()).toBe(false)
  expect(readFileSync(kept, 'utf8')).toBe('mine')
  // 링크는 대상 워크트리에서 Git 이 무시한다(커밋에 섞이지 않는다)
  expect(git(destination, 'status', '--porcelain')).toBe('')
  await win.screenshot({ path: 'test-results/worktree-links-done.png' })
})
