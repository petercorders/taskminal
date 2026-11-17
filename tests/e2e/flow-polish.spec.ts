import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { firstWindow, seedState, waitLoaded } from './helpers'

// 56단계: 앱 사용 흐름 점검에서 찾은 것 — 옆 패널 위의 팔레트 · Esc 로 패널 닫기 · 초안이 든 대화 칸 · 도구 줄 · 찾기 · 낱말
let dir: string, app: ElectronApplication, win: Page
const workflow = { id: 'wf', name: '점검 흐름', steps: [{ id: 'one', name: '점검', agent: 'claude', prompt: 'hello', after: [] }] }
async function command(cmd: string) {
  await app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0]!.webContents.send('app:command', c), cmd)
}
const panel = () => win.getByRole('complementary', { name: '작업 보조 화면' })

test.beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'tm-flow-')))
  // 일감 폴더: GitHub 꼴 origin 만 있고 커밋은 없는 로컬 저장소 — GitHub 패널이 gh(네트워크)를 부르지 않는다
  const work = join(dir, 'work')
  mkdirSync(work)
  execFileSync('git', ['init', '-q', work])
  execFileSync('git', ['-C', work, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git'])
  writeFileSync(join(work, 'long.txt'), Array.from({ length: 40 }, (_, i) => `줄 ${i + 1}`).join('\n'))
  seedState(dir, [{ id: 't', name: '흐름 일감', paneId: 'p', cwd: work }, { id: 'r', name: '원격 일감', paneId: 'rp', cwd: '/srv/app' }])
  // 둘째 일감은 원격(ssh) 일감 — 고르기 전에는 pane 을 띄우지 않는다, 호스트는 풀리지 않는 .invalid
  const statePath = join(dir, 'state.json')
  const state = JSON.parse(readFileSync(statePath, 'utf8'))
  state.tasks[1].host = 'tm-e2e.invalid'
  writeFileSync(statePath, JSON.stringify(state))
  mkdirSync(join(dir, 'workflows'))
  writeFileSync(join(dir, 'workflows/journal.json'), JSON.stringify({ templates: [workflow], runs: [] }))
  mkdirSync(join(dir, 'agent-home'))
  app = await electron.launch({
    args: ['.'],
    env: { ...process.env, TASKMINAL_USER_DATA: dir, TASKMINAL_CLAUDE_BIN: resolve('tests/fixtures/fake-claude.mjs'), TASKMINAL_AGENT_SESSIONS_HOME: join(dir, 'agent-home') },
  })
  win = await firstWindow(app)
  await waitLoaded(win)
})
test.afterEach(async () => {
  await app?.close()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
})

/** 보이는 곳 하나를 눌렀을 때 그 상자의 것이 맞는가 — 상자 오른쪽 끝(옆 패널과 겹치는 쪽)을 잰다 */
async function onTop(selector: string): Promise<{ overlaps: boolean; hit: boolean }> {
  return win.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(sel)!
    const side = document.querySelector<HTMLElement>('.work-tool-panel')!.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    const x = r.right - 12, y = r.top + r.height / 2
    const hit = document.elementFromPoint(x, y)
    return { overlaps: x > side.left && x < side.right && y > side.top && y < side.bottom, hit: !!hit && el.contains(hit) }
  }, selector)
}

test('⌘P · ⇧⌘F 는 열린 옆 패널 위에 뜬다', async () => {
  await win.getByRole('button', { name: '파일 탐색', exact: true }).click()
  await expect(panel()).toBeVisible()
  await command('palette')
  await expect(win.locator('.palette:not(.global-find)')).toBeVisible()
  // 겹치는 곳이 있어야 이 단정이 뜻이 있다
  expect(await onTop('.palette:not(.global-find) .palette-input-row')).toEqual({ overlaps: true, hit: true })
  await win.keyboard.press('Escape')
  await command('global-find')
  await expect(win.getByTestId('global-find')).toBeVisible()
  expect(await onTop('.global-find .palette-input-row')).toEqual({ overlaps: true, hit: true })
})

test('Esc 는 옆 패널을 닫는다 — 입력칸에서는 한 번 먹고, 패널 안 대화상자는 대화상자만 닫는다', async () => {
  // ① 도구 단추를 누른 직후의 Esc
  await win.getByRole('button', { name: '파일 탐색', exact: true }).click()
  await expect(panel()).toBeVisible()
  await win.keyboard.press('Escape')
  await expect(panel()).toHaveCount(0)
  await expect.poll(() => win.evaluate(() => !!document.activeElement?.closest('.xterm'))).toBe(true)
  // ② 입력칸 안의 Esc 는 쓰던 글을 두고 패널로 포커스만
  await command('workspace-browser')
  const address = win.getByRole('textbox', { name: '브라우저 주소' })
  await address.fill('http://127.0.0.1:1/쓰던-주소')
  await address.focus()
  await win.keyboard.press('Escape')
  await expect(panel()).toBeVisible()
  await expect(address).toHaveValue('http://127.0.0.1:1/쓰던-주소')
  await expect.poll(() => win.evaluate(() => document.activeElement?.matches('aside.work-tool-panel') ?? false)).toBe(true)
  await win.keyboard.press('Escape')
  await expect(panel()).toHaveCount(0)
  // ③ 패널 안 확인 대화상자의 Esc 는 대화상자만
  await command('workflows')
  const flow = win.getByRole('region', { name: '작업 흐름', exact: true })
  await flow.getByRole('combobox', { name: '저장된 작업 흐름' }).selectOption('wf')
  await flow.getByRole('button', { name: '삭제', exact: true }).click()
  const confirm = win.getByRole('alertdialog', { name: '작업 흐름 삭제' })
  await expect(confirm).toBeVisible()
  await win.keyboard.press('Escape')
  await expect(confirm).toHaveCount(0)
  await expect(panel()).toBeVisible()
})

test('대화 입력칸에 초안이 있으면 빈 화면 예시를 숨기고, 긴 초안은 칸이 자라 보인다', async () => {
  await win.getByRole('button', { name: '파일 탐색', exact: true }).click()
  await win.getByRole('button', { name: 'long.txt', exact: true }).click()
  await win.getByRole('spinbutton', { name: '첨부 시작 줄' }).fill('1')
  await win.getByRole('spinbutton', { name: '첨부 끝 줄' }).fill('40')
  await win.getByRole('button', { name: '확인한 내용을 대화에 추가' }).click()
  const input = win.getByTestId('chat-input')
  await expect(input).toHaveValue(/줄 40/)
  const empty = win.getByTestId('chat-empty')
  await expect(empty).toBeVisible()
  // 예시를 누르면 초안이 아닌 다른 글이 나간다 — 초안이 있으면 예시 단추가 없다
  await expect(empty.getByRole('button')).toHaveCount(0)
  await expect(win.getByTestId('chat-draft-note')).toContainText(/\d+줄/)
  const size = await input.evaluate((el: HTMLTextAreaElement) => ({
    h: el.getBoundingClientRect().height,
    lh: parseFloat(getComputedStyle(el).lineHeight),
    vh: window.innerHeight,
    scroll: el.scrollHeight > el.clientHeight,
  }))
  expect(size.h).toBeGreaterThan(size.lh * 6)
  expect(size.h).toBeLessThanOrEqual(size.vh * 0.4 + 1)
  expect(size.scroll).toBe(true)
  // 초안을 비우면 예시가 돌아온다
  await input.fill('')
  await expect(empty.getByRole('button')).toHaveCount(3)
})

const bar = () => win.getByRole('navigation', { name: '작업 도구' })

test('도구 줄: 이 일감 · 앱 두 묶음 한 줄, ⌘P 와 같은 이름, 원격 일감에서는 일감 도구를 끄고 이유를 보인다', async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 800))
  const taskGroup = bar().getByRole('group', { name: '이 일감' }), appGroup = bar().getByRole('group', { name: '앱' })
  await expect(taskGroup.getByRole('button')).toHaveText(['파일 탐색', '내장 브라우저', 'GitHub PR·push', '일감 도구 ▾'])
  await expect(appGroup.getByRole('button')).toHaveText(['찾기 ▾', '사용량·계정', '원격 작업 공간'])
  // 1280 폭에서 한 줄 (12개 단추가 두 줄로 감기던 것)
  // 모든 단추가 세로로 겹치면 한 줄 (두 줄이면 윗줄 bottom < 아랫줄 top)
  await expect.poll(() => bar().locator('.toolbar-group > .button').evaluateAll((els) => {
    const r = els.map((e) => e.getBoundingClientRect())
    return Math.max(...r.map((x) => x.top)) < Math.min(...r.map((x) => x.bottom))
  })).toBe(true)
  // 나머지 일감 도구는 메뉴로 — 이름은 ⌘P 와 같다
  await taskGroup.getByRole('button', { name: '일감 도구 ▾' }).click()
  const menu = win.getByRole('menu', { name: '일감 도구' })
  await expect(menu.getByRole('menuitem')).toHaveText(['워크트리 관리', '환경 준비·확장', '이슈 연결', '작업 흐름', '예약과 결과함'])
  await menu.getByRole('menuitem', { name: '워크트리 관리' }).click()
  await expect(panel().locator('header strong')).toHaveText('워크트리 관리')
  await panel().getByRole('button', { name: '작업 보조 화면 닫기' }).click()
  // 좁은 창 · 사이드바 고르기 칸도 같은 두 묶음
  await expect(bar().locator('.compact-tools-select optgroup')).toHaveCount(2)
  await expect(win.locator('.sidebar-tools-menu optgroup')).toHaveCount(2)
  // 원격 일감: 일감 도구는 꺼지고(숨기지 않음) 이유를 보인다 · 앱 도구는 그대로
  await command('next-task')
  await expect(win.locator('.sidebar .task-item.active, .sidebar [aria-current="true"]').first()).toContainText('원격 일감')
  for (const name of ['파일 탐색', '내장 브라우저', 'GitHub PR·push']) await expect(taskGroup.getByRole('button', { name, exact: true })).toBeDisabled()
  await expect(taskGroup.getByRole('button', { name: '파일 탐색', exact: true })).toHaveAttribute('title', /원격 일감/)
  await expect(appGroup.getByRole('button', { name: '사용량·계정', exact: true })).toBeEnabled()
  await taskGroup.getByRole('button', { name: '일감 도구 ▾' }).click()
  await expect(menu).toContainText('원격 일감')
  await expect(menu.getByRole('menuitem', { name: '워크트리 관리' })).toBeDisabled()
  // 고를 항목이 없어도 Esc 로 닫힌다
  await win.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(win.locator('.sidebar-tools-menu option[value="files"]')).toBeDisabled()
  // ⌘P 로 불러도 열지 않고 이유를 알린다
  await command('worktrees')
  await expect(win.getByTestId('toast')).toContainText('원격 일감')
  await expect(panel()).toHaveCount(0)
})

test('찾기 네 곳을 한 메뉴로 들어가고, 찾는 곳을 바꾸면 검색어를 가져간다', async () => {
  await bar().getByRole('button', { name: '찾기 ▾' }).click()
  const menu = win.getByRole('menu', { name: '찾기' })
  await expect(menu.getByRole('menuitem')).toHaveText([/^대화 기록 찾기/, /^에이전트 세션/, /^명령 기록.*⌘Y/, /^모든 출력에서 찾기.*⇧⌘F/])
  await menu.getByRole('menuitem', { name: /대화 기록 찾기/ }).click()
  const switcher = (root: ReturnType<Page['getByTestId']>) => root.getByRole('navigation', { name: '찾을 곳' })
  const conv = win.getByRole('dialog', { name: '대화 기록 찾기' })
  await conv.getByRole('searchbox').fill('찾을말')
  await expect(switcher(conv).getByRole('button', { name: '대화 기록' })).toHaveAttribute('aria-current', 'page')
  await switcher(conv).getByRole('button', { name: '모든 출력' }).click()
  await expect(conv).toHaveCount(0)
  const out = win.getByTestId('global-find')
  await expect(out.getByRole('textbox', { name: '모든 출력에서 찾을 말' })).toHaveValue('찾을말')
  await switcher(out).getByRole('button', { name: '명령 기록' }).click()
  await expect(out).toHaveCount(0)
  const hist = win.getByTestId('history-panel')
  await expect(hist.getByRole('textbox', { name: '기록에서 찾기' })).toHaveValue('찾을말')
  await switcher(hist).getByRole('button', { name: '에이전트 세션' }).click()
  await expect(hist).toHaveCount(0)
  const ses = win.getByRole('dialog', { name: '에이전트 세션' })
  await expect(ses.getByRole('searchbox')).toHaveValue('찾을말')
  await switcher(ses).getByRole('button', { name: '대화 기록' }).click()
  await expect(win.getByRole('dialog', { name: '대화 기록 찾기' }).getByRole('searchbox')).toHaveValue('찾을말')
})

test('두 뜻 낱말: 원격은 원격 작업 공간에만 · 사이드바 보기는 상태별 · 탭 줄은 명령 기록', async () => {
  await expect(win.getByRole('radiogroup', { name: '사이드바 보기' }).getByRole('radio')).toHaveText(['상태별', '묶음별'])
  await expect(win.locator('[data-testid="task-view"][aria-hidden="false"] .tab-action.history .tab-action-label')).toHaveText('명령 기록')
  await bar().getByRole('button', { name: 'GitHub PR·push', exact: true }).click()
  const git = win.getByTestId('git-workflow')
  await expect(git.getByRole('heading', { level: 2 })).toHaveText('GitHub PR·push')
  await expect(git.getByRole('combobox', { name: 'push 할 remote' }).locator('option[value="origin"]')).toHaveCount(1)
  await expect(git).not.toContainText('원격')
})

async function openIssues() {
  await bar().getByRole('button', { name: '일감 도구 ▾' }).click()
  await win.getByRole('menuitem', { name: '이슈 연결' }).click()
  return win.getByTestId('issues-panel').getByRole('textbox', { name: 'GitHub 저장소 (owner/repo)' })
}

test('이슈 연결: GitHub 저장소 칸을 일감 폴더의 remote 로 채운다', async () => {
  await expect(await openIssues()).toHaveValue('acme/widgets')
})

test('이슈 연결: 저장소 답이 오기 전에 직접 쓴 값은 덮지 않는다', async () => {
  // 답을 붙잡아 두고 먼저 쓴 뒤 놓는다
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>> })._invokeHandlers
    const original = handlers.get('issues:repo')!
    ipcMain.removeHandler('issues:repo')
    ipcMain.handle('issues:repo', async (...args) => {
      await new Promise((r) => ((globalThis as unknown as { releaseRepo: () => void }).releaseRepo = r as () => void))
      return original(...args)
    })
  })
  const field = await openIssues()
  await field.fill('mine/typed')
  await expect.poll(() => app.evaluate(() => typeof (globalThis as unknown as { releaseRepo?: unknown }).releaseRepo)).toBe('function')
  await app.evaluate(() => (globalThis as unknown as { releaseRepo: () => void }).releaseRepo())
  await win.waitForTimeout(300)
  await expect(field).toHaveValue('mine/typed')
})

test('일감을 오가 다시 보이게 된 옆 패널은 터미널 포커스를 뺏지 않는다', async () => {
  await win.getByRole('button', { name: '파일 탐색', exact: true }).click()
  await expect(panel()).toBeVisible()
  await command('next-task')
  await expect(panel()).toHaveCount(0)
  await command('prev-task')
  await expect(panel()).toBeVisible()
  await expect.poll(() => win.evaluate(() => !!document.activeElement?.closest('.xterm'))).toBe(true)
  await win.waitForTimeout(200)
  expect(await win.evaluate(() => !!document.activeElement?.closest('.work-tool-panel'))).toBe(false)
})

test('열려 있는 명령 기록으로 찾는 곳을 바꿔도 검색어를 가져간다', async () => {
  await command('history')
  const hist = win.getByTestId('history-panel')
  await hist.getByRole('textbox', { name: '기록에서 찾기' }).fill('먼저말')
  await command('global-find')
  const out = win.getByTestId('global-find')
  await out.getByRole('textbox', { name: '모든 출력에서 찾을 말' }).fill('나중말')
  await out.getByRole('navigation', { name: '찾을 곳' }).getByRole('button', { name: '명령 기록' }).click()
  await expect(out).toHaveCount(0)
  await expect(hist.getByRole('textbox', { name: '기록에서 찾기' })).toHaveValue('나중말')
})

test('이슈 연결: 다른 서비스로 갔다가 GitHub 로 돌아오면 저장소 칸을 다시 채운다', async () => {
  const field = await openIssues()
  await expect(field).toHaveValue('acme/widgets')
  const service = win.getByTestId('issues-panel').getByRole('combobox', { name: '이슈 서비스' })
  await service.selectOption('linear')
  await service.selectOption('github')
  await expect(field).toHaveValue('acme/widgets')
})

test('환경 준비: 워크트리 목록을 읽지 못하면 없다고 하지 않고 그렇게 알린다', async () => {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('worktrees:targets')
    ipcMain.handle('worktrees:targets', async () => { throw new Error('읽기 실패') })
  })
  await bar().getByRole('button', { name: '일감 도구 ▾' }).click()
  await win.getByRole('menuitem', { name: '환경 준비·확장' }).click()
  const dev = win.getByTestId('development-panel')
  await expect(dev).toContainText('워크트리 목록을 읽지 못했어요')
  await expect(dev).not.toContainText('다른 워크트리가 없어요')
  await expect(dev.getByRole('textbox', { name: '준비할 워크트리 경로' })).toBeVisible()
})

test('이슈 연결: 저장소 답이 비었거나 실패했으면 패널을 다시 열 때 다시 묻는다', async () => {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>> })._invokeHandlers
    const original = handlers.get('issues:repo')!
    const g = globalThis as unknown as { repoCalls: number }
    g.repoCalls = 0
    ipcMain.removeHandler('issues:repo')
    ipcMain.handle('issues:repo', async (...args) => {
      g.repoCalls++
      if (g.repoCalls === 1) return null
      if (g.repoCalls === 2) throw new Error('읽기 실패')
      return original(...args)
    })
  })
  const calls = () => app.evaluate(() => (globalThis as unknown as { repoCalls: number }).repoCalls)
  const reopen = async () => {
    await panel().getByRole('button', { name: '작업 보조 화면 닫기' }).click()
    await expect(panel()).toHaveCount(0)
    return openIssues()
  }
  await openIssues()
  await expect.poll(calls).toBe(1)
  // 앞 답이 패널에 닿기 전(묻는 중)에 다시 열면 건너뛰는 것이 맞다 — 다시 묻을 때까지 닫았다 열기를 되풀이한다.
  // 한 번 물은 뒤 다시 묻지 않는 회귀면 끝까지 1 이라 실패한다.
  await expect(async () => {
    await reopen()
    expect(await calls()).toBeGreaterThanOrEqual(2)
  }).toPass({ timeout: 5000 })
  await expect(async () => {
    const field = await reopen()
    await expect(field).toHaveValue('acme/widgets', { timeout: 500 })
  }).toPass({ timeout: 5000 })
})
