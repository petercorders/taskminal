import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { firstWindow, seedState, waitLoaded } from './helpers'

// 54단계: PR 의 실패 체크 · 리뷰 의견 → 대화 입력칸 초안. gh 는 가짜(tests/fixtures/gh-bin/gh — 실제 GitHub 권한 · 페이지 · 로그 크기는 흉내 내지 않음),
// git 은 진짜 임시 저장소(원격 주소만 github.com/o/r 모양, 실제로 연결하지 않는다). 피드백 읽기 한도는 시험만 3초.
const GH_BIN = resolve(__dirname, '../fixtures/gh-bin')
const FAKE_CHAT = resolve(__dirname, '../fixtures/fake-claude.mjs')
const TOKEN = 'ghp_' + 'Z'.repeat(36)
let data: string
let repo: string
let ghDir: string
let app: ElectronApplication | undefined
let win: Page

const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
const calls = (): string[][] => (existsSync(join(ghDir, 'calls.log')) ? readFileSync(join(ghDir, 'calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]) : [])
const prViews = () => calls().filter((c) => c[0] === 'pr' && c[1] === 'view')
const done = () => (existsSync(join(ghDir, 'done.log')) ? readFileSync(join(ghDir, 'done.log'), 'utf8').trim().split('\n') : [])

async function launch() {
  app = await electron.launch({
    args: ['.'],
    env: { ...process.env, TASKMINAL_USER_DATA: data, PATH: `${GH_BIN}:${process.env['PATH'] ?? ''}`, FAKE_GH_DIR: ghDir, TASKMINAL_GH_FEEDBACK_TIMEOUT_MS: '3000', TASKMINAL_CLAUDE_BIN: FAKE_CHAT },
  })
  win = await firstWindow(app)
  await waitLoaded(win)
}
async function openGitHub() {
  await win.keyboard.press('Meta+p')
  await win.keyboard.type('GitHub PR·push')
  await win.keyboard.press('Enter')
  await expect(win.getByTestId('git-workflow')).toContainText('#7 Fix it', { timeout: 15_000 })
}
const fb = () => win.getByTestId('ci-feedback')

test.describe.configure({ timeout: 90_000 })
test.beforeEach(() => {
  data = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-e2e-')))
  repo = join(data, 'repo')
  ghDir = join(data, 'gh')
  mkdirSync(repo)
  mkdirSync(ghDir)
  git('init', '-q', '-b', 'feature')
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 'test@example.invalid')
  writeFileSync(join(repo, 'a.txt'), 'one')
  git('add', '.')
  git('commit', '-qm', 'one')
  git('remote', 'add', 'origin', 'git@github.com:o/r.git')
  seedState(data, [{ id: 'task-a', name: 'A 일감', paneId: 'pane-a', cwd: repo }])
})
test.afterEach(async () => {
  await app?.close()
  app = undefined
  rmSync(data, { recursive: true, force: true, maxRetries: 5 })
})

test('체크 실패 · 리뷰 의견을 보고 고른 것만 대화 입력칸 초안으로 — 가리고, 보내지 않고, 두 번 눌러도 하나', async () => {
  await launch()
  await openGitHub()
  await expect(fb()).toContainText('체크 실패 1', { timeout: 10_000 })
  await expect(fb()).toContainText('리뷰 의견 3')
  await expect(fb()).toContainText('dave · src/a.ts:12')
  await expect(fb()).toContainText('alice · 변경 요청')
  // 로그 끝: 줄머리 · 색 코드를 떼고, 토큰은 가린다
  await fb().getByText('로그 끝 5줄').click()
  const log = fb().getByLabel('build 로그 끝')
  await expect(log).toContainText('FAIL: expected 2, got 3')
  await expect(log).toContainText('‹가림')
  await expect(log).not.toContainText(TOKEN)
  await expect(log).not.toContainText('Run tests')
  await win.screenshot({ path: 'test-results/ci-feedback.png' })

  await fb().getByRole('checkbox', { name: /carol/ }).uncheck()
  const send = fb().getByRole('button', { name: '대화로 보내기 (3)' })
  await send.dblclick()

  const input = win.locator('[data-testid="task-view"][aria-hidden="false"] [data-testid="chat-input"]')
  await expect(input).toHaveValue(/PR #7 \(o\/r\)/, { timeout: 10_000 })
  const value = await input.inputValue()
  expect(value.split('FAIL: expected 2, got 3').length - 1).toBe(1)
  expect(value).toContain('## 리뷰 의견: dave · src/a.ts:12')
  expect(value).toContain('https://github.com/o/r/actions/runs/111/job/222')
  expect(value).not.toContain('이름을 바꿔')
  expect(value).not.toContain(TOKEN)
  await expect(win.getByTestId('git-workflow')).toHaveCount(0) // 넣은 뒤 보조 화면을 닫는다
  await expect(win.getByTestId('chat-user-text')).toHaveCount(0) // 보내지 않았다
  // gh 는 링크의 숫자로만, 피드백 읽기는 한 번
  expect(calls()).toContainEqual(['run', 'view', '111', '--repo', 'o/r', '--job', '222', '--log-failed'])
  expect(prViews()).toHaveLength(1)
})

test('한도 안에 답이 없으면 응답이 없어요 · 마지막 값과 받은 시각을 남기고, 다시 시도는 도는 읽기를 기다린다', async () => {
  await launch()
  await openGitHub()
  await expect(fb()).toContainText('체크 실패 1', { timeout: 10_000 })
  writeFileSync(join(ghDir, 'slow'), 'all\t5000')
  await fb().getByRole('button', { name: '체크·리뷰 다시 읽기' }).click()
  await expect(fb().getByRole('status')).toHaveText('체크·리뷰 읽는 중…')
  await expect(fb().getByRole('alert')).toContainText('응답이 없어요', { timeout: 6_000 })
  // 마지막 값과 받은 시각은 남는다
  await expect(fb()).toContainText('체크 실패 1')
  await expect(fb().getByTestId('ci-feedback-age')).toContainText('받은 값')
  rmSync(join(ghDir, 'slow'))
  await fb().getByRole('button', { name: '다시 시도' }).click()
  await expect(fb().getByRole('alert')).toHaveCount(0, { timeout: 6_000 })
  await expect(fb()).toContainText('체크 실패 1')
  // 다시 시도는 아직 돌던 같은 읽기를 기다렸다 — gh 를 또 부르지 않았다
  expect(prViews()).toHaveLength(2)
})

test('커밋이 바뀌는 사이 늦게 온 옛 커밋의 응답은 새 값을 덮지 않는다', async () => {
  const first = git('rev-parse', 'HEAD')
  writeFileSync(join(ghDir, 'slow'), `${first}\t2500`)
  await launch()
  await openGitHub()
  await expect(fb().getByRole('status')).toHaveText('체크·리뷰 읽는 중…') // 옛 커밋 읽기가 도는 중
  writeFileSync(join(repo, 'a.txt'), 'two')
  git('commit', '-qam', 'two')
  const second = git('rev-parse', 'HEAD')
  await win.getByTestId('git-workflow').getByRole('button', { name: '다시 읽기', exact: true }).click()
  await expect(fb()).toContainText(`리뷰 ${second.slice(0, 7)}`, { timeout: 10_000 })
  // 옛 응답이 도착할 때까지 기다린 뒤에도 새 값 그대로
  await expect.poll(() => done().includes(first), { timeout: 10_000 }).toBe(true)
  await win.waitForTimeout(500)
  await expect(fb()).toContainText(`리뷰 ${second.slice(0, 7)}`)
  await expect(fb()).not.toContainText(`리뷰 ${first.slice(0, 7)}`)
  await expect(fb().getByTestId('ci-feedback-age')).toContainText(`PR 커밋 ${second.slice(0, 8)}`)
  await expect(fb().getByTestId('ci-feedback-age')).not.toContainText('이전 커밋')
})

// 56단계: PR 이 있으면 PR 상태 · 체크 · 리뷰 · CI 피드백이 먼저, remote · push · base 설정은 아래 — 커밋은 '변경 보기' 로 넘어간다
test('PR 이 있으면 PR 카드가 보내기 설정보다 위에 있고, 변경 보기로 변경 칸을 연다', async () => {
  await launch()
  await openGitHub()
  const panel = win.getByTestId('git-workflow')
  const top = (l: ReturnType<Page['locator']>) => l.evaluate((e) => e.getBoundingClientRect().top)
  expect(await top(panel.locator('.git-workflow-pr'))).toBeLessThan(await top(panel.getByRole('combobox', { name: 'push 할 remote' })))
  await expect(panel.getByRole('heading', { name: '보내기 설정' })).toBeVisible()
  await panel.getByRole('button', { name: '변경 보기', exact: true }).click()
  await expect(win.locator('.work-tool-panel')).toHaveCount(0)
  await expect(win.getByTestId('review-pane')).toBeVisible()
})
