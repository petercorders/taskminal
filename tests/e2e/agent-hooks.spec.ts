import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { firstWindow, seedState, waitLoaded } from './helpers'

// 51단계: 터미널에서 띄운 claude 의 상태 훅. 가짜 claude(tests/fixtures/agent-bin/claude)가 받은 --settings 의 훅 명령을 실제 sh 로 부른다.
// 사용자 dotfile(alias · PATH)이 시험을 흔들지 않게 빈 ZDOTDIR 로 띄운다. 실제 claude 는 부르지 않는다(PATH 앞에 가짜).
const FAKE_BIN = resolve(__dirname, '../fixtures/agent-bin')
let userData: string
let app: ElectronApplication | undefined
let win: Page

async function launch(settings: Record<string, unknown> = {}) {
  seedState(
    userData,
    [
      { id: 'task-a', name: 'A 일감', paneId: 'pane-a', cwd: userData },
      { id: 'task-b', name: 'B 일감', paneId: 'pane-b', cwd: userData },
    ],
    [],
    settings,
  )
  const zdot = join(userData, 'zdot')
  mkdirSync(zdot, { recursive: true })
  app = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: userData, ZDOTDIR: zdot } })
  win = await firstWindow(app)
  await waitLoaded(win)
}

const term = (id: string) => win.getByTestId(`pane-${id}`)
const screenOf = (id: string) => term(id).locator('.xterm-rows').innerText()
const headOf = (id: string) => win.locator(`[data-testid="pane-slot"][data-pane-id="${id}"]`).getByTestId('pane-head')
const row = (name: string) => win.locator(`[data-testid="task-row"][data-task-name="${name}"]`)
async function waitText(id: string, re: RegExp): Promise<RegExpMatchArray> {
  let m: RegExpMatchArray | null = null
  await expect.poll(async () => (m = (await screenOf(id)).replace(/\n/g, '').match(re)) !== null, { timeout: 20_000 }).toBe(true)
  return m!
}
async function type(line: string) {
  await win.keyboard.type(line)
  await win.keyboard.press('Enter')
}

test.describe.configure({ timeout: 120_000 })
test.beforeEach(() => {
  userData = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-e2e-')))
})
test.afterEach(async () => {
  await app?.close()
  app = undefined
  rmSync(userData, { recursive: true, force: true, maxRetries: 5 })
})

test('터미널의 claude: 훅 설정을 붙여 띄우고 작업 중 → 허락 기다림 → (안 볼 때) 턴 끝 확인 필요 → 새로 고침 뒤 복원 → 세션 끝', async () => {
  await launch()
  const hooks = join(userData, 'agent-hooks')
  expect(statSync(hooks).mode & 0o777).toBe(0o700)
  expect(statSync(join(hooks, 'claude-hook.sh')).mode & 0o777).toBe(0o700)

  await term('pane-a').click()
  await waitText('pane-a', /%/)
  await type(`export PATH="${FAKE_BIN}:$PATH"; claude -r abc`)
  // 셸 함수가 이 실행에만 --settings 를 붙였다(사용자 설정 파일이 아니라 앱의 훅 파일)
  // 63단계: 같은 함수가 Taskminal 명령 안내도 --append-system-prompt 로 붙인다(설정 기본 켬) — 안내는 여러 줄이라 사이를 건너뛴다
  const m = await waitText('pane-a', /FAKE ARGS: --settings (\S+claude-settings\.json) --append-system-prompt [\s\S]*? -r abc/)
  expect(m[1]).toBe(join(hooks, 'claude-settings.json'))
  await waitText('pane-a', /FAKE READY/)
  await expect(headOf('pane-a').getByTestId('pane-status')).toContainText('Claude · 작업 중')
  await expect(row('A 일감').getByTestId('task-last')).toContainText('Claude · 작업 중')

  // 보고 있는 pane 의 허락 기다림: 상태만(확인 필요 아님)
  await type('perm')
  await waitText('pane-a', /FAKE PERM/)
  await expect(headOf('pane-a').getByTestId('pane-status')).toContainText('Claude · 허락 기다림')
  await expect(headOf('pane-a')).toHaveAttribute('data-activity', 'waiting')
  await expect(win.getByTestId('attention-section')).toHaveCount(0)

  // 도구가 돌면 작업 중으로 · 2초 뒤 턴 끝을 다른 일감을 보는 동안 받는다 → 확인 필요
  await type('go')
  await expect(headOf('pane-a').getByTestId('pane-status')).toContainText('Claude · 작업 중')
  await type('later')
  await waitText('pane-a', /FAKE LATER/)
  await row('B 일감').click()
  const needA = win.getByTestId('attention-section').locator('[data-task-name="A 일감"]')
  await expect(needA).toBeVisible({ timeout: 10_000 })
  await expect(needA).toContainText('Claude · 끝남')
  await win.screenshot({ path: 'test-results/agent-hooks-attention.png' })

  // 기록 파일: 사건 이름만, 프롬프트 글은 없다
  const log = readFileSync(join(userData, 'agent-events', 'pane-a.log'), 'utf8')
  expect(log).toMatch(/\tclaude\tUserPromptSubmit\t\n/)
  expect(log).toMatch(/\tclaude\tStop\t\n$/)
  expect(log).not.toContain('SECRET-PROMPT')

  // 다시 보고 → 허락 기다림으로 둔 채 창을 새로 고침 → 셸 지킴이에 남은 셸 + 기록 파일의 마지막 사건으로 복원
  await needA.click()
  await term('pane-a').click()
  await type('perm')
  await waitText('pane-a', /FAKE PERM.*FAKE PERM/)
  await expect(headOf('pane-a').getByTestId('pane-status')).toContainText('Claude · 허락 기다림')
  await win.reload()
  await waitLoaded(win)
  await expect(headOf('pane-a').getByTestId('pane-status')).toContainText('Claude · 허락 기다림', { timeout: 15_000 })

  // 세션 끝 → 에이전트 상태가 사라지고 명령 끝(exit 0)
  await term('pane-a').click()
  await type('quit')
  await waitText('pane-a', /FAKE BYE/)
  await expect(headOf('pane-a').getByTestId('pane-status')).toContainText('exit 0')
  await expect(headOf('pane-a').getByTestId('pane-status')).not.toContainText('Claude')
  // 셸이 끝나면(pane 닫힘) 기록 파일을 지운다
  expect(existsSync(join(userData, 'agent-events', 'pane-a.log'))).toBe(true)
  await type('exit')
  await expect.poll(() => existsSync(join(userData, 'agent-events', 'pane-a.log')), { timeout: 10_000 }).toBe(false)
})

test('다른 일감을 보는 동안 턴 실패(StopFailure) → 실패 알림 본문은 Claude · 실패(종료 코드 없음)', async () => {
  await launch()
  // 페이지의 Notification 을 가짜로 — 보낸 것을 모은다
  await win.evaluate(`(() => {
    const sent = []
    window.__sent = sent
    window.Notification = class { constructor(title, opts = {}) { this.onclick = null; sent.push({ title, body: opts.body ?? '' }) } }
  })()`)
  const sent = () => win.evaluate<Array<{ title: string; body: string }>>('window.__sent')
  await term('pane-a').click()
  await waitText('pane-a', /%/)
  await type(`export PATH="${FAKE_BIN}:$PATH"; claude`)
  await waitText('pane-a', /FAKE READY/)
  await type('faillater')
  await waitText('pane-a', /FAKE FAILLATER/)
  await row('B 일감').click()
  await expect.poll(sent, { timeout: 10_000 }).toEqual([expect.objectContaining({ title: '명령이 실패했습니다', body: expect.stringContaining('Claude · 실패') })])
  expect((await sent())[0]!.body).not.toContain('exit')
})

// 63단계부터 같은 zsh 함수가 안내(agentGuide, 기본 켬)도 붙인다 — 두 설정을 모두 꺼야 감싸지 않는다.
test('상태 훅 · 안내 설정을 모두 끄면 새 셸의 claude 를 감싸지 않고 기록 파일 변수도 없다', async () => {
  await launch({ agentHooks: false, agentGuide: false })
  await term('pane-a').click()
  await waitText('pane-a', /%/)
  await type(`export PATH="${FAKE_BIN}:$PATH"; claude -r abc`)
  await waitText('pane-a', /FAKE ARGS: -r abc/)
  await type('quit')
  await waitText('pane-a', /FAKE BYE/)
  expect(existsSync(join(userData, 'agent-events', 'pane-a.log'))).toBe(false)
  await type('echo "EV=${TASKMINAL_AGENT_EVENTS-none}"')
  await waitText('pane-a', /EV=none/)
})

// 63단계: 두 변수는 따로 온다 — 상태 훅만 끄면 안내만 붙고 --settings · 기록 파일 · 변수는 없다.
test('상태 훅만 끄면 claude 에 안내만 붙고 --settings · 기록 파일 · 변수는 없다', async () => {
  await launch({ agentHooks: false })
  await term('pane-a').click()
  await waitText('pane-a', /%/)
  await type(`export PATH="${FAKE_BIN}:$PATH"; claude -r abc`)
  // FAKE ARGS 뒤 첫 인자부터 사용자 인자까지 전체 — --settings 가 붙는다면 --append-system-prompt 앞에 온다
  const [args] = await waitText('pane-a', /FAKE ARGS: [\s\S]*?-r abc/)
  expect(args).toMatch(/^FAKE ARGS: --append-system-prompt /)
  expect(args).not.toContain('--settings')
  await type('quit')
  await waitText('pane-a', /FAKE BYE/)
  expect(existsSync(join(userData, 'agent-events', 'pane-a.log'))).toBe(false)
  await type('echo "EV=${TASKMINAL_AGENT_EVENTS-none}"')
  await waitText('pane-a', /EV=none/)
})
