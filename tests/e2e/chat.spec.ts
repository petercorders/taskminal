import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { firstWindow, seedState, waitLoaded } from './helpers'

// 21단계: 대화 pane — 가짜 claude(tests/fixtures/fake-claude.mjs)로 글 · 도구 줄 · 허락 · 질문 · 재시작 이어 하기 · 허락 방식 · 오류 띠 · 멈춤 · 터미널 전환
const FAKE = resolve(__dirname, '../fixtures/fake-claude.mjs')
let userData: string
let log: string
let tui: string
let app: ElectronApplication | undefined
let win: Page

async function launch() {
  app = await electron.launch({
    args: ['.'],
    env: { ...process.env, TASKMINAL_USER_DATA: userData, TASKMINAL_CLAUDE_BIN: FAKE, FAKE_CLAUDE_LOG: log, TASKMINAL_CLAUDE_TUI: tui },
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
function fakeLog(): { argv?: string[]; stdin?: { type: string; response?: { response: Record<string, unknown> }; request?: { subtype: string; mode?: string } } }[] {
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}
const argvs = () => fakeLog().filter((l) => l.argv).map((l) => l.argv!)
const answers = () => fakeLog().filter((l) => l.stdin?.type === 'control_response').map((l) => l.stdin!.response!.response)

test.describe.configure({ timeout: 90_000 })
test.beforeEach(() => {
  userData = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-e2e-')))
  log = join(userData, 'fake-claude.log')
  const bin = join(userData, 'fakebin')
  mkdirSync(bin)
  tui = join(bin, 'claude-tui')
  writeFileSync(tui, '#!/bin/sh\necho "FAKE-TUI $*"\n')
  chmodSync(tui, 0o755)
  seedState(userData, [{ id: 'task-a', name: 'A 일감', paneId: 'pane-a', cwd: userData }])
})
test.afterEach(async () => {
  await app?.close()
  app = undefined
  rmSync(userData, { recursive: true, force: true })
})

test('새 대화 → 처음 화면 → 보내기: 글 · 도구 묶음 줄 · 끝남', async () => {
  await launch()
  // ⌘P 로도 열 수 있다
  await win.keyboard.press('Meta+p')
  await win.keyboard.type('새 대화')
  await win.keyboard.press('Enter')
  await expect(chat().getByTestId('chat-empty')).toBeVisible()
  await expect(input()).toBeFocused()
  await say('안녕')
  await expect(chat().locator('[data-kind="text"]')).toHaveText('echo: 안녕')
  const tools = chat().locator('[data-kind="tools"]')
  await expect(tools).toContainText('Read · a.ts')
  await expect(chat().getByTestId('chat-status')).toContainText('✓ 끝남')
  await tools.getByRole('button').click()
  await expect(tools.getByTestId('chat-tool-item')).toContainText('export const a = 1')
  await expect(chat().getByTestId('chat-block').first()).toHaveText('안녕')
  await win.screenshot({ path: 'test-results/chat-basic.png' })
})

test('허락 카드: ↩ 는 원래 입력으로 허락, Esc 는 입력창 글을 이유로 거절', async () => {
  await launch()
  await command('chat-new')
  await say('perm 1')
  const card = chat().getByTestId('perm-card')
  await expect(card).toContainText('touch made.txt')
  await expect(chat().getByTestId('chat-status')).toContainText('입력 기다림 · 허락')
  await expect(card.getByRole('button', { name: '이 명령만 늘 허락 ⌥↩' })).toBeVisible()
  await win.screenshot({ path: 'test-results/chat-perm.png' })
  await input().press('Enter')
  await expect(card).toHaveAttribute('data-answer', 'allow')
  await expect(chat().locator('[data-kind="text"]').last()).toHaveText('허락 받음 · touch made.txt')
  expect(answers()[0]).toEqual({ behavior: 'allow', updatedInput: { command: 'touch made.txt' } })

  await say('perm danger')
  const card2 = chat().getByTestId('perm-card').last()
  await expect(card2).toContainText('rm -rf build')
  // 위험 명령은 '늘 허락' 이 없다 · ⌥↩ 도 아무것도 하지 않는다
  await expect(card2.getByRole('button', { name: '이 명령만 늘 허락 ⌥↩' })).toHaveCount(0)
  await input().press('Alt+Enter')
  await expect(card2).toHaveAttribute('data-answer', '')
  await input().fill('npm run clean 으로 해 줘')
  await input().press('Escape')
  await expect(card2).toHaveAttribute('data-answer', 'deny')
  await expect(chat().locator('[data-kind="text"]').last()).toHaveText('거절됨 · npm run clean 으로 해 줘')
  await expect(input()).toHaveValue('')
})

test('질문 카드: 숫자로 고르고 ↩ — 고른 label 이 answers 로', async () => {
  await launch()
  await command('chat-new')
  await say('ask')
  const card = chat().getByTestId('ask-card')
  await expect(card).toContainText('어느 색이 좋아요?')
  await expect(chat().getByTestId('chat-status')).toContainText('입력 기다림 · 질문')
  await input().press('2')
  await expect(card.getByRole('radio', { name: /파랑/ })).toHaveAttribute('aria-checked', 'true')
  await win.screenshot({ path: 'test-results/chat-ask.png' })
  await input().press('Enter')
  await expect(card).toHaveAttribute('data-answer', 'answer')
  await expect(chat().locator('[data-kind="text"]').last()).toHaveText('고른 색: 파랑')
})

test('재시작 뒤 같은 세션 · 허락 방식 유지 · 앞 대화가 보임', async () => {
  await launch()
  await command('chat-new')
  await chat().getByTestId('chat-perm').click()
  await chat().getByRole('menuitemradio', { name: '자동', exact: true }).click()
  await expect(chat().getByTestId('chat-perm')).toHaveText('허락: 자동 ▾')
  await say('첫 말')
  await expect(chat().locator('[data-kind="text"]')).toHaveText('echo: 첫 말')
  const first = argvs()[0]!
  expect(first).toEqual(expect.arrayContaining(['--permission-mode', 'auto']))
  expect(first).not.toContain('--resume')
  await app!.close()
  app = undefined

  await launch()
  await expect(chat().locator('[data-kind="text"]')).toHaveText('echo: 첫 말')
  await expect(chat().getByTestId('chat-perm')).toHaveText('허락: 자동 ▾')
  await expect(chat().locator('.chat-auto')).toBeVisible()
  await say('둘째 말')
  await expect(chat().locator('[data-kind="text"]').last()).toHaveText('echo: 둘째 말')
  const second = argvs()[1]!
  const at = second.indexOf('--resume')
  expect(at).toBeGreaterThan(0)
  expect(second[at + 1]).toMatch(/^sess-\d+$/)
  expect(second).toEqual(expect.arrayContaining(['--permission-mode', 'auto']))
})

test('떠 있는 대화에서 허락 방식을 바꾸면 set_permission_mode', async () => {
  await launch()
  await command('chat-new')
  await say('하나')
  await expect(chat().getByTestId('chat-status')).toContainText('✓ 끝남')
  await chat().getByTestId('chat-perm').click()
  await chat().getByRole('menuitemradio', { name: '파일 고치기는 자동' }).click()
  await expect.poll(() => fakeLog().find((l) => l.stdin?.request?.subtype === 'set_permission_mode')?.stdin?.request?.mode).toBe('acceptEdits')
})

test('로그인 없음 · 갑자기 끝남 · 다시 시도', async () => {
  await launch()
  await command('chat-new')
  await say('login')
  await expect(chat().getByTestId('chat-band')).toHaveAttribute('data-error', 'login')
  await expect(chat().getByTestId('chat-band')).toHaveCount(1) // 같은 턴의 실패 띠는 따로 안 보임
  await say('crash now')
  const band = chat().getByTestId('chat-band').last()
  await expect(band).toHaveAttribute('data-error', 'crash')
  await expect(band).toContainText('종료 코드 3')
  await expect(chat().getByTestId('chat-status')).toContainText('✕ 실패')
  await win.screenshot({ path: 'test-results/chat-fail.png' })
  const before = fakeLog().filter((l) => l.stdin?.type === 'user').length
  await band.getByRole('button', { name: '다시 시도' }).click()
  await expect.poll(() => fakeLog().filter((l) => l.stdin?.type === 'user').length).toBe(before + 1)
  expect(argvs()).toHaveLength(2) // 끝난 프로세스 대신 새로 띄움
})

test('⌘. 멈춤 → 실패가 아니라 멈춤 · 실행 중 ↩ 는 보내지 않음', async () => {
  await launch()
  await command('chat-new')
  await say('slow job')
  await expect(chat().getByTestId('chat-status')).toContainText('실행 중')
  await say('끼어들기')
  await expect(chat().getByTestId('chat-hint')).toHaveText('끝나면 보낼 수 있어요 · ⌘. 멈춤')
  await expect(input()).toHaveValue('끼어들기')
  await input().press('Meta+.')
  await expect(chat().getByTestId('chat-status')).toHaveText('■ 멈춤(내가 멈춤)')
  await expect(chat().getByTestId('chat-band')).toHaveCount(0)
  expect(fakeLog().filter((l) => l.stdin?.type === 'user')).toHaveLength(1)
})

test('허락 카드가 열린 채 프로세스가 끝나면 카드는 응답 없이 끝남', async () => {
  await launch()
  await command('chat-new')
  await say('permdie')
  const card = chat().getByTestId('perm-card')
  await expect(card).toHaveAttribute('data-answer', 'lost', { timeout: 10_000 })
  await expect(card.getByRole('button', { name: '허락 ↩' })).toHaveCount(0)
  await input().press('Enter') // 굳은 카드에 ↩ 를 눌러도 아무것도 가지 않는다
  expect(answers()).toHaveLength(0)
})

test('⇧⌘J: 같은 자리에 터미널, 시작 명령은 claude --resume <세션>', async () => {
  await launch()
  await command('chat-new')
  await say('하나')
  await expect(chat().getByTestId('chat-status')).toContainText('✓ 끝남')
  await command('chat-terminal')
  await expect(chat()).toHaveCount(0)
  const term = win.locator('[data-testid="task-view"][aria-hidden="false"] [data-testid="tab-view"]:visible .xterm-rows')
  await expect(term).toContainText(/FAKE-TUI --resume sess-\d+/, { timeout: 15_000 })
})

test('비밀값: 화면 · 대화 파일에 원문이 없다', async () => {
  await launch()
  await command('chat-new')
  await say('secret please')
  await expect(chat().locator('[data-kind="text"]')).toContainText('‹가림')
  await expect(chat()).not.toContainText('FAKEFAKEFAKE')
  const dir = join(userData, 'chat')
  await expect.poll(() => (existsSync(dir) ? readdirSync(dir).length : 0)).toBe(1)
  const raw = readFileSync(join(dir, readdirSync(dir)[0]!), 'utf8')
  expect(raw).toContain('‹가림')
  expect(raw).not.toContain('FAKEFAKEFAKE')
})
