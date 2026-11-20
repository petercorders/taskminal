import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { firstWindow, seedState, taskJson, waitLoaded } from './helpers'

// 69단계: 에이전트가 일을 맡기기 — `taskminal task new … --worktree` · 보낸 이 머리 · 맡긴 일감의 턴 멈춤 → 부모 알림.
// CLI 는 pane 안에서 부른 것처럼 TASKMINAL_PANE_ID(+ 친 폴더 = cwd)를 준다. 가짜 claude · 임시 git · 임시 userData 로만.
// docs/stages/69-agent-delegation.md '돌려야 할 e2e' 1~5 (6 · 7 은 기존 worktrees · cli e2e).
const FAKE = resolve(__dirname, '../fixtures/fake-claude.mjs')
let base: string, data: string, repo: string, repo2: string, plain: string, log: string
let app: ElectronApplication | undefined, win: Page
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** 앱 안 pane 에서 친 것처럼 — 시험 환경의 TASKMINAL_* 는 빼고 userData · pane id 만, 친 폴더는 cwd */
function cliAs(pane: string | null, cwd: string, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('TASKMINAL_') && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v
  env['TASKMINAL_USER_DATA'] = data
  if (pane) env['TASKMINAL_PANE_ID'] = pane
  return new Promise((done) => {
    execFile(resolve(__dirname, '../../resources/bin/taskminal'), args, { env, cwd, timeout: 60_000 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : -1) : 0
      done({ code, out: String(stdout), err: String(stderr) })
    })
  })
}
function makeRepo(path: string) {
  mkdirSync(path)
  git(path, 'init', '-q', '-b', 'main')
  git(path, 'config', 'user.name', 'Test'); git(path, 'config', 'user.email', 'test@example.invalid'); git(path, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(path, 'a.ts'), 'export const a = 1\n'); git(path, 'add', '.'); git(path, 'commit', '-qm', 'initial')
}
async function launch() {
  app = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: data, TASKMINAL_CLAUDE_BIN: FAKE, FAKE_CLAUDE_LOG: log } })
  win = await firstWindow(app)
  await waitLoaded(win)
}
type Saved = { id: string; name: string; cwd: string; parent?: { taskId: string; paneId?: string }; archivedAt?: number; panes: Record<string, { id: string; kind?: string }> }
const saved = () => JSON.parse(readFileSync(join(data, 'state.json'), 'utf8')).tasks as Saved[]
// 흐름 보기에서 확인 필요인 일감은 위 '확인 필요' 칸(attention-row)에도 나온다 — 누르기는 첫 줄, 확인 필요는 class 로
const row = (name: string) => win.locator(`li[data-task-name="${name}"]`).first()
const attention = (name: string) => win.locator(`li.attention[data-task-name="${name}"]`)
const view = () => win.locator('[data-testid="task-view"][aria-hidden="false"]')
const inbox = (): Array<{ body: string; paneId: string }> => (existsSync(join(data, 'inbox.json')) ? JSON.parse(readFileSync(join(data, 'inbox.json'), 'utf8')) : [])
const delegated = (text: string) => inbox().filter((e) => e.body.includes(text)).length
const journal = () => (existsSync(join(data, 'worktrees', 'journal.json')) ? JSON.parse(readFileSync(join(data, 'worktrees', 'journal.json'), 'utf8')) : { creates: [] }) as { creates: Array<{ requestId: string; branch: string }> }
const fakeUserTexts = () =>
  existsSync(log)
    ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { stdin?: { type: string; message?: { content?: Array<{ text?: string }> } } })
        .filter((l) => l.stdin?.type === 'user').map((l) => (l.stdin!.message?.content ?? []).map((c) => c.text ?? '').join(''))
    : []
const worktreesOf = (path: string, branch: string) => (git(path, 'worktree', 'list', '--porcelain').match(new RegExp(`^branch refs/heads/${branch}$`, 'gm')) ?? []).length

test.describe.configure({ timeout: 120_000 })
test.beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'tm-e2e-69-')))
  data = join(base, 'app'); repo = join(base, 'repo'); repo2 = join(base, 'other'); plain = join(base, 'plain')
  log = join(data, 'fake-claude.log')
  mkdirSync(data); mkdirSync(plain); makeRepo(repo); makeRepo(repo2)
  // 'C 보기' 를 보는 채로(부모 P 는 보지 않음 — 알림이 받은편지함에 남는다)
  seedState(data, [
    { id: 'viewer', name: 'C 보기', paneId: 'c-pane', cwd: base },
    { id: 'parent', name: 'P 부모', paneId: 'p-pane', cwd: repo },
    { id: 'nogit', name: 'N 저장소 아님', paneId: 'n-pane', cwd: plain },
  ])
  // 원격 일감(ssh 호스트) — 보지 않으므로 셸은 뜨지 않는다
  const state = JSON.parse(readFileSync(join(data, 'state.json'), 'utf8'))
  state.tasks.push({ ...taskJson({ id: 'remote', name: 'R 원격', paneId: 'r-pane', cwd: '/srv/app' }), host: 'tm-e2e-host.invalid' })
  writeFileSync(join(data, 'state.json'), JSON.stringify(state))
})
test.afterEach(async () => {
  await app?.close(); app = undefined
  rmSync(base, { recursive: true, force: true, maxRetries: 5 })
})

/** 부모 P 의 터미널 pane 에서 맡기기 → 새 일감 id · 폴더 */
async function delegate(name: string, branch: string, ...extra: string[]) {
  const r = await cliAs('p-pane', repo, 'task', 'new', name, '--worktree', branch, '--json', ...extra)
  expect(r.code, r.err + r.out).toBe(0)
  return JSON.parse(r.out) as { task: string; path: string; branch: string; request: string; existing: boolean }
}

test('1: task new X --worktree b --json → 새 일감 · <저장소>-worktrees/b · 상태에 parent · 보던 일감 · 탭 그대로', async () => {
  await launch()
  const tabsBefore = await view().locator('[role=tablist] [role=tab]').count()
  const made = await delegate('X 맡김', 'b')
  expect(made).toMatchObject({ path: join(base, 'repo-worktrees', 'b'), branch: 'b', existing: false })
  expect(made.task).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  expect(existsSync(join(made.path, 'a.ts'))).toBe(true)
  expect(worktreesOf(repo, 'b')).toBe(1)
  await expect(row('X 맡김')).toBeVisible()
  await expect.poll(() => saved().find((t) => t.id === made.task)?.parent).toEqual({ taskId: 'parent', paneId: 'p-pane' })
  expect(saved().find((t) => t.id === made.task)?.cwd).toBe(made.path)
  await expect(view()).toHaveAttribute('data-task-name', 'C 보기')
  await expect(view().locator('[role=tablist] [role=tab]')).toHaveCount(tabsBefore)
  await win.screenshot({ path: 'test-results/stacked-e2e/69-1-delegated.png' })
})

test('2a: 같은 --request 로 다시 → 일감 · worktree 하나, 답 existing: true', async () => {
  await launch()
  const first = await delegate('X 맡김', 'b', '--request', 'req-69-same')
  // 그 사이 worktree 에 커밋해도 같은 번호는 git 없이 그 일감을 알린다(69 리뷰 2)
  git(first.path, 'commit', '-q', '--allow-empty', '-m', 'work in child')
  const again = await delegate('X 맡김', 'b', '--request', 'req-69-same')
  expect(again).toMatchObject({ task: first.task, path: first.path, existing: true })
  expect(worktreesOf(repo, 'b')).toBe(1)
  await expect.poll(() => saved().filter((t) => t.id === first.task).length).toBe(1)
  expect(journal().creates.filter((c) => c.requestId === 'req-69-same')).toHaveLength(1)
})

test('2b: 창이 delegate.prepare 에 답하지 않으면 종료 1 · worktree 는 만듦 → 같은 번호로 다시 하면 worktree add 없이 일감이 생김', async () => {
  await launch()
  // main → 창의 delegate.prepare 요청만 버린다(창이 없거나 답하지 않음 — askUi 5초 시간 넘김)
  await app!.evaluate(({ BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows()[0]!.webContents
    const original = wc.send.bind(wc)
    const g = globalThis as unknown as { restoreSend: () => void }
    g.restoreSend = () => { wc.send = original }
    wc.send = ((channel: string, ...args: unknown[]) => {
      if (channel === 'cli:request' && (args[1] as { op?: string } | undefined)?.op === 'delegate.prepare') return
      original(channel, ...args)
    }) as typeof wc.send
  })
  const lost = await cliAs('p-pane', repo, 'task', 'new', 'X 맡김', '--worktree', 'b', '--request', 'req-69-lost', '--json')
  expect(lost.code).toBe(1)
  expect(lost.err).toContain('worktree 는 만들었어요')
  expect(lost.err).toContain('--request req-69-lost')
  expect(existsSync(join(base, 'repo-worktrees', 'b'))).toBe(true)
  await expect(row('X 맡김')).toHaveCount(0)
  await app!.evaluate(() => (globalThis as unknown as { restoreSend: () => void }).restoreSend())
  const again = await delegate('X 맡김', 'b', '--request', 'req-69-lost')
  expect(again.existing).toBe(false)
  expect(worktreesOf(repo, 'b')).toBe(1)
  await expect(row('X 맡김')).toBeVisible()
  await expect.poll(() => saved().find((t) => t.id === again.task)?.parent?.taskId).toBe('parent')
})

test('3: 저장소 아닌 일감 · 원격 일감에서 부르면 종료 2 · 폴더 · 브랜치 · 기록 없음', async () => {
  await launch()
  const notRepo = await cliAs('n-pane', plain, 'task', 'new', 'Y', '--worktree', 'y', '--json')
  expect(notRepo.code).toBe(2)
  expect(notRepo.err).toContain('저장소가 아니에요')
  const remote = await cliAs('r-pane', plain, 'task', 'new', 'Z', '--worktree', 'z', '--json')
  expect(remote.code).toBe(2)
  expect(remote.err).toContain('원격 일감에서는 worktree 를 만들 수 없어요')
  // 앱 밖(pane 없음)에서도 2
  const outside = await cliAs(null, repo, 'task', 'new', 'W', '--worktree', 'w', '--json')
  expect(outside.code).toBe(2)
  expect(existsSync(join(base, 'plain-worktrees'))).toBe(false)
  expect(existsSync(join(base, 'repo-worktrees'))).toBe(false)
  expect(git(repo, 'branch', '--list', 'y', 'z', 'w')).toBe('')
  expect(journal().creates).toHaveLength(0)
  expect(saved().map((t) => t.name).sort()).toEqual(['C 보기', 'N 저장소 아님', 'P 부모', 'R 원격'])
})

test('4a: 다른 pane 이 chat send · chat new → 받는 대화에 보낸 이 머리(글 거품), / 명령 글 · 사람 입력 · 앱 밖 CLI 에는 없음', async () => {
  await launch()
  // 머리가 붙은 글은 가짜 claude 가 'ask'(taskminal 안의 낱말) 대본으로 받아 질문에서 멈춘다 — 머리 없는 경우를 먼저 본다
  const made = await cliAs(null, base, 'chat', 'new', '--task', 'C 보기', '밖에서 첫 말')
  expect(made.code, made.err).toBe(0)
  const chatPane = /대화 pane (\S+) 를/.exec(made.out)![1]!
  const wait = async () => expect((await cliAs(null, base, 'chat', 'wait', chatPane, '--timeout', '20s')).code).toBe(0)
  await expect.poll(() => fakeUserTexts().at(-1)).toBe('밖에서 첫 말')
  await wait()
  // `/` 로 시작하는 대화 명령엔 붙이지 않는다
  expect((await cliAs('p-pane', base, 'chat', 'send', chatPane, '/compact')).code).toBe(0)
  await expect.poll(() => fakeUserTexts().at(-1)).toBe('/compact')
  await wait()
  // 사람이 입력칸에 친 글엔 없음
  const chat = view().getByTestId('chat-pane').first()
  await chat.getByTestId('chat-input').fill('사람이 친 글')
  await chat.getByTestId('chat-input').press('Enter')
  await expect.poll(() => fakeUserTexts().at(-1)).toBe('사람이 친 글')
  await wait()
  // 다른 pane(P 부모의 터미널)이 chat send → 머리 줄 + 글
  expect((await cliAs('p-pane', base, 'chat', 'send', chatPane, '둘째 말')).code).toBe(0)
  const header = /^\[taskminal: P 부모 › [^\n]+ \(p-pane\) 에서 보냄\]\n둘째 말$/
  await expect.poll(() => fakeUserTexts().at(-1) ?? '').toMatch(header)
  const bubble = chat.getByTestId('chat-user-text').last()
  await expect(bubble).toContainText('[taskminal: P 부모 ›')
  await expect(bubble).toContainText('(p-pane) 에서 보냄]')
  await expect(bubble).toContainText('둘째 말')
  await win.screenshot({ path: 'test-results/stacked-e2e/69-4-sender.png' })
  // chat new 도 머리
  const second = await cliAs('p-pane', base, 'chat', 'new', '--task', 'C 보기', '--tab', '새 대화 첫 말')
  expect(second.code, second.err).toBe(0)
  await expect.poll(() => fakeUserTexts().at(-1) ?? '').toMatch(/^\[taskminal: P 부모 › [^\n]+ \(p-pane\) 에서 보냄\]\n새 대화 첫 말$/)
  // 같은 pane 이 자기에게 보내면 머리 없음은 단위 시험 — 여기서는 받은 글 수만 확인
  expect(fakeUserTexts().filter((t) => t.startsWith('[taskminal:'))).toHaveLength(2)
})

test('4b: 터미널 pane send 에는 머리를 붙이지 않는다 · cd 한 다른 저장소에 worktree 를 만든다', async () => {
  await launch()
  const term = win.getByTestId('pane-c-pane')
  await expect.poll(async () => /%|\$/.test(await term.locator('.xterm-rows').innerText()), { timeout: 15_000 }).toBe(true)
  expect((await cliAs('p-pane', base, 'pane', 'send', 'c-pane', 'echo PANE-SEND-$((40+2))', '--enter')).code).toBe(0)
  await expect.poll(async () => (await term.locator('.xterm-rows').innerText()).includes('PANE-SEND-42'), { timeout: 15_000 }).toBe(true)
  expect(await term.locator('.xterm-rows').innerText()).not.toContain('[taskminal:')
  // 허락 메뉴에 '3' 만 — 받은 글자 그대로(머리 없이)
  expect((await cliAs('p-pane', base, 'pane', 'send', 'c-pane', '3')).code).toBe(0)
  await expect.poll(async () => ((await term.locator('.xterm-rows').innerText()).trimEnd().split('\n').at(-1) ?? '').trimEnd().endsWith('3')).toBe(true)
  expect(await term.locator('.xterm-rows').innerText()).not.toContain('[taskminal:')
  // pane 의 저장된 폴더는 repo 지만 에이전트가 cd 한 repo2 에서 부르면 repo2 에 만든다
  const r = await cliAs('p-pane', repo2, 'task', 'new', 'Q 다른 저장소', '--worktree', 'b2', '--json')
  expect(r.code, r.err).toBe(0)
  expect(JSON.parse(r.out).path).toBe(join(base, 'other-worktrees', 'b2'))
  expect(worktreesOf(repo2, 'b2')).toBe(1)
  expect(git(repo, 'branch', '--list', 'b2')).toBe('')
})

/** 맡긴 일감에 대화를 띄우고(부모 pane 이 부른 것처럼) 그 대화 pane id */
async function childChat(task: string, text: string) {
  // 앱 밖에서 띄운다 — 부모 pane 이 부르면 붙는 보낸 이 머리의 'taskminal' 이 가짜 claude 의 'ask' 대본을 고른다(fixture 의 낱말 대본)
  const r = await cliAs(null, base, 'chat', 'new', '--task', task, text)
  expect(r.code, r.err).toBe(0)
  return /대화 pane (\S+) 를/.exec(r.out)![1]!
}
const DONE = "맡긴 일 'X 맡김': 턴이 끝났어요"
const WAIT = "맡긴 일 'X 맡김': 허락 · 답을 기다려요"
/** 부모 P 를 한 번 보고 C 로 돌아온다 — 확인 필요를 지워 같은 글의 다음 알림도 새 줄로 남게 */
async function seeParent() {
  await row('P 부모').click()
  await expect(view()).toHaveAttribute('data-task-name', 'P 부모')
  await expect(attention('P 부모')).toHaveCount(0)
  await row('C 보기').click()
  await expect(view()).toHaveAttribute('data-task-name', 'C 보기')
}

test('5a: 맡긴 일감의 턴 끝 → 부모 확인 필요 · 받은편지함 한 줄, 하위 에이전트 턴도 한 번, 재시작 뒤 쏟아짐 없음', async () => {
  await launch()
  const made = await delegate('X 맡김', 'b')
  const pane = await childChat(made.task, '안녕')
  await expect(attention('P 부모')).not.toHaveCount(0, { timeout: 15_000 })
  await expect.poll(() => delegated(DONE)).toBe(1)
  expect(inbox().find((e) => e.body.includes(DONE))!.paneId).toBe('p-pane')
  await command('overview')
  await expect(win.getByTestId('overview-inbox').getByTestId('overview-inbox-row').filter({ hasText: DONE })).toHaveCount(1)
  await win.keyboard.press('Escape')
  // 백그라운드 하위 에이전트 턴: 턴 끝 뒤 하위 진행 · 알림이 와도 한 번
  await seeParent()
  expect((await cliAs(null, base, 'chat', 'send', pane, 'bgagent 해 줘')).code).toBe(0)
  await expect.poll(() => delegated(DONE), { timeout: 15_000 }).toBe(2)
  await seeParent() // 하위 알림이 같은 글로 또 알리면 새 줄이 생기게
  await win.waitForTimeout(3000) // 하위 진행(300ms) · 알림(900ms) 뒤까지 — 나타나지 않아야 하는 것을 보는 자리
  expect(delegated(DONE)).toBe(2)
  await expect(attention('P 부모')).toHaveCount(0)
  const before = inbox().length
  await app!.close(); app = undefined
  await launch()
  await win.waitForTimeout(3000) // 다시 연 기록이 부모 알림을 다시 쏟지 않는지 — 나타나지 않아야 하는 것을 보는 자리
  expect(inbox().length).toBe(before)
  await expect(attention('P 부모')).toHaveCount(0)
})

test('5b: 허락 기다림 → 한 번, 허락 뒤 턴 끝 → 한 번 더', async () => {
  await launch()
  const made = await delegate('X 맡김', 'b')
  await childChat(made.task, 'perm 1')
  await expect.poll(() => delegated(WAIT), { timeout: 15_000 }).toBe(1)
  expect(delegated(DONE)).toBe(0)
  // 맡긴 일감의 대화에서 허락
  await row('X 맡김').click()
  const chat = view().getByTestId('chat-pane').first()
  await expect(chat.getByTestId('perm-card')).toBeVisible()
  await chat.getByTestId('chat-input').press('Enter')
  await expect(chat.locator('[data-kind="text"]').last()).toHaveText('허락 받음 · touch made.txt')
  await expect.poll(() => delegated(DONE)).toBe(1)
  expect(delegated(WAIT)).toBe(1)
})

for (const how of ['archive', 'remove'] as const) {
  test(`5c: 부모를 ${how === 'archive' ? '보관' : '지운'} 뒤 맡긴 일감의 턴 끝 → 알림 없음`, async () => {
    await launch()
    const made = await delegate('X 맡김', 'b')
    if (how === 'remove') {
      expect((await cliAs(null, base, 'task', 'remove', 'P 부모', '--force')).code).toBe(0)
    } else {
      await row('P 부모').click()
      await expect(view()).toHaveAttribute('data-task-name', 'P 부모')
      await command('archive')
      await expect.poll(() => saved().find((t) => t.id === 'parent')?.archivedAt).toBeGreaterThan(0)
    }
    await expect(row('P 부모')).toHaveCount(0)
    // 부모의 pane 이 사라졌으므로 앱 밖에서 대화를 띄운다
    const r = await cliAs(null, base, 'chat', 'new', '--task', made.task, '안녕')
    expect(r.code, r.err).toBe(0)
    const pane = /대화 pane (\S+) 를/.exec(r.out)![1]!
    await expect.poll(() => fakeUserTexts().at(-1)).toBe('안녕')
    expect((await cliAs(null, base, 'chat', 'wait', pane, '--timeout', '20s')).code).toBe(0)
    await win.waitForTimeout(1500) // 알림이 없어야 하는 자리
    expect(inbox().filter((e) => e.body.includes('맡긴 일'))).toHaveLength(0)
  })
}

async function command(c: string) {
  await app!.evaluate(({ BrowserWindow }, cmd) => BrowserWindow.getAllWindows()[0]!.webContents.send('app:command', cmd), c)
}
