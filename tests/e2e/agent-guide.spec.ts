import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { agentGuide, codexGuideArg } from '../../src/shared/agent-guide'
import { firstWindow, seedState, waitLoaded } from './helpers'

// 58b · 63: 에이전트에게 Taskminal 명령 안내 — 대화 pane 의 claude(--append-system-prompt) · Codex(developerInstructions),
// 터미널에서 띄운 claude(--append-system-prompt) · codex(-c developer_instructions=…). 설정 '에이전트에게 Taskminal 명령 알려 주기'(기본 켬)로 끈다.
// 실제 claude · codex 는 부르지 않는다: 대화는 tests/fixtures 의 가짜, 터미널은 이 시험이 만든 가짜(받은 인자를 JSON 으로 남김)를 PATH 앞에 둔다.
// CODEX_HOME 은 빈 임시 폴더 — 사용자 ~/.codex/config.toml 의 developer_instructions 가 결과를 흔들지 않게.
const FAKE_CLAUDE = resolve(__dirname, '../fixtures/fake-claude.mjs')
const FAKE_CODEX = resolve(__dirname, '../fixtures/fake-codex.mjs')
let userData: string
let claudeLog: string
let codexLog: string
let bin: string
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
  const codexHome = join(userData, 'codex-home')
  mkdirSync(zdot, { recursive: true })
  mkdirSync(codexHome, { recursive: true })
  app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      TASKMINAL_USER_DATA: userData,
      ZDOTDIR: zdot,
      CODEX_HOME: codexHome,
      TASKMINAL_CLAUDE_BIN: FAKE_CLAUDE,
      FAKE_CLAUDE_LOG: claudeLog,
      TASKMINAL_CODEX_BIN: FAKE_CODEX,
      FAKE_CODEX_LOG: codexLog,
    },
  })
  win = await firstWindow(app)
  await waitLoaded(win)
}

test.describe.configure({ timeout: 90_000 })
test.beforeEach(() => {
  userData = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-e2e-')))
  claudeLog = join(userData, 'fake-claude.log')
  codexLog = join(userData, 'fake-codex.log')
  bin = join(userData, 'fakebin')
  mkdirSync(bin)
  // 터미널용 가짜 claude · codex — 받은 인자를 그대로 JSON 한 줄로 남긴다(여러 줄 안내도 깨지지 않게)
  for (const name of ['claude', 'codex']) {
    const f = join(bin, name)
    writeFileSync(
      f,
      `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(join(userData, `term-${name}.log`))}, JSON.stringify(process.argv.slice(2)) + '\\n')\nconsole.log('TERM FAKE ${name.toUpperCase()} OK')\n`,
    )
    chmodSync(f, 0o755)
  }
})
test.afterEach(async () => {
  await app?.close()
  app = undefined
  rmSync(userData, { recursive: true, force: true, maxRetries: 5 })
})

const chat = () => win.locator('[data-testid="task-view"][aria-hidden="false"] [data-testid="chat-pane"]')
const input = () => chat().getByTestId('chat-input')
async function say(text: string) {
  await input().fill(text)
  await input().press('Enter')
}
function jsonLines<T>(file: string): T[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as T)
}
const claudeArgv = () => jsonLines<{ argv?: string[] }>(claudeLog).filter((l) => l.argv).map((l) => l.argv!)
const codexCalls = (m: string) =>
  jsonLines<{ stdin?: { method?: string; params?: Record<string, unknown> } }>(codexLog)
    .filter((l) => l.stdin?.method === m)
    .map((l) => l.stdin!.params!)
const termArgv = (name: 'claude' | 'codex') => jsonLines<string[]>(join(userData, `term-${name}.log`))
/** --append-system-prompt 바로 뒤의 값(없으면 undefined) */
const appended = (argv: string[]) => {
  const at = argv.indexOf('--append-system-prompt')
  return at < 0 ? undefined : argv[at + 1]
}
/** -c 값들 중 developer_instructions 로 시작하는 것 */
const developerArgs = (argv: string[]) => argv.filter((a, i) => argv[i - 1] === '-c' && a.startsWith('developer_instructions='))

async function newClaudeChat() {
  await win.keyboard.press('Meta+p')
  await win.keyboard.type('새 대화 (Claude)')
  await win.keyboard.press('Enter')
  await expect(chat()).toHaveAttribute('data-agent', 'claude')
}
async function newCodexChat() {
  await win.keyboard.press('Meta+p')
  await win.keyboard.type('새 대화 (Codex)')
  await win.keyboard.press('Enter')
  await expect(chat()).toHaveAttribute('data-agent', 'codex')
}
const row = (name: string) => win.locator(`[data-testid="task-row"][data-task-name="${name}"]`)

test('58b · 63 대화 pane: 기본(켬)이면 claude 는 --append-system-prompt <안내>, Codex 는 thread/start 의 developerInstructions', async () => {
  await launch()
  await newClaudeChat()
  await say('안녕')
  await expect(chat().locator('[data-kind="text"]')).toHaveText('echo: 안녕')
  const argv = claudeArgv()[0]!
  expect(appended(argv)).toBe(agentGuide())

  await row('B 일감').click()
  await newCodexChat()
  await say('안녕')
  await expect(chat().locator('[data-kind="text"]')).toHaveText('echo: 안녕')
  expect(codexCalls('thread/start')[0]).toMatchObject({ developerInstructions: agentGuide() })
})

test('58b · 63 대화 pane: 설정에서 끄면 다음에 띄우는 claude · Codex 에 안내가 없다', async () => {
  await launch()
  // 설정 › 일반 › 대화 — 스위치를 끈다(다음에 띄우는 대화부터)
  await win.keyboard.press('Meta+Comma')
  const settings = win.getByTestId('settings')
  await expect(settings).toBeVisible()
  const sw = settings.getByRole('switch', { name: '에이전트에게 Taskminal 명령 알려 주기' })
  await expect(sw).toHaveAttribute('aria-checked', 'true') // 기본 켬
  await sw.click()
  await expect(sw).toHaveAttribute('aria-checked', 'false')
  // main 이 바뀐 설정을 받은 뒤(state.json 에 쓰였으면 main 의 지금 값도 바뀌었다)
  await expect
    .poll(() => {
      try {
        return (JSON.parse(readFileSync(join(userData, 'state.json'), 'utf8')) as { settings?: { agentGuide?: boolean } }).settings?.agentGuide
      } catch {
        return undefined
      }
    })
    .toBe(false)
  await settings.getByRole('button', { name: /일감으로 돌아가기/ }).click()
  await expect(settings).toHaveCount(0)

  await newClaudeChat()
  await say('안녕')
  await expect(chat().locator('[data-kind="text"]')).toHaveText('echo: 안녕')
  expect(claudeArgv()[0]).not.toContain('--append-system-prompt')

  await row('B 일감').click()
  await newCodexChat()
  await say('안녕')
  await expect(chat().locator('[data-kind="text"]')).toHaveText('echo: 안녕')
  const start = codexCalls('thread/start')[0]!
  expect(start).toBeDefined()
  expect(start).not.toHaveProperty('developerInstructions')
})

const term = (id: string) => win.getByTestId(`pane-${id}`)
const screenOf = (id: string) => term(id).locator('.xterm-rows').innerText()
async function waitText(id: string, re: RegExp) {
  await expect.poll(async () => re.test((await screenOf(id)).replace(/\n/g, '')), { timeout: 20_000 }).toBe(true)
}
async function runAgents() {
  await term('pane-a').click()
  await waitText('pane-a', /%/)
  await win.keyboard.type(`export PATH="${bin}:$PATH"; codex 첫말; claude 첫말; echo AGENTS_DONE_$((3+4))`)
  await win.keyboard.press('Enter')
  await waitText('pane-a', /AGENTS_DONE_7/)
}

test('63 터미널: 기본(켬)이면 codex 는 -c developer_instructions=<안내>, claude 는 --append-system-prompt <안내>', async () => {
  await launch()
  await runAgents()
  const codex = termArgv('codex')[0]!
  expect(developerArgs(codex)).toEqual([codexGuideArg()])
  expect(codex[codex.length - 1]).toBe('첫말') // 사용자가 친 인자는 그대로 뒤에
  const claude = termArgv('claude')[0]!
  expect(appended(claude)).toBe(agentGuide())
  expect(claude[claude.length - 1]).toBe('첫말')
})

test('63 터미널: 설정을 끄면 새 셸의 codex · claude 에 안내가 없다', async () => {
  await launch({ agentGuide: false })
  await runAgents()
  const codex = termArgv('codex')[0]!
  expect(developerArgs(codex)).toEqual([])
  expect(codex.join(' ')).not.toContain('developer_instructions')
  expect(codex[codex.length - 1]).toBe('첫말')
  const claude = termArgv('claude')[0]!
  expect(claude).not.toContain('--append-system-prompt')
  expect(claude[claude.length - 1]).toBe('첫말')
})
