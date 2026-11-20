import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import type { Workflow } from '../../src/shared/workflows'
import { firstWindow, seedState, waitLoaded } from './helpers'

const ghFixture = resolve(__dirname, '../fixtures/gh-bin/gh')
const serverUrl = 'https://github.com/example/server/pull/2'
const clientUrl = 'https://github.com/example/client/pull/3'
let data: string
let repo: string
let ghDir: string
let app: ElectronApplication | undefined
let win: Page

function git(...args: string[]) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

async function openPullRequests() {
  await win.getByRole('button', { name: 'GitHub PR·push', exact: true }).click()
  await expect(win.getByTestId('git-workflow')).toContainText('#7 Fix it')
}

test.describe.configure({ timeout: 90_000 })
test.beforeEach(async () => {
  data = realpathSync(mkdtempSync(join(tmpdir(), 'tm-pr-workflow-v7-')))
  repo = join(data, 'repo')
  ghDir = join(data, 'gh')
  const bin = join(data, 'bin')
  mkdirSync(repo)
  mkdirSync(ghDir)
  mkdirSync(bin)
  // Other PR reads use the established fixture, while cross-repository reads
  // return a controllable prerequisite. The wrapper never calls the real gh.
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const { existsSync } = require('node:fs')
const { join } = require('node:path')
const args = process.argv.slice(2)
const repository = args[args.indexOf('--repo') + 1]
if (args[0] === 'pr' && args[1] === 'view' && ['example/server', 'example/client'].includes(repository)) {
  const server = repository === 'example/server'
  const number = server ? 2 : 3
  if (Number(args[2]) !== number) process.exit(1)
  const ready = server && existsSync(join(process.env.FAKE_GH_DIR, 'server-ready'))
  process.stdout.write(JSON.stringify({
    number, title: server ? 'Server change' : 'Client change',
    url: 'https://github.com/' + repository + '/pull/' + number,
    state: ready ? 'MERGED' : 'OPEN',
    headRefOid: 'a'.repeat(40), headRefName: 'feature', baseRefName: 'main',
    statusCheckRollup: [{ conclusion: server && !ready ? 'FAILURE' : 'SUCCESS' }],
  }))
} else require(${JSON.stringify(ghFixture)})
`, { mode: 0o755 })
  git('init', '-q', '-b', 'feature')
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 'test@example.invalid')
  git('commit', '-qm', 'initial', '--allow-empty')
  git('remote', 'add', 'origin', 'git@github.com:o/r.git')
  seedState(data, [{ id: 'task', name: '검증 일감', paneId: 'shell', cwd: repo }])
  app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      TASKMINAL_USER_DATA: data,
      PATH: [bin, process.env['PATH'] ?? ''].join(delimiter),
      FAKE_GH_DIR: ghDir,
      TASKMINAL_CLAUDE_BIN: resolve(__dirname, '../fixtures/fake-claude.mjs'),
      TASKMINAL_CODEX_BIN: resolve(__dirname, '../fixtures/fake-codex.mjs'),
      FAKE_CLAUDE_LOG: join(data, 'claude.log'),
    },
  })
  win = await firstWindow(app)
  await waitLoaded(win)
})

test.afterEach(async () => {
  try { await app?.close() }
  finally {
    app = undefined
    rmSync(data, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('PR 검증 보고서는 다른 PR의 파일을 거절하고 새 PR head에서 이전 기록을 구분한다', async () => {
  const head = git('rev-parse', 'HEAD')
  const report = {
    version: 1, repository: 'o/r', pullRequest: 7, startSha: head, endSha: head,
    entries: [
      { criterion: '타입 검사 확인', check: 'npm run typecheck', exitCode: 0 },
      { criterion: '화면 확인', check: 'npm run e2e', exitCode: 4 },
    ],
  }
  await openPullRequests()
  const panel = win.getByTestId('git-workflow')
  await panel.getByText('검증 근거', { exact: true }).click()
  const evidence = panel.locator('details.pr-verification')
  async function importReport(pullRequest: number) {
    const chooser = win.waitForEvent('filechooser')
    await evidence.getByRole('button', { name: '검증 보고서 열기…' }).click()
    await (await chooser).setFiles({
      name: 'verification.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ ...report, pullRequest })),
    })
  }
  await importReport(7)
  await expect(evidence.getByRole('status')).toContainText('현재 PR 커밋 (마지막 조회 기준)')
  await expect(evidence.getByRole('listitem')).toHaveText([
    /타입 검사 확인.*기록된 결과 통과/, /화면 확인.*기록된 결과 e2e 미실행/,
  ])
  await importReport(8)
  await expect(evidence.getByRole('alert')).toContainText('이 PR의 검증 보고서')
  await expect(evidence.getByRole('status')).toContainText('현재 PR 커밋 (마지막 조회 기준)')
  git('commit', '-qm', 'advance the PR', '--allow-empty')
  await panel.getByRole('button', { name: '다시 읽기', exact: true }).click()
  await expect(evidence.getByRole('status')).toContainText('이전 커밋 · 다시 확인')
  await expect(evidence.getByRole('status')).toContainText(head.slice(0, 12))
  await evidence.getByRole('status').scrollIntoViewIfNeeded()
  await win.screenshot({ path: test.info().outputPath('pr-verification-stale.png') })
})

test('저장소 간 PR 순서를 보존하고 선행 체크 통과와 병합 뒤 보류 표시를 지운다', async () => {
  await openPullRequests()
  const panel = win.getByTestId('git-workflow')
  const summary = panel.getByText('저장소 간 PR 순서', { exact: true })
  await summary.click()
  const links = panel.getByRole('textbox', { name: 'PR 주소 · 위에서 아래 순서' })
  await links.fill([serverUrl, clientUrl].join('\n'))
  const refresh = () => panel.getByRole('button', { name: '목록 보관하고 상태 읽기', exact: true }).click()
  await refresh()
  const rows = panel.locator('.worktree-dependencies').getByRole('listitem')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toContainText('example/server #2 · Server change · 열림 · 체크 실패')
  await expect(rows.nth(1)).toContainText('검토 보류 · 선행 example/server #2 확인 필요')
  await rows.nth(1).scrollIntoViewIfNeeded()
  await win.screenshot({ path: test.info().outputPath('pr-dependency-blocked.png') })

  await win.getByRole('button', { name: '작업 보조 화면 닫기' }).click()
  await expect(panel).toHaveCount(0)
  await openPullRequests()
  await summary.click()
  await expect(links).toHaveValue([serverUrl, clientUrl].join('\n'))
  writeFileSync(join(ghDir, 'server-ready'), '')
  await refresh()
  await expect(rows.nth(0)).toContainText('example/server #2 · Server change · 병합됨 · 체크 통과')
  await expect(rows.nth(1)).toContainText('example/client #3 · Client change · 열림 · 체크 통과')
  await expect(rows.nth(1)).not.toContainText('검토 보류')
})

test('흐름의 계정별 0%와 미확인을 구분하고 조회 뒤 계정이 바뀌면 실행을 막는다', async () => {
  const resetsAt = Date.now() + 3_600_000
  // Only live provider status is stubbed. Account selection and workflow
  // start use their real IPC handlers with the temporary app data.
  await app!.evaluate(({ ipcMain }, reset) => {
    ipcMain.removeHandler('accounts:status')
    ipcMain.handle('accounts:status', (_event, id) => ({
      state: id === 'default-claude' ? 'ready' : 'signed-out',
      display: '테스트 계정',
      windows: id === 'default-claude' ? [{ label: '5시간', used: 0, resetsAt: reset }] : [],
      updatedAt: Date.now(),
    }))
  }, resetsAt)
  const workflow: Workflow = {
    id: 'preflight', name: '실행 전 확인',
    steps: [
      { id: 'build', name: '구현', agent: 'claude', prompt: 'build', after: [] },
      { id: 'review', name: '검토', agent: 'codex', prompt: 'review', after: ['build'] },
    ],
  }
  await win.evaluate(value => window.taskminal.workflows.save(value), workflow)
  await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('app:command', 'workflows'))
  const panel = win.getByRole('region', { name: '작업 흐름', exact: true })
  await panel.getByRole('combobox', { name: '저장된 작업 흐름' }).selectOption(workflow.id)
  const limits = panel.getByRole('region', { name: '실행 전 계정 한도' })
  await limits.getByRole('button', { name: '계정 한도 확인', exact: true }).click()
  await expect(limits).toContainText('Claude 기본 계정')
  await expect(limits).toContainText('0% 사용')
  await expect(limits.locator('time')).toHaveAttribute('datetime', new Date(resetsAt).toISOString())
  await expect(limits).toContainText('Codex 기본 계정')
  await expect(limits).toContainText('로그인 필요 · 한도 미확인')
  await win.screenshot({ path: test.info().outputPath('workflow-account-preflight.png') })

  await win.evaluate(async () => {
    await window.taskminal.accounts.add('claude', '교체한 Claude 계정')
    const account = (await window.taskminal.accounts.list()).find(item => item.name === '교체한 Claude 계정')
    if (!account) throw new Error('테스트 계정을 찾지 못했어요')
    await window.taskminal.accounts.select(account.id)
  })
  await panel.getByRole('button', { name: '저장된 흐름 실행', exact: true }).click()
  await expect(panel.getByRole('alert')).toContainText('선택 계정이 바뀌었어요')
  expect(await win.evaluate(async () => (await window.taskminal.workflows.view()).runs)).toEqual([])
  expect(existsSync(join(data, 'claude.log'))).toBe(false)
  await limits.getByRole('button', { name: '한도 다시 확인', exact: true }).click()
  await expect(limits).toContainText('교체한 Claude 계정')
  await expect(limits).not.toContainText('0% 사용')
})
