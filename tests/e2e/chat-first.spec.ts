import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { firstWindow, seedState, waitLoaded } from './helpers'

// 26단계 C: 대화 중심 — 새 일감은 대화 칸으로 시작하고, 셸은 ⌘J(또는 머리의 '셸' 단추)로 꺼낸다
const FAKE_CLAUDE = resolve(__dirname, '../fixtures/fake-claude.mjs')
const FAKE_CODEX = resolve(__dirname, '../fixtures/fake-codex.mjs')
let userData: string
let app: ElectronApplication | undefined
let win: Page

const view = () => win.locator('[data-testid="task-view"][aria-hidden="false"]')
const chats = () => view().getByTestId('chat-pane')
const terms = () => view().locator('.xterm')

async function launch(opts: { seed?: boolean; settings?: Record<string, unknown>; claudeBin?: string } = {}) {
  // seed 없이 띄우면 처음 설치와 같다(설정 기본값) — 첫 실행 안내는 빈 상태 파일로 건너뛴다
  seedState(userData, [], [], { newTaskStart: 'chat-claude', ...(opts.settings ?? {}) })
  app = await electron.launch({
    args: ['.'],
    env: { ...process.env, TASKMINAL_USER_DATA: userData, TASKMINAL_CLAUDE_BIN: opts.claudeBin ?? FAKE_CLAUDE, TASKMINAL_CODEX_BIN: FAKE_CODEX },
  })
  win = await firstWindow(app)
  await waitLoaded(win)
}
async function command(c: string) {
  await app!.evaluate(({ BrowserWindow }, cmd) => BrowserWindow.getAllWindows()[0]!.webContents.send('app:command', cmd), c)
}
async function newTask(name: string, pick?: 'chat-claude' | 'chat-codex' | 'terminal') {
  await command('new-task')
  const dialog = win.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('textbox').first().fill(name)
  if (pick) await dialog.getByTestId(`start-${pick}`).click()
  await dialog.getByRole('button', { name: /만들기/ }).click()
  await expect(dialog).toHaveCount(0)
}
const savedTasks = () => JSON.parse(readFileSync(join(userData, 'state.json'), 'utf8')).tasks as Array<{ name: string; panes: Record<string, { kind?: string }> }>

test.beforeEach(() => {
  userData = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-e2e-')))
})
test.afterEach(async () => {
  await app?.close()
  app = undefined
  rmSync(userData, { recursive: true, force: true })
})

test('새 일감 기본 = Claude 대화 칸(셸 없음) · 터미널을 고르면 셸 · 만들기 두 번에 하나', async () => {
  await launch()
  await command('new-task')
  const dialog = win.getByRole('dialog')
  await expect(dialog.getByTestId('start-chat-claude')).toHaveAttribute('aria-pressed', 'true')
  await dialog.getByRole('textbox').first().fill('대화 일감')
  // 만들기를 빠르게 두 번 — 일감은 하나
  await dialog.getByRole('button', { name: /만들기/ }).evaluate((b: HTMLButtonElement) => (b.click(), b.click()))
  await expect(dialog).toHaveCount(0)
  await expect(chats()).toHaveCount(1)
  await expect(chats().first()).toHaveAttribute('data-agent', 'claude')
  await expect(terms()).toHaveCount(0)
  await expect(win.getByTestId('task-row')).toHaveCount(1)

  await newTask('셸 일감', 'terminal')
  await expect(terms()).toHaveCount(1)
  await expect(chats()).toHaveCount(0)
  await expect(win.getByTestId('task-row')).toHaveCount(2)
})

test('⌘J: 대화 아래에 셸을 꺼내고 · 다시 누르면 대화로 · 세 번 눌러도 셸은 하나 · 머리의 셸 단추도 같다', async () => {
  await launch()
  await newTask('셸 꺼내기')
  await expect(chats()).toHaveCount(1)
  await win.keyboard.press('Meta+j')
  await expect(terms()).toHaveCount(1)
  // 꺼낸 셸에 포커스 — 바로 쳐진다
  await win.keyboard.type('pwd\n')
  await expect(view().locator('.xterm-rows')).toContainText(userData.split('/').pop()!, { timeout: 15_000 }).catch(async () => {
    // 기본 폴더가 홈이면 홈 이름이 나온다 — 무엇이든 셸이 응답했는지만 본다
    await expect(view().locator('.xterm-rows')).toContainText('/', { timeout: 15_000 })
  })
  await win.keyboard.press('Meta+j')
  await expect(chats().getByTestId('chat-input')).toBeFocused()
  await win.keyboard.press('Meta+j')
  await win.keyboard.press('Meta+j')
  await win.keyboard.press('Meta+j')
  await expect(terms()).toHaveCount(1)
  // 머리의 '셸' 단추: 대화에서 누르면 셸로 포커스
  await win.keyboard.press('Meta+j') // 지금 셸이면 대화로
  await chats().getByTestId('chat-shell').click()
  await expect(terms()).toHaveCount(1)
  await expect(chats().getByTestId('chat-input')).not.toBeFocused()
  await win.screenshot({ path: 'test-results/chat-first/shell-toggle.png' })
})

test('터미널만 있는 탭의 ⌘J 는 안내만 — 셸을 더 만들지 않는다', async () => {
  await launch()
  await newTask('셸만', 'terminal')
  await win.keyboard.press('Meta+j')
  await expect(win.getByTestId('toast')).toContainText('대화 칸이 있는 탭에서')
  await expect(terms()).toHaveCount(1)
})

test('설정 › 일반 › 새 일감 시작 = Codex → 새 일감이 Codex 대화 · 저장도 됨', async () => {
  await launch()
  await command('settings')
  const settings = win.getByRole('dialog').first()
  await settings.getByRole('radio', { name: /Codex 대화/ }).click()
  await win.keyboard.press('Escape')
  await newTask('코덱스 일감')
  await expect(chats().first()).toHaveAttribute('data-agent', 'codex')
  await expect.poll(() => savedTasks().find((t) => t.name === '코덱스 일감')?.panes && Object.values(savedTasks().find((t) => t.name === '코덱스 일감')!.panes)[0]?.kind).toBe('chat')
})

test('일감이 없는 빈 화면: 대화로 시작 단추가 첫째 · 터미널로 시작도 있다', async () => {
  await launch()
  const empty = win.getByTestId('empty-view')
  await expect(empty.getByTestId('empty-new-chat')).toContainText('Claude 대화로 시작')
  await empty.getByTestId('empty-new-terminal').click()
  const dialog = win.getByRole('dialog')
  await expect(dialog.getByTestId('start-terminal')).toHaveAttribute('aria-pressed', 'true')
  await win.keyboard.press('Escape')
  await empty.getByTestId('empty-new-chat').click()
  await expect(dialog.getByTestId('start-chat-claude')).toHaveAttribute('aria-pressed', 'true')
  await win.screenshot({ path: 'test-results/chat-first/new-task-dialog.png' })
})

test('에이전트 명령이 없으면 띠로 알리고 · ⌘J 로 셸은 그대로 꺼낸다', async () => {
  await launch({ claudeBin: join(userData, '없는-claude') })
  await newTask('명령 없음')
  await chats().getByTestId('chat-input').fill('안녕')
  await chats().getByTestId('chat-input').press('Enter')
  // 명령 경로를 직접 준 경우는 '못 찾음' 대신 '끝남(crash)' 으로 온다 — 어느 쪽이든 띠가 뜨고 대화는 막히지 않는다
  await expect(chats().getByTestId('chat-band')).toHaveAttribute('data-error', /missing|crash/)
  await win.keyboard.press('Meta+j')
  await expect(terms()).toHaveCount(1)
})
