import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureWindow, firstWindow, seedState, waitLoaded } from './helpers'

let fixture: string
let repository: string
let left: string
let right: string
let base: string
let app: ElectronApplication | undefined
let window: Page
let server: Server | undefined

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}
function commitChange(cwd: string, value: string): string {
  writeFileSync(join(cwd, 'candidate.txt'), value + '\n')
  git(cwd, 'add', 'candidate.txt')
  git(cwd, 'commit', '-qm', value)
  return git(cwd, 'rev-parse', 'HEAD')
}
async function open(command: 'worktrees' | 'development') {
  await app!.evaluate(({ BrowserWindow }, name) => BrowserWindow.getAllWindows()[0]!.webContents.send('app:command', name), command)
}

test.describe.configure({ timeout: 90_000 })
test.beforeEach(async () => {
  fixture = realpathSync(mkdtempSync(join(tmpdir(), 'tm-worktree-review-v7-')))
  repository = join(fixture, 'repo')
  left = join(fixture, 'candidate-left')
  right = join(fixture, 'candidate-right')
  const data = join(fixture, 'app')
  mkdirSync(repository)
  mkdirSync(data)
  git(repository, 'init', '-qb', 'main')
  writeFileSync(join(repository, '.gitignore'), 'link-cache\n')
  git(repository, 'add', '.gitignore')
  base = commitChange(repository, 'baseline')
  git(repository, 'worktree', 'add', '-qb', 'claude-result', left)
  git(repository, 'worktree', 'add', '-qb', 'codex-result', right)
  seedState(data, [{ id: 'worktree-review', name: '공통 변경 검토', paneId: 'shell', cwd: repository }])
  app = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: data } })
  window = await firstWindow(app)
  await waitLoaded(window)
})
test.afterEach(async () => {
  try { await app?.close() }
  finally {
    app = undefined
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
    server = undefined
    if (fixture) rmSync(fixture, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('두 에이전트의 변경 및 리포트를 비교하고 충돌이 있어도 작업 트리를 보존한다', async ({}, info) => {
  const leftSha = commitChange(left, 'Claude 결과')
  const rightSha = commitChange(right, 'Codex 결과')
  writeFileSync(join(right, 'draft.txt'), 'keep it')
  const record = (sha: string, exitCode: number) => JSON.stringify({
    version: 1, repository: 'sample/repo', pullRequest: 24, startSha: sha, endSha: sha,
    entries: [{ criterion: '회귀 검사', check: 'Electron full-check', exitCode }],
  })

  await open('worktrees')
  await window.getByText('두 워크트리 비교', { exact: true }).click()
  await window.getByLabel('첫 워크트리').selectOption(left)
  await window.getByLabel('둘째 워크트리').selectOption(right)
  await window.getByLabel('작업 시작 SHA').fill(base)
  await window.getByRole('button', { name: '변경과 병합 충돌 확인' }).click()
  await expect(window.getByRole('list', { name: '충돌 파일' })).toHaveText('candidate.txt')
  await expect(window.getByText(/변경 비교 기준/)).toContainText(base.slice(0, 12))

  const comparison = window.locator('.worktree-comparison')
  const leftCard = comparison.getByRole('article').filter({ has: window.getByRole('heading', { name: 'claude-result', exact: true }) })
  const rightCard = comparison.getByRole('article').filter({ has: window.getByRole('heading', { name: 'codex-result', exact: true }) })
  await expect(leftCard).toContainText('M · candidate.txt')
  await expect(rightCard).toContainText('M · candidate.txt')
  await leftCard.getByLabel('검증 리포트').setInputFiles({ name: 'left.json', mimeType: 'application/json', buffer: Buffer.from(record(leftSha, 0)) })
  await rightCard.getByLabel('검증 리포트').setInputFiles({ name: 'right.json', mimeType: 'application/json', buffer: Buffer.from(record(base, 0)) })
  await expect(leftCard).toContainText('비교 커밋과 일치')
  await expect(rightCard).toContainText('이 커밋의 검증 근거 미확인')
  await expect(rightCard).toContainText('가져온 기록')
  await leftCard.getByRole('heading', { name: 'claude-result' }).scrollIntoViewIfNeeded()
  const [leftBounds, rightBounds] = await Promise.all([leftCard.boundingBox(), rightCard.boundingBox()])
  expect(leftBounds).not.toBeNull()
  expect(rightBounds).not.toBeNull()
  expect(Math.abs(leftBounds!.y - rightBounds!.y)).toBeLessThan(1)
  expect(leftBounds!.x + leftBounds!.width).toBeLessThan(rightBounds!.x)
  await captureWindow(app!, info.outputPath('worktree-comparison.png'))
  expect(git(repository, 'rev-parse', 'HEAD')).toBe(base)
  expect(git(right, 'rev-parse', 'HEAD')).toBe(rightSha)
  expect(readFileSync(join(right, 'candidate.txt'), 'utf8')).toBe('Codex 결과\n')
  expect(readFileSync(join(right, 'draft.txt'), 'utf8')).toBe('keep it')
})

test('환경 미리보기에서 누락된 경로, 끊긴 링크, 사용 중인 TCP 포트를 보여 준다', async () => {
  test.skip(process.platform !== 'darwin', 'macOS TCP 관측 경로')
  server = createServer()
  const listener = server
  await new Promise<void>((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve))
  const address = listener.address()
  if (!address || typeof address === 'string') throw new Error('테스트 TCP 포트를 열지 못했습니다.')
  mkdirSync(join(repository, '.taskminal'))
  mkdirSync(join(repository, 'link-cache'))
  symlinkSync(join(fixture, 'missing'), join(left, 'link-cache'))
  writeFileSync(join(repository, '.taskminal/environment.json'), JSON.stringify({
    copies: [], links: ['link-cache'], commands: [], requiredPaths: ['.gitignore', 'local.env'], ports: [address.port],
  }))

  await open('development')
  const panel = window.getByTestId('development-panel')
  await panel.getByRole('combobox', { name: '준비할 워크트리' }).selectOption(left)
  await panel.getByRole('button', { name: '환경 준비 미리보기', exact: true }).click()
  const preview = panel.getByTestId('environment-preview')
  await expect(preview).toContainText('link-cache · 끊긴 링크 · 기존 링크 보존')
  await expect(preview.getByRole('region', { name: '워크트리 준비 상태' })).toContainText('local.env · 필요한 경로가 없음')
  await expect(preview).toContainText(`TCP ${address.port} · 사용 중`)
  await expect(panel.getByTestId('preparation-record')).toHaveCount(0)
  expect(lstatSync(join(left, 'link-cache')).isSymbolicLink()).toBe(true)
})
