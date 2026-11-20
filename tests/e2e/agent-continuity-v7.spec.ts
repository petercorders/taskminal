import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { firstWindow, seedState, waitLoaded } from './helpers'

const claudeBin = resolve('tests/fixtures/fake-claude.mjs')
const codexBin = resolve('tests/fixtures/fake-codex.mjs')
const quiet = { banner: false, sound: false }
const taskName = '작업 결과 검토'
let data: string
let repo: string
let claudeLog: string
let codexLog: string
let app: ElectronApplication | undefined
let win: Page

async function launch() {
  app = await electron.launch({
    args: ['.'],
    env: { ...process.env, TASKMINAL_USER_DATA: data, TASKMINAL_CLAUDE_BIN: claudeBin, TASKMINAL_CODEX_BIN: codexBin,
      FAKE_CLAUDE_LOG: claudeLog, FAKE_CODEX_LOG: codexLog, ZDOTDIR: join(data, 'zdot') },
  })
  win = await firstWindow(app)
  await waitLoaded(win)
}

async function openClaude() {
  await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('app:command', 'chat-new'))
  await expect(chat()).toHaveAttribute('data-agent', 'claude')
}

const view = () => win.locator('[data-testid="task-view"][aria-hidden="false"]')
const chat = () => view().getByTestId('chat-pane').filter({ visible: true })
const input = () => chat().getByTestId('chat-input')
const reply = () => chat().locator('[data-kind="text"]').last()
const status = () => chat().getByTestId('chat-status')
const overview = () => win.getByTestId('overview')
const actions = () => overview().getByRole('region', { name: '지금 할 일' })

async function say(text: string) {
  await input().fill(text)
  await input().press('Enter')
}

async function openOverview() {
  await win.getByRole('button', { name: /^전체 보기/ }).filter({ visible: true }).click()
  await expect(overview()).toBeVisible()
}

interface EventRecord { argv?: string[]; stdin?: { method?: string }; t?: string; id?: string }
function readRecords(file: string): EventRecord[] {
  if (!existsSync(file)) return []
  const text = readFileSync(file, 'utf8')
  // 마지막 줄이 쓰이는 중이면 다음 조회에서 읽는다.
  return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => JSON.parse(line) as EventRecord)
}
const claudeStarts = () => readRecords(claudeLog).flatMap(record => record.argv?.includes('--output-format') ? [record.argv] : [])
const codexRequests = () => readRecords(codexLog).flatMap(record => record.stdin?.method ? [record.stdin.method] : [])

function originalSession() {
  const dir = join(data, 'chat')
  if (!existsSync(dir)) return undefined
  return readdirSync(dir).filter(file => file.endsWith('.jsonl')).flatMap(file => readRecords(join(dir, file)))
    .find(record => record.t === 'session')?.id
}

test.describe.configure({ timeout: 60_000 })
test.beforeEach(() => {
  data = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-continuity-v7-')))
  repo = join(data, 'repo')
  claudeLog = join(data, 'fake-claude.log')
  codexLog = join(data, 'fake-codex.log')
  mkdirSync(repo)
  mkdirSync(join(data, 'zdot'))
  seedState(data, [{ id: 'review-task', name: taskName, paneId: 'shell-a', cwd: repo }], [],
    { notify: { wait: quiet, long: quiet, fail: quiet, exit: quiet } })
})

test.afterEach(async () => {
  try { await app?.close() }
  finally {
    app = undefined
    rmSync(data, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('지금 할 일에서 입력을 기다리는 대화를 열고 답한 요청을 목록에서 내린다', async () => {
  await launch()
  await openClaude()
  await say('ask')
  await expect(chat().getByTestId('ask-card')).toContainText('어느 색이 좋아요?')
  await openOverview()
  const waiting = actions().getByRole('button', { name: /입력·허락 기다림.*작업 결과 검토/ })
  await expect(waiting).toBeVisible()
  await waiting.click()
  await expect(overview()).toHaveCount(0)
  await expect(view()).toHaveAttribute('data-task-name', taskName)
  await expect(chat().getByTestId('ask-card')).toBeVisible()
  await input().press('2')
  await input().press('Enter')
  await expect(reply()).toHaveText('고른 색: 파랑')
  await expect(status()).toContainText('끝남')
  await openOverview()
  await expect(waiting).toHaveCount(0)
  await expect(actions()).toContainText('지금 기다리는 행동이 없어요.')
})

test('Claude 인계 초안을 편집해 같은 일감의 Codex 입력칸에 넣고 원래 대화를 유지한다', async () => {
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args])
  git('init', '-q')
  writeFileSync(join(repo, 'changed.txt'), '처음\n')
  git('add', 'changed.txt')
  git('commit', '-qm', 'initial')
  writeFileSync(join(repo, 'changed.txt'), '변경\n')
  await launch()
  await openClaude()
  const sourceTab = await view().getByRole('tab', { selected: true }).getAttribute('id')
  await say('검토할 변경 정리')
  await expect(reply()).toHaveText('echo: 검토할 변경 정리')
  await expect(status()).toContainText('끝남')
  await chat().getByRole('button', { name: 'Codex로 인계…' }).click()
  const dialog = win.getByRole('dialog', { name: 'Codex로 인계' })
  const draft = dialog.getByRole('textbox', { name: '인계 초안' })
  await expect(draft).toHaveValue(/검토할 변경 정리/)
  await expect(draft).toHaveValue(/changed\.txt/)
  await expect(draft).toHaveValue(/현재 커밋의 검사 결과 미확인/)
  const edit = '검사 결과는 미확인입니다. changed.txt부터 검토해 주세요.'
  await draft.fill(edit)
  await dialog.getByRole('button', { name: 'Codex 입력칸에 넣기' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(view()).toHaveAttribute('data-task-name', taskName)
  await expect(chat()).toHaveAttribute('data-agent', 'codex')
  await expect(input()).toHaveValue(edit)
  await expect(chat().getByTestId('chat-draft-note')).toBeVisible()
  expect(codexRequests()).not.toContain('turn/start')
  expect(sourceTab).toBeTruthy()
  await view().locator(`[id=${JSON.stringify(sourceTab)}]`).click()
  await expect(chat()).toHaveAttribute('data-agent', 'claude')
  await expect(reply()).toHaveText('echo: 검토할 변경 정리')
  expect(codexRequests()).not.toContain('turn/start')
})

test('휴면을 앱 재시작 뒤에도 유지하고 다음 요청에서 원래 세션을 재개한다', async () => {
  await launch()
  await openClaude()
  await say('휴면 전 작업')
  await expect(reply()).toHaveText('echo: 휴면 전 작업')
  await expect(status()).toContainText('끝남')
  await expect.poll(originalSession).toMatch(/^sess-\d+$/)
  const sessionId = originalSession()!
  await chat().getByRole('button', { name: '대화 휴면' }).click()
  await expect(status()).toHaveText('휴면 중')
  await expect(chat().getByTestId('chat-send')).toBeDisabled()

  await app!.close()
  app = undefined
  await launch()
  await expect(chat()).toHaveAttribute('data-agent', 'claude')
  await expect(reply()).toHaveText('echo: 휴면 전 작업')
  await expect(status()).toHaveText('휴면 중')
  await input().fill('휴면 뒤 작업')
  await expect(chat().getByTestId('chat-send')).toBeDisabled()
  await input().press('Enter')
  await expect(input()).toHaveValue('휴면 뒤 작업')
  expect(claudeStarts()).toHaveLength(1)
  await chat().getByRole('button', { name: '휴면 풀기' }).click()
  await expect(status()).not.toHaveText('휴면 중')
  expect(claudeStarts()).toHaveLength(1)
  await input().press('Enter')
  await expect(reply()).toHaveText('echo: 휴면 뒤 작업')
  await expect.poll(claudeStarts).toHaveLength(2)
  const resumed = claudeStarts()[1]!
  expect(resumed.slice(resumed.indexOf('--resume'), resumed.indexOf('--resume') + 2)).toEqual(['--resume', sessionId])
})
