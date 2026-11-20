import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstWindow, seedState, waitLoaded } from './helpers'

// 65: ⌘P 의 '파일' 범위로 파일을 골라 파일 보기에서 연다 · 파일 보기 '내용 찾기' 결과 줄을 누르면 그 줄 세 줄 위부터 소스로 보인다
// (docs/stages/61-65-orca-gap-v5.md). 일감 폴더는 임시 git 저장소.
let base: string, repo: string, data: string, app: ElectronApplication | undefined, win: Page
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const lines = (n: number, at: number, mark: string) => Array.from({ length: n }, (_, i) => (i + 1 === at ? `const hit = '${mark}' // ${i + 1}` : `// line ${i + 1}`)).join('\n')

test.describe.configure({ timeout: 60_000 })
test.beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'tm-palette-files-')))
  repo = join(base, 'proj')
  data = join(base, 'app')
  mkdirSync(data)
  mkdirSync(join(repo, 'src/deep'), { recursive: true })
  git(repo, 'init', '-b', 'main')
  writeFileSync(join(repo, 'src/deep/target-file.ts'), lines(40, 20, 'NEEDLE_TS'))
  writeFileSync(join(repo, 'README.md'), ['# 제목', '', '- 하나', '- 둘', '', '', '', '', '', 'MD_NEEDLE 여기', '끝'].join('\n'))
  writeFileSync(join(repo, 'other.txt'), 'nothing here\n')
  seedState(data, [{ id: 'task', name: '파일 일감', paneId: 'shell', cwd: repo }])
  app = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: data } })
  win = await firstWindow(app)
  await waitLoaded(win)
})
test.afterEach(async () => {
  await app?.close()
  app = undefined
  rmSync(base, { recursive: true, force: true, maxRetries: 5 })
})

const palette = () => win.getByTestId('palette')
const files = () => win.getByTestId('workspace-files')
const openedPath = () => files().locator('.work-file-preview strong.work-path')
const firstLineNumber = () => files().locator('pre.work-source .work-line-number').first()

test('⌘P → ⇥ 로 파일 범위 → 이름 일부 → ↩ 이면 파일 보기에서 그 파일이 열린다', async () => {
  await win.getByTestId('pane-shell').click()
  await win.keyboard.press('Meta+KeyP')
  await expect(palette()).toBeVisible()
  // 범위 '파일' 은 맨 끝(전체 → 일감 → 명령 → 템플릿 → 출력 → 파일)
  for (let i = 0; i < 5; i++) await win.keyboard.press('Tab')
  await expect(palette().getByTestId('palette-scope')).toHaveText('파일')
  // 빈 찾기에도 파일 목록
  await expect(palette().locator('[data-testid="palette-item"][data-kind="file"]').first()).toBeVisible()
  await win.keyboard.type('target-fi')
  const selected = palette().locator('[aria-selected="true"]')
  await expect(selected).toHaveAttribute('data-kind', 'file')
  await expect(selected).toContainText('target-file.ts')
  await win.screenshot({ path: 'test-results/palette-files-scope.png' })
  await win.keyboard.press('Enter')
  await expect(palette()).toHaveCount(0)
  await expect(files()).toBeVisible()
  await expect(openedPath()).toHaveText('src/deep/target-file.ts')
  // 그 파일의 폴더로 옮겨 열고, 그냥 열면 1줄부터
  await expect(files().getByRole('navigation', { name: '파일 경로' })).toContainText('src/deep')
  await expect(firstLineNumber()).toHaveText('1')
  await expect(files().locator('pre.work-source')).toContainText('// line 1')
})

// 위 시험이 실패할 때 범위를 가르는 시험: 파일 보기가 이미 열려 있으면(새로 그려지지 않으면) 같은 고르기가 열린다
test('파일 보기가 이미 열린 채 ⌘P 파일 범위로 하위 폴더 파일을 고르면 그 파일이 열린다', async () => {
  await win.getByRole('button', { name: '파일 탐색', exact: true }).click()
  await expect(files().getByRole('button', { name: 'README.md', exact: true })).toBeVisible()
  await win.keyboard.press('Meta+KeyP')
  await expect(palette()).toBeVisible()
  for (let i = 0; i < 5; i++) await win.keyboard.press('Tab')
  await expect(palette().getByTestId('palette-scope')).toHaveText('파일')
  await win.keyboard.type('target-fi')
  await expect(palette().locator('[aria-selected="true"]')).toContainText('target-file.ts')
  await win.keyboard.press('Enter')
  await expect(openedPath()).toHaveText('src/deep/target-file.ts')
  await expect(firstLineNumber()).toHaveText('1')
})

test('파일 보기 내용 찾기 → 결과 줄(경로:줄)을 누르면 그 파일이 그 줄 세 줄 위부터 소스로 보인다(Markdown 도 소스로)', async () => {
  await win.getByRole('button', { name: '파일 탐색', exact: true }).click()
  await expect(files()).toBeVisible()
  const grep = files().getByTestId('workspace-grep')
  await grep.fill('needle_ts') // 글자 그대로 · 대소문자 무시
  const results = files().getByTestId('workspace-grep-results')
  const hit = results.getByRole('button', { name: /src\/deep\/target-file\.ts:20/ })
  await expect(hit).toBeVisible({ timeout: 10_000 })
  await expect(hit).toContainText("const hit = 'NEEDLE_TS'")
  await expect(results.getByRole('button')).toHaveCount(1)
  await win.screenshot({ path: 'test-results/palette-files-grep.png' })
  await hit.click()
  await expect(openedPath()).toHaveText('src/deep/target-file.ts')
  await expect(firstLineNumber()).toHaveText('17')
  await expect(files().locator('pre.work-source')).toContainText("const hit = 'NEEDLE_TS' // 20")
  await expect(files().locator('pre.work-source')).not.toContainText('// line 16')

  // Markdown 파일의 결과 줄도 미리보기가 아니라 소스로, 그 줄 세 줄 위부터
  await grep.fill('MD_NEEDLE')
  const md = results.getByRole('button', { name: /README\.md:10/ })
  await expect(md).toBeVisible({ timeout: 10_000 })
  await md.click()
  await expect(openedPath()).toHaveText('README.md')
  await expect(files().locator('pre.work-source')).toBeVisible()
  await expect(files().locator('.work-markdown')).toHaveCount(0)
  await expect(firstLineNumber()).toHaveText('7')
  await expect(files().locator('pre.work-source')).toContainText('MD_NEEDLE 여기')
})
