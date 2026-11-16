import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { firstWindow, seedState, waitLoaded } from './helpers'

// 52단계: Claude 한도 실수치 — ① 대화 pane 의 rate_limit_event(가짜 claude 대화) ② 터미널 TUI statusLine(가짜 claude 가 --settings 의 statusLine 을 부름).
// CLAUDE_CONFIG_DIR 을 임시 폴더로 줘 '사용자 statusLine' 을 시험이 정한다(실제 ~/.claude 는 읽지 않는다). 가짜는 실제 statusLine 주기 · 신뢰 화면을 흉내 내지 않는다.
const FAKE_CHAT = resolve(__dirname, '../fixtures/fake-claude.mjs')
const FAKE_BIN = resolve(__dirname, '../fixtures/agent-bin')
let userData: string
let app: ElectronApplication | undefined
let win: Page

async function launch() {
  const zdot = join(userData, 'zdot')
  mkdirSync(zdot, { recursive: true })
  app = await electron.launch({
    args: ['.'],
    env: { ...process.env, TASKMINAL_USER_DATA: userData, TASKMINAL_CLAUDE_BIN: FAKE_CHAT, ZDOTDIR: zdot, CLAUDE_CONFIG_DIR: join(userData, 'claude-config') },
  })
  win = await firstWindow(app)
  await waitLoaded(win)
}
const term = (id: string) => win.getByTestId(`pane-${id}`)
const screenOf = (id: string) => term(id).locator('.xterm-rows').innerText()
async function waitText(id: string, re: RegExp): Promise<RegExpMatchArray> {
  let m: RegExpMatchArray | null = null
  await expect.poll(async () => (m = (await screenOf(id)).replace(/\n/g, '').match(re)) !== null, { timeout: 20_000 }).toBe(true)
  return m!
}
async function type(line: string) {
  await win.keyboard.type(line)
  await win.keyboard.press('Enter')
}
const bars = () => win.getByTestId('usage-bars')

test.describe.configure({ timeout: 120_000 })
test.beforeEach(() => {
  userData = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-e2e-')))
  mkdirSync(join(userData, 'claude-config'))
  seedState(userData, [{ id: 'task-a', name: 'A 일감', paneId: 'pane-a', cwd: userData }])
})
test.afterEach(async () => {
  await app?.close()
  app = undefined
  rmSync(userData, { recursive: true, force: true, maxRetries: 5 })
})

test('대화의 한도 사건 → 사이드바 5시간 · 주간 막대(90% 빨강) · 계정 화면 · 다시 열어도 남는다', async () => {
  await launch()
  await expect(bars()).toHaveCount(0) // 아직 값이 없으면 막대가 없다
  await win.keyboard.press('Meta+p')
  await win.keyboard.type('새 대화 (Claude)')
  await win.keyboard.press('Enter')
  const input = win.locator('[data-testid="task-view"][aria-hidden="false"] [data-testid="chat-input"]')
  await input.fill('usage 25 92')
  await input.press('Enter')
  await expect(bars()).toBeVisible({ timeout: 15_000 })
  await expect(win.getByTestId('usage-fiveHour')).toContainText('25%')
  await expect(win.getByTestId('usage-fiveHour')).toHaveAttribute('data-tone', 'ok')
  await expect(win.getByTestId('usage-sevenDay')).toContainText('92%')
  await expect(win.getByTestId('usage-sevenDay')).toHaveAttribute('data-tone', 'danger')
  await expect(bars()).toHaveAttribute('aria-label', /Claude 한도 · 5시간 25% \(1시간 \d+분 뒤 초기화\) · 주간 92% .* 대화에서 받은 값/)
  await win.screenshot({ path: 'test-results/usage-bars.png' })
  // 저장 파일 0600
  const file = join(userData, 'usage.json')
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(JSON.parse(readFileSync(file, 'utf8'))['default-claude'].sevenDay.used).toBe(92)

  // 막대를 누르면 사용량·계정
  await bars().click()
  const panel = win.locator('.work-usage')
  await expect(panel).toContainText('조회됨', { timeout: 15_000 })
  await expect(panel).toContainText('주간 · 92% 사용')
  await expect(panel).toContainText('대화에서 받은 값')

  // 다시 열어도 마지막 값이 보인다
  await app!.close()
  app = undefined
  await launch()
  await expect(win.getByTestId('usage-sevenDay')).toContainText('92%')
})

test('터미널의 claude statusLine: 한도를 막대로 보이고, 사용자의 원래 statusLine 을 이어 부른다', async () => {
  writeFileSync(join(userData, 'claude-config', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'echo USER-LINE' } }))
  await launch()
  await term('pane-a').click()
  await waitText('pane-a', /%/)
  await type(`export PATH="${FAKE_BIN}:$PATH"; claude`)
  await waitText('pane-a', /FAKE READY/)
  await type('status 71 12')
  // 사용자 statusLine 의 출력이 그대로 claude 에게 돌아간다
  await waitText('pane-a', /STATUS OUT: \[USER-LINE\]/)
  await expect(win.getByTestId('usage-fiveHour')).toContainText('71%', { timeout: 10_000 })
  await expect(win.getByTestId('usage-fiveHour')).toHaveAttribute('data-tone', 'warn')
  await expect(bars()).toHaveAttribute('aria-label', /터미널에서 받은 값/)
  // 상태 파일에는 한도만 — 폴더 · 모델은 없다
  const status = readFileSync(join(userData, 'agent-events', 'pane-a.status'), 'utf8')
  expect(status).toMatch(/^v1\t/)
  expect(status).not.toContain('Fake')

  // 사용자 statusLine 을 바꾸면 새 셸부터 그 값을 잇는다(처음 한 번만 읽지 않는다)
  writeFileSync(join(userData, 'claude-config', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'echo USER-TWO' } }))
  await type('quit')
  await waitText('pane-a', /FAKE BYE/)
  await win.keyboard.press('Meta+t') // 새 탭 = 새 셸
  await waitTextActive(/%/)
  await type(`export PATH="${FAKE_BIN}:$PATH"; claude`)
  await waitTextActive(/FAKE READY/)
  await type('status 5 5')
  await waitTextActive(/STATUS OUT: \[USER-TWO\]/)
})

/** 지금 보이는 탭의 마지막 터미널 화면 */
async function waitTextActive(re: RegExp) {
  const rows = win.locator('[data-testid="task-view"][aria-hidden="false"] .xterm-rows').last()
  await expect.poll(async () => re.test((await rows.innerText()).replace(/\n/g, '')), { timeout: 20_000 }).toBe(true)
}
