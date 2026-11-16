import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { captureWindow, firstWindow, runCli, seedState, waitLoaded } from './helpers'

// 53단계: 밖에서 시작한 에이전트 세션 — 가짜 홈(TASKMINAL_AGENT_SESSIONS_HOME)의 직접 만든 가짜 기록만 읽는다.
// 가짜 claude(tests/fixtures/fake-claude.mjs)가 대화 pane 의 --resume 을, 가짜 TUI 스크립트가 터미널 시작 명령을 받는다.
const FAKE = resolve(__dirname, '../fixtures/fake-claude.mjs')
const C1 = 'aaaaaaaa-1111-4111-8111-111111111111'
const X1 = 'bbbbbbbb-2222-4222-8222-222222222222'
const G1 = 'cccccccc-3333-4333-8333-333333333333'
const D1 = 'dddddddd-4444-4444-8444-444444444444'
let app: ElectronApplication | undefined
let win: Page
let userData: string
let work: string
let log: string

const jsonl = (...rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
function claudeSession(id: string, cwd: string, text: string, mtime: number) {
  const dir = join(userData, 'agent-home', '.claude', 'projects', '-fake-project')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${id}.jsonl`)
  writeFileSync(path, jsonl({ type: 'session-owner', sessionId: id }, { type: 'user', cwd, sessionId: id, timestamp: '2026-11-01T00:00:00.000Z', message: { role: 'user', content: text } }))
  utimesSync(path, mtime, mtime)
  return path
}
function codexSession(id: string, cwd: string, text: string, mtime: number) {
  const dir = join(userData, 'agent-home', '.codex', 'sessions', '2026', '11', '01')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `rollout-2026-11-01T00-00-00-${id}.jsonl`)
  writeFileSync(path, jsonl({ type: 'session_meta', payload: { id, cwd, timestamp: '2026-11-01T00:00:00.000Z', source: 'cli' } }, { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }))
  utimesSync(path, mtime, mtime)
  return path
}

async function launch() {
  const bin = join(userData, 'fakebin')
  mkdirSync(bin, { recursive: true })
  const tui = join(bin, 'agent-tui')
  writeFileSync(tui, '#!/bin/sh\necho "FAKE-TUI $*"\n')
  chmodSync(tui, 0o755)
  app = await electron.launch({
    args: ['.'],
    env: { ...process.env, TASKMINAL_USER_DATA: userData, TASKMINAL_AGENT_SESSIONS_HOME: join(userData, 'agent-home'), TASKMINAL_CLAUDE_BIN: FAKE, FAKE_CLAUDE_LOG: log, TASKMINAL_CLAUDE_TUI: tui, TASKMINAL_CODEX_TUI: tui },
  })
  win = await firstWindow(app)
  await waitLoaded(win)
}
async function command(c: string) {
  await app!.evaluate(({ BrowserWindow }, cmd) => BrowserWindow.getAllWindows()[0]!.webContents.send('app:command', cmd), c)
}
const dialog = () => win.getByRole('dialog', { name: '에이전트 세션' })
const rows = () => dialog().locator('li.agent-session')
const row = (id: string) => dialog().locator(`li.agent-session[data-session-id="${id}"]`)
const tabViews = () => win.locator('[data-testid="task-view"][aria-hidden="false"] [data-testid="tab-view"]')
const chat = () => win.locator('[data-testid="task-view"][aria-hidden="false"] [data-testid="chat-pane"]:visible')
const argvs = () =>
  existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { argv?: string[]; cwd?: string }).filter((l) => l.argv) : []
async function say(text: string) {
  await chat().getByTestId('chat-input').fill(text)
  await chat().getByTestId('chat-input').press('Enter')
}

test.describe.configure({ timeout: 90_000 })
test.beforeEach(() => {
  userData = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-e2e-')))
  work = join(userData, 'work')
  mkdirSync(join(work, 'sub'), { recursive: true })
  log = join(userData, 'fake-claude.log')
  const now = Math.floor(Date.now() / 1000)
  claudeSession(C1, work, '가짜 결제 버그 고치기 INTERNAL-ABCDEF', now - 120)
  codexSession(X1, join(work, 'sub'), '가짜 코덱스 시험 추가', now - 3 * 3600)
  claudeSession(G1, join(userData, 'gone'), '가짜 사라진 폴더 세션', now - 2 * 86400)
  claudeSession(D1, userData, '가짜 지울 기록', now - 40 * 86400)
  seedState(
    userData,
    [
      { id: 'task-a', name: 'A 일감', paneId: 'pane-a', cwd: work },
      { id: 'task-b', name: 'B 일감', paneId: 'pane-b', cwd: userData },
    ],
    [],
    { secretCustom: [{ name: '내부', pattern: 'INTERNAL-[A-Z]{6}' }] },
  )
})
test.afterEach(async () => {
  await app?.close()
  app = undefined
  rmSync(userData, { recursive: true, force: true, maxRetries: 5 })
})

test('⌘P 로 열어 찾기 · 에이전트 · 범위로 거르고 대화로 이어 하기 → 다시 열면 그 대화로 이동', async () => {
  await launch()
  await win.keyboard.press('Meta+p')
  await win.keyboard.type('에이전트 세션')
  await win.keyboard.press('Enter')
  await expect(dialog().getByRole('searchbox')).toBeFocused()
  // 기본 범위 = 이 일감 폴더(work 와 그 안쪽)
  await expect(rows()).toHaveCount(2)
  await expect(rows().first()).toHaveAttribute('data-session-id', C1)
  await expect(dialog()).not.toContainText('INTERNAL-ABCDEF')
  await expect(row(C1)).toContainText('‹가림:내부›')
  await dialog().getByRole('combobox', { name: '범위', exact: true }).selectOption('all')
  await expect(rows()).toHaveCount(4)
  await dialog().getByRole('combobox', { name: '에이전트', exact: true }).selectOption('codex')
  await expect(rows()).toHaveCount(1)
  await expect(rows().first()).toContainText('Codex')
  await dialog().getByRole('combobox', { name: '에이전트', exact: true }).selectOption('all')
  await dialog().getByRole('searchbox').fill('결제')
  await expect(rows()).toHaveCount(1)
  await dialog().getByRole('searchbox').fill('')
  // 키보드만으로: 찾기 칸에서 Tab 으로 첫 줄의 '대화로 이어 하기' 까지 닿는다
  await dialog().getByRole('searchbox').focus()
  for (let i = 0; i < 3; i++) await win.keyboard.press('Tab')
  await expect(row(C1).getByRole('button', { name: '대화로 이어 하기' })).toBeFocused()

  // 글자 12px 이상 · 대비 4.5 이상 (readability.spec 과 같은 셈 — 반투명 바탕은 섞는다)
  const bad = await dialog().evaluate((root) => {
    const parse = (c: string): number[] => {
      const m = c.match(/rgba?\(([^)]+)\)/)
      if (!m) {
        const s = c.match(/color\(srgb\s+([^)]*)\)/)
        if (!s) return [0, 0, 0, 0]
        const p = s[1]!.split(/[ /]+/).filter(Boolean).map(Number)
        return [p[0]! * 255, p[1]! * 255, p[2]! * 255, p[3] ?? 1]
      }
      const p = m[1]!.split(/[ ,/]+/).filter(Boolean).map(Number)
      return [p[0]!, p[1]!, p[2]!, p[3] ?? 1]
    }
    const lum = (c: number[]) => {
      const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
      return 0.2126 * f(c[0]!) + 0.7152 * f(c[1]!) + 0.0722 * f(c[2]!)
    }
    const background = (el: Element) => {
      const layers: number[][] = []
      for (let e: Element | null = el; e; e = e.parentElement) {
        const c = parse(getComputedStyle(e).backgroundColor)
        if (c[3]! > 0) layers.push(c)
        if (c[3]! >= 1) break
      }
      let bg = [0, 0, 0, 1]
      for (const l of layers.reverse()) bg = [0, 1, 2].map((i) => l[i]! * l[3]! + bg[i]! * (1 - l[3]!)).concat(1)
      return bg
    }
    const out: string[] = []
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement
      if (!el || !n.textContent!.trim() || !el.getClientRects().length || el.closest('button:disabled, [aria-hidden="true"]')) continue
      const st = getComputedStyle(el)
      const a = lum(parse(st.color)), b = lum(background(el))
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
      if (parseFloat(st.fontSize) < 12 || ratio < 4.5) out.push(`${n.textContent!.trim().slice(0, 24)} ${st.fontSize} ${ratio.toFixed(2)}`)
    }
    return out
  })
  expect(bad).toEqual([])
  await captureWindow(app!, 'test-results/agent-sessions.png')

  const before = await tabViews().count()
  await row(C1).getByRole('button', { name: '대화로 이어 하기' }).click()
  await expect(dialog()).toHaveCount(0)
  await expect(tabViews()).toHaveCount(before + 1)
  await expect(chat()).toHaveCount(1)
  await say('이어서 해 줘')
  await expect.poll(() => argvs().at(-1)?.argv?.join(' ')).toContain(`--resume ${C1}`)
  expect(argvs().at(-1)?.cwd).toBe(work)

  // 같은 세션 — 다른 일감(B)에서 패널을 열어도 이 앱에 열린 대화(A 일감)로 이동만, 탭을 또 만들지 않는다
  await win.locator('[data-testid="task-row"][data-task-name="B 일감"]').click()
  await expect(win.locator('[data-testid="task-view"]:visible')).toHaveAttribute('data-task-name', 'B 일감')
  const bTabs = await tabViews().count()
  await command('agent-sessions')
  await expect(row(C1)).toContainText('이 앱에 열림')
  await row(C1).getByRole('button', { name: '열린 대화로 가기' }).click()
  await expect(dialog()).toHaveCount(0)
  await expect(win.locator('[data-testid="task-view"]:visible')).toHaveAttribute('data-task-name', 'A 일감')
  await expect(chat()).toHaveCount(1)
  await expect(tabViews()).toHaveCount(before + 1)
  await win.locator('[data-testid="task-row"][data-task-name="B 일감"]').click()
  await expect(tabViews()).toHaveCount(bTabs)
})

test('터미널로 이어 하기 → 시작 명령 · 폴더 없음 · 사라진 기록은 막고 안내 · 같은 프레임 두 번에도 탭 하나', async () => {
  await launch()
  await command('agent-sessions')
  await dialog().getByRole('combobox', { name: '범위', exact: true }).selectOption('all')
  await expect(rows()).toHaveCount(4)
  const before = await tabViews().count()

  // 세션 폴더가 없다 → 막고 안내, 탭 그대로
  await row(G1).getByRole('button', { name: '대화로 이어 하기' }).click()
  await expect(row(G1).getByRole('alert')).toContainText('세션 폴더가 없어요')
  // 목록 뒤 기록 파일이 사라졌다 → main 이 id 로 다시 찾다 막는다
  rmSync(join(userData, 'agent-home', '.claude', 'projects', '-fake-project', `${D1}.jsonl`))
  await row(D1).getByRole('button', { name: '터미널로 이어 하기' }).click()
  await expect(row(D1).getByRole('alert')).toContainText('찾지 못했어요')
  await expect(tabViews()).toHaveCount(before)

  // 같은 프레임에 두 번 누른다 → 탭 하나
  await row(X1).getByRole('button', { name: '터미널로 이어 하기' }).evaluate((b: HTMLElement) => {
    b.click()
    b.click()
  })
  await expect(dialog()).toHaveCount(0)
  await expect(tabViews()).toHaveCount(before + 1)
  const term = win.locator('[data-testid="task-view"][aria-hidden="false"] [data-testid="tab-view"]:visible .xterm-rows')
  await expect(term).toContainText(`FAKE-TUI resume ${X1}`, { timeout: 15_000 })
  await win.waitForTimeout(500)
  await expect(tabViews()).toHaveCount(before + 1)
})

test('패널을 연 뒤 그 일감이 사라지면 이어 하기를 막고 안내한다', async () => {
  await launch()
  await command('agent-sessions')
  await expect(rows()).toHaveCount(2)
  const r = await runCli(userData, 'task', 'remove', 'task-a', '--force')
  expect(r.code, r.err).toBe(0)
  await expect(dialog()).toContainText('연 일감이 사라졌어요')
  await dialog().getByRole('combobox', { name: '범위', exact: true }).selectOption('all')
  await expect(row(C1).getByRole('button', { name: '대화로 이어 하기' })).toBeDisabled()
  await expect(row(C1).getByRole('button', { name: '터미널로 이어 하기' })).toBeDisabled()
})

test('resume 도중 실패 → 대화 띠의 다시 시도는 resume 연결부터, 탭을 또 만들지 않는다', async () => {
  await launch()
  await command('agent-sessions')
  const before = await tabViews().count()
  await row(C1).getByRole('button', { name: '대화로 이어 하기' }).click()
  await expect(tabViews()).toHaveCount(before + 1)
  await say('crash now')
  const band = chat().getByTestId('chat-band').last()
  await expect(band).toHaveAttribute('data-error', 'crash')
  await band.getByRole('button', { name: '다시 시도' }).click()
  await expect.poll(() => argvs().length).toBe(2)
  for (const a of argvs()) expect(a.argv!.join(' ')).toContain(`--resume ${C1}`)
  await expect(tabViews()).toHaveCount(before + 1)
})

test('좁은 창 · 확대에서도 가로로 넘치지 않고 Esc 로 닫힌다', async () => {
  await launch()
  await command('agent-sessions')
  await expect(rows()).toHaveCount(2)
  await app!.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]!
    w.setSize(640, 480)
    w.webContents.setZoomFactor(2)
  })
  await expect.poll(() => win.evaluate(() => innerWidth)).toBe(320)
  await expect
    .poll(() => dialog().evaluate((e) => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && e.scrollWidth <= e.clientWidth + 1 }))
    .toBe(true)
  await expect(row(C1).getByRole('button', { name: '터미널로 이어 하기' })).toBeVisible()
  await captureWindow(app!, 'test-results/agent-sessions-small.png')
  await dialog().getByRole('searchbox').press('Escape')
  await expect(dialog()).toHaveCount(0)
})
