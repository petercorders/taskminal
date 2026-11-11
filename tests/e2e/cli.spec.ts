import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { firstWindow, runCli, seedState, waitLoaded } from './helpers'

// 24단계: `taskminal` 명령 — 저장소 안의 resources/bin/taskminal 을 그대로 부른다(PATH 에 넣지 않는다). 앱은 임시 userData 로만
const FAKE = resolve(__dirname, '../fixtures/fake-claude.mjs')
let userData: string
let app: ElectronApplication | undefined
let win: Page

async function launch() {
  app = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: userData, TASKMINAL_CLAUDE_BIN: FAKE, FAKE_CLAUDE_LOG: join(userData, 'fake.log') } })
  win = await firstWindow(app)
  await waitLoaded(win)
}

const cli = (...args: string[]) => runCli(userData, ...args)
const term = (id: string) => win.getByTestId(`pane-${id}`)
const screenOf = (id: string) => term(id).locator('.xterm-rows').innerText()
async function waitText(id: string, re: RegExp) {
  await expect.poll(async () => re.test((await screenOf(id)).replace(/\n/g, '')), { timeout: 20_000 }).toBe(true)
}
const savedState = () => JSON.parse(readFileSync(join(userData, 'state.json'), 'utf8')) as { tasks: Array<{ id: string; name: string; statusId: string; panes: Record<string, unknown> }> }

test.describe.configure({ timeout: 120_000 })
test.beforeEach(() => {
  userData = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-e2e-')))
  seedState(userData, [
    { id: 'task-a', name: 'A 일감', paneId: 'pane-a', cwd: userData },
    { id: 'task-b', name: 'B 일감', paneId: 'pane-b', cwd: userData },
    { id: 'task-c', name: 'api', paneId: 'pane-c', cwd: userData },
    { id: 'task-d', name: 'API', paneId: 'pane-d', cwd: userData },
  ])
})
test.afterEach(async () => {
  await app?.close()
  app = undefined
  rmSync(userData, { recursive: true, force: true })
})

test('터미널 안에서 taskminal list → 이 pane 표시 · 소켓 0600 · 앱을 끄면 종료 코드 3 · 소켓 지움', async () => {
  await launch()
  const sock = join(userData, 'cli.sock')
  await expect.poll(() => existsSync(sock)).toBe(true)
  expect(lstatSync(sock).isSocket()).toBe(true)
  expect(statSync(sock).mode & 0o777).toBe(0o600)
  // 터미널 안: PATH 의 taskminal · TASKMINAL_PANE_ID 로 '← 여기'
  await term('pane-a').click()
  await win.keyboard.type('taskminal list; echo "PANE=$TASKMINAL_PANE_ID"')
  await win.keyboard.press('Enter')
  await waitText('pane-a', /A 일감.*← 여기/)
  await waitText('pane-a', /PANE=pane-a/)
  await win.screenshot({ path: 'test-results/cli-list.png' })
  // 바깥에서는 '여기' 가 없다 · --json
  const out = await cli('list', '--json')
  expect(out.code).toBe(0)
  const rows = JSON.parse(out.out) as Array<{ task: string; here?: boolean }>
  expect(rows.map((r) => r.task).sort()).toEqual(['A 일감', 'API', 'B 일감', 'api'])
  expect(rows.some((r) => r.here)).toBe(false)

  await app!.close()
  app = undefined
  expect(existsSync(sock)).toBe(false)
  const down = await cli('list')
  expect(down.code).toBe(3)
  expect(down.err).toContain('Taskminal 이 실행 중이 아니에요')
})

test('verify: CLI 로 대화 2개 띄우고 chat wait --all → 둘 다 끝남 · chat read · 대화에도 환경 변수', async () => {
  await launch()
  const one = await cli('chat', 'new', '--task', 'B 일감', 'later 하나')
  expect(one.code, one.err).toBe(0)
  const two = await cli('chat', 'new', '--task', 'B 일감', '--down', 'later 둘')
  expect(two.code, two.err).toBe(0)
  const paneOne = /대화 pane (\S+) 를/.exec(one.out)![1]!
  const paneTwo = /대화 pane (\S+) 를/.exec(two.out)![1]!
  expect(paneOne).not.toBe(paneTwo)
  // 아직 도는 중 — 짧게 기다리면 124
  const early = await cli('chat', 'wait', '--all', '--task', 'B 일감', '--timeout', '200ms')
  expect(early.code).toBe(124)
  expect(early.out).toContain('실행 중')
  const waited = await cli('chat', 'wait', '--all', '--task', 'B 일감', '--timeout', '30s')
  expect(waited.code, waited.err).toBe(0)
  expect(waited.out.match(/^끝남/gm)).toHaveLength(2)
  const read = await cli('chat', 'read', paneTwo)
  expect(read.out.trim()).toBe('늦게 끝남: later 둘')
  // 사람이 보는 화면에도 두 대화가 있다
  await win.locator('li[data-task-name="B 일감"]').click()
  await expect(win.locator('[data-testid="task-view"][aria-hidden="false"] [data-testid="chat-pane"]')).toHaveCount(2)
  // 대화 에이전트도 TASKMINAL_PANE_ID · 소켓 · PATH 를 받는다
  await cli('chat', 'send', paneOne, 'whoami')
  await cli('chat', 'wait', paneOne, '--timeout', '20s')
  expect((await cli('chat', 'read', paneOne)).out.trim()).toBe(`pane=${paneOne} socket=yes path=yes`)
  // 터미널 pane 에 chat 명령 · 대화 pane 에 pane 명령은 종료 코드 2
  expect((await cli('chat', 'read', 'A 일감')).code).toBe(2)
  expect((await cli('pane', 'read', paneOne)).code).toBe(2)
  await win.screenshot({ path: 'test-results/cli-chat-wait.png' })
})

test('pane split --cmd → wait exit → read · send --enter + wait text · 가림 · task move · 겹친 이름은 후보와 2', async () => {
  await launch()
  const split = await cli('pane', 'split', 'A 일감', '--down', '--cmd', 'sleep 1; echo DONE-$((40+2))')
  expect(split.code, split.err).toBe(0)
  const paneId = /pane (\S+) 를/.exec(split.out)![1]!
  const exit = await cli('pane', 'wait', paneId, '--for', 'exit', '--timeout', '30s')
  expect(exit.code, exit.err + exit.out).toBe(0)
  expect(exit.out).toMatch(/exit 0/)
  expect((await cli('pane', 'read', paneId, '--lines', '20')).out).toContain('DONE-42')

  // 보내고 그 글이 나올 때까지 · 비밀값은 읽을 때 가린다
  expect((await cli('pane', 'send', paneId, 'echo "token=ghp_abcdefghijklmnopqrstuvwxyz0123456789 MARK-$((6*7))"', '--enter')).code).toBe(0)
  const found = await cli('pane', 'wait', paneId, '--for', 'text:MARK-42', '--timeout', '20s')
  expect(found.code, found.err).toBe(0)
  const read = await cli('pane', 'read', paneId, '--lines', '20')
  expect(read.out).toContain('MARK-42')
  expect(read.out).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789')

  // 일감 상태 옮기기 → 저장 파일에
  expect((await cli('task', 'move', 'B 일감', '--status', '대기')).code).toBe(0)
  await expect.poll(() => savedState().tasks.find((t) => t.id === 'task-b')?.statusId).toBe('wait')
  // 'api' 는 정확히 같은 이름이 하나라 그것 · 'Api' 는 대소문자 무시로 둘 → 후보(id)와 종료 코드 2 · id 로는 된다
  expect((await cli('task', 'open', 'api')).code).toBe(0)
  await expect(win.locator('[data-testid="task-view"][aria-hidden="false"]')).toHaveAttribute('data-task-name', 'api')
  const two = await cli('task', 'open', 'Api')
  expect(two.code).toBe(2)
  expect(two.err).toContain('task-c')
  expect(two.err).toContain('task-d')
  expect((await cli('task', 'open', 'task-d')).code).toBe(0)
  await expect(win.locator('[data-testid="task-view"][aria-hidden="false"]')).toHaveAttribute('data-task-name', 'API')
  expect((await cli('task', 'open', '없는 일감')).code).toBe(2)
})

test('notify --task → 사이드바 확인 필요 · task note → 메모 칸 에이전트 줄', async () => {
  await launch()
  expect((await cli('notify', '--task', 'B 일감', '배포 확인 부탁해요')).code).toBe(0)
  // 확인 필요인 일감은 사이드바 위 '확인 필요' 칸(attention-row)으로 옮겨 간다 — 어느 칸이든 그 일감 줄
  const row = win.locator('li[data-task-name="B 일감"]')
  await expect(row).toHaveClass(/\battention\b/)
  expect((await cli('task', 'note', 'B 일감', '다음: 스테이징 확인')).code).toBe(0)
  await row.click()
  await expect(row).not.toHaveClass(/\battention\b/)
  const notesButton = win.locator('[data-testid="task-view"][aria-hidden="false"] [data-testid="notes-button"]')
  await expect(notesButton).toContainText('할 일 1')
  await notesButton.click()
  const note = win.getByTestId('notes-panel').getByTestId('note')
  await expect(note).toContainText('다음: 스테이징 확인')
  await expect(note).toContainText('에이전트가 남김')
})

test('앱 메뉴 명령줄 도구 설치… → 고른 폴더에 링크 (시험 폴더로만)', async () => {
  const dir = join(userData, 'bin')
  mkdirSync(dir)
  app = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: userData, TASKMINAL_CLI_INSTALL_DIR: dir } })
  win = await firstWindow(app)
  await waitLoaded(win)
  // 확인 · 결과 대화상자는 첫 단추를 누른 것으로
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox
  })
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('cli-install')!.click())
  const link = join(dir, 'taskminal')
  await expect.poll(() => existsSync(link)).toBe(true)
  expect(lstatSync(link).isSymbolicLink()).toBe(true)
  expect(readlinkSync(link)).toMatch(/resources\/bin\/taskminal$/)
})
