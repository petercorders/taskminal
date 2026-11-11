import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { firstWindow, seedState, waitLoaded } from './helpers'

// 22단계: Codex 대화 — 가짜 codex(tests/fixtures/fake-codex.mjs, app-server JSON-RPC 대본)로 보내기 · 승인 · 로그인 없음 · 재시작 이어 하기 · 그림 · 되감기
const FAKE = resolve(__dirname, '../fixtures/fake-codex.mjs')
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
let userData: string
let log: string
let app: ElectronApplication | undefined
let win: Page

async function launch(env: Record<string, string> = {}) {
  app = await electron.launch({
    args: ['.'],
    env: { ...process.env, TASKMINAL_USER_DATA: userData, TASKMINAL_CODEX_BIN: FAKE, FAKE_CODEX_LOG: log, ...env },
  })
  win = await firstWindow(app)
  await waitLoaded(win)
}
async function command(c: string) {
  await app!.evaluate(({ BrowserWindow }, cmd) => BrowserWindow.getAllWindows()[0]!.webContents.send('app:command', cmd), c)
}
const chat = () => win.locator('[data-testid="task-view"][aria-hidden="false"] [data-testid="chat-pane"]')
const input = () => chat().getByTestId('chat-input')
async function say(text: string) {
  await input().fill(text)
  await input().press('Enter')
}
interface Line {
  argv?: string[]
  stdin?: { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown> }
}
function fakeLog(): Line[] {
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Line)
}
const calls = (m: string) => fakeLog().filter((l) => l.stdin?.method === m).map((l) => l.stdin!.params!)
const replies = () => fakeLog().filter((l) => l.stdin && l.stdin.method === undefined && l.stdin.result).map((l) => l.stdin!.result!)

test.describe.configure({ timeout: 90_000 })
test.beforeEach(() => {
  userData = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-e2e-')))
  log = join(userData, 'fake-codex.log')
  seedState(userData, [{ id: 'task-a', name: 'A 일감', paneId: 'pane-a', cwd: userData }])
})
test.afterEach(async () => {
  await app?.close()
  app = undefined
  rmSync(userData, { recursive: true, force: true })
})

test('⌘P 새 대화 (Codex) → 보내기: 배지 · 글 · 명령 줄 · 끝남', async () => {
  await launch()
  await win.keyboard.press('Meta+p')
  await win.keyboard.type('새 대화 (Codex)')
  await win.keyboard.press('Enter')
  await expect(chat()).toHaveAttribute('data-agent', 'codex')
  await expect(chat().getByTestId('chat-agent')).toHaveText('Codex')
  await expect(chat().getByTestId('chat-empty')).toContainText('Codex 와 대화를 시작해요')
  await say('안녕')
  await expect(chat().locator('[data-kind="text"]')).toHaveText('echo: 안녕')
  await expect(chat().locator('[data-kind="tools"]')).toContainText('cat a.ts')
  await expect(chat().getByTestId('chat-status')).toContainText('✓ 끝남')
  await expect(chat().getByTestId('chat-model')).toHaveText('Codex · gpt-fake')
  expect(fakeLog()[0]!.argv).toEqual(['app-server'])
  expect(calls('thread/start')[0]).toMatchObject({ cwd: userData, approvalPolicy: 'untrusted', sandbox: 'workspace-write' })
  await win.screenshot({ path: 'test-results/chat-codex-basic.png' })
})

test('같은 카드로 승인: ↩ accept · Esc decline', async () => {
  await launch()
  await command('chat-new-codex')
  await say('perm 1')
  const card = chat().getByTestId('perm-card')
  await expect(card).toContainText('touch made.txt')
  await expect(chat().getByTestId('chat-status')).toContainText('입력 기다림 · 허락')
  await win.screenshot({ path: 'test-results/chat-codex-perm.png' })
  await input().press('Enter')
  await expect(card).toHaveAttribute('data-answer', 'allow')
  await expect(chat().locator('[data-kind="text"]').last()).toHaveText('허락 받음 · touch made.txt')
  expect(replies()[0]).toEqual({ decision: 'accept' })

  await say('perm 2')
  await expect(chat().getByTestId('perm-card')).toHaveCount(2) // 첫 카드도 같은 글이라 개수로 기다린다
  const card2 = chat().getByTestId('perm-card').last()
  await expect(card2).toContainText('touch made.txt')
  await input().press('Escape')
  await expect(card2).toHaveAttribute('data-answer', 'deny')
  await expect(card2).toContainText('거절함')
  await expect(chat().locator('[data-kind="text"]').last()).toHaveText('거절됨 · decline')
  expect(replies()[1]).toEqual({ decision: 'decline' })
})

test('로그인 없음: 보내기 전에 막혀 turn/start 가 가지 않고 로그인 띠', async () => {
  await launch({ FAKE_CODEX_NOLOGIN: '1' })
  await command('chat-new-codex')
  await say('안녕')
  const band = chat().getByTestId('chat-band')
  await expect(band).toHaveAttribute('data-error', 'login')
  await expect(band).toContainText('Codex 에 로그인되어 있지 않아요')
  await expect(band).toContainText('codex login')
  expect(calls('account/read')).toHaveLength(1)
  expect(calls('turn/start')).toHaveLength(0)
  expect(calls('thread/start')).toHaveLength(0)
  await win.screenshot({ path: 'test-results/chat-codex-login.png' })
})

test('재시작 뒤 thread/resume 에 저장된 스레드 id · 앞 대화가 보임', async () => {
  await launch()
  await command('chat-new-codex')
  await say('첫 말')
  await expect(chat().locator('[data-kind="text"]')).toHaveText('echo: 첫 말')
  const thread = calls('turn/start')[0]!['threadId']
  expect(thread).toMatch(/^th-\d+-1$/)
  await app!.close()
  app = undefined

  await launch()
  await expect(chat()).toHaveAttribute('data-agent', 'codex')
  await expect(chat().locator('[data-kind="text"]')).toHaveText('echo: 첫 말')
  await say('둘째 말')
  await expect(chat().locator('[data-kind="text"]').last()).toHaveText('echo: 둘째 말')
  expect(calls('thread/resume')[0]).toMatchObject({ threadId: thread })
  expect(calls('thread/start')).toHaveLength(1)
})

test('그림: 📎 → 칩 → 보내기 → codex 가 받은 localImage 경로에 파일이 있다 · 메시지에 그림 칩', async () => {
  const png = join(userData, 'dot.png')
  writeFileSync(png, Buffer.from(PNG, 'base64'))
  await launch()
  await app!.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [f] })) as typeof dialog.showOpenDialog
  }, png)
  await command('chat-new-codex')
  await chat().getByTestId('chat-attach').click()
  await expect(chat().getByTestId('chat-images')).toContainText('dot.png')
  await say('look')
  await expect(chat().locator('[data-kind="text"]')).toHaveText('echo: look · 그림 1')
  await expect(chat().getByTestId('chat-user-images')).toContainText('dot.png')
  await expect(chat().getByTestId('chat-images')).toHaveCount(0)
  const input0 = calls('turn/start')[0]!['input'] as Array<{ type: string; path?: string }>
  const img = input0.find((x) => x.type === 'localImage')!
  expect(img.path).toContain(join(userData, 'chat'))
  expect(readFileSync(img.path!).equals(Buffer.from(PNG, 'base64'))).toBe(true)
  await win.screenshot({ path: 'test-results/chat-codex-image.png' })
})

test('되감기: 두 번째 메시지로 되감기 → 이후 사라짐 · 입력창에 그 글 · 다음 보내기가 thread/fork(첫 턴)', async () => {
  await launch()
  await command('chat-new-codex')
  await say('하나')
  await expect(chat().locator('[data-kind="text"]')).toHaveText('echo: 하나')
  await say('둘')
  await expect(chat().locator('[data-kind="text"]').last()).toHaveText('echo: 둘')
  const users = chat().locator('[data-kind="user"]')
  await users.nth(1).hover()
  await users.nth(1).getByTestId('chat-rewind').click()
  const confirm = chat().getByTestId('rewind-confirm')
  await expect(confirm).toContainText('여기로 되돌릴까요?')
  await expect(confirm).toContainText('파일은 그대로')
  await win.screenshot({ path: 'test-results/chat-codex-rewind.png' })
  await confirm.getByRole('button', { name: '되돌리기 ↩' }).click()
  await expect(users).toHaveCount(1)
  await expect(chat().locator('[data-kind="text"]')).toHaveText('echo: 하나')
  await expect(input()).toHaveValue('둘')
  const firstThread = calls('turn/start')[0]!['threadId']
  await say('둘 다시')
  await expect(chat().locator('[data-kind="text"]').last()).toHaveText('echo: 둘 다시')
  const fork = calls('thread/fork')[0]!
  expect(fork['threadId']).toBe(firstThread)
  expect(fork['lastTurnId']).toMatch(/^turn-\d+-1$/)
})
