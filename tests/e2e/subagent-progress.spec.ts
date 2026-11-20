import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { captureWindow, firstWindow, seedState, stopRemoteTerminalHost, waitLoaded } from './helpers'

// 68단계: 대화 pane 의 하위 에이전트(Agent) 카드 — 가짜 claude(tests/fixtures/fake-claude.mjs) 의 `subagent` · `bgagent` 대본.
// docs/stages/68-subagent-progress.md '돌려야 할 e2e' 1~6.
const FAKE = resolve(__dirname, '../fixtures/fake-claude.mjs')
const shots = 'test-results/stacked-e2e'
let userData: string
let log: string
let bin: string
let app: ElectronApplication | undefined
let win: Page

/** 가짜 claude 의 setTimeout 을 factor 배로 늘린 감싸개 — 백그라운드 진행 · 알림이 오는 때를 시험이 고른다(fixture 는 그대로) */
function slowClaude(factor: number): string {
  const path = join(userData, `fake-claude-x${factor}.mjs`)
  writeFileSync(path, `#!/usr/bin/env node\nconst t = globalThis.setTimeout\nglobalThis.setTimeout = (fn, ms, ...a) => t(fn, (ms ?? 0) * ${factor}, ...a)\nawait import(${JSON.stringify(pathToFileURL(FAKE).href)})\n`)
  chmodSync(path, 0o755)
  return path
}
async function launch(claude = bin, settings: Record<string, unknown> = {}) {
  if (settings && Object.keys(settings).length) seedState(userData, [{ id: 'task-a', name: 'A 일감', paneId: 'pane-a', cwd: userData }], [], settings)
  app = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: userData, TASKMINAL_CLAUDE_BIN: claude, FAKE_CLAUDE_LOG: log } })
  win = await firstWindow(app)
  await waitLoaded(win)
}
const command = (c: string) => app!.evaluate(({ BrowserWindow }, cmd) => BrowserWindow.getAllWindows()[0]!.webContents.send('app:command', cmd), c)
const chat = () => win.locator('[data-testid="task-view"][aria-hidden="false"] [data-testid="chat-pane"]').first()
const input = () => chat().getByTestId('chat-input')
const card = () => chat().locator('[data-kind="agent"]')
async function say(text: string) {
  await input().fill(text)
  await input().press('Enter')
}
const argvs = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { argv?: string[] }).filter((l) => l.argv).map((l) => l.argv!) : [])
const argOf = (argv: string[], k: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined)

test.describe('로컬 대화 pane', () => {
  test.describe.configure({ timeout: 90_000 })
  test.beforeEach(() => {
    userData = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-e2e-68-')))
    log = join(userData, 'fake-claude.log')
    bin = FAKE
    mkdirSync(shots, { recursive: true })
    seedState(userData, [{ id: 'task-a', name: 'A 일감', paneId: 'pane-a', cwd: userData }])
  })
  test.afterEach(async () => {
    await app?.close()
    app = undefined
    rmSync(userData, { recursive: true, force: true, maxRetries: 5 })
  })

  test('1: subagent → Agent 카드 · 본 흐름에 하위 Read 묶음 · 하위 중간 글 없음 · 하위 도구 1개 펼치면 Read · ✓ 끝남 · 요약', async () => {
    await launch()
    await command('chat-new')
    await say('subagent 해 줘')
    await expect(chat().locator('[data-kind="text"]').last()).toHaveText('하위 에이전트가 1줄이래요')
    await expect(chat().getByTestId('chat-status')).toContainText('✓ 끝남')
    await expect(card()).toHaveCount(1)
    await expect(card().locator('.chat-subagent-head')).toContainText('줄 세기')
    await expect(card().locator('.chat-tools-state')).toHaveText('✓ 끝남')
    await expect(card().getByTestId('chat-agent-summary')).toHaveText('1줄이에요')
    // 본 흐름: 하위 에이전트의 Read 는 도구 묶음으로 나오지 않고, 하위 에이전트의 중간 글도 없다
    await expect(chat().locator('[data-kind="tools"]')).toHaveCount(0)
    await expect(chat()).not.toContainText('하위 에이전트 중간 글')
    const toggle = card().getByRole('button', { name: '하위 도구 1개' })
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    // 카드 안의 글 · 단추가 카드 상자 안에 있다(다음 블록에 덮이지 않는다)
    const fit = await card().evaluate((c) => ({ scroll: c.scrollHeight, client: c.clientHeight, height: getComputedStyle(c).height }))
    expect.soft(fit.scroll, JSON.stringify(fit)).toBeLessThanOrEqual(fit.client + 1)
    await win.screenshot({ path: `${shots}/68-1-subagent-before-open.png` })
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(card().getByTestId('chat-agent-sub-item')).toHaveCount(1)
    await expect(card().getByTestId('chat-agent-sub-item')).toContainText('Read')
    await expect(card().getByTestId('chat-agent-sub-item')).toContainText('a.ts')
    await win.screenshot({ path: `${shots}/68-1-subagent.png` })
  })

  test('2: bgagent → 턴 끝 뒤 카드가 진행 중 · 백그라운드 → 알림이 오면 ✓ 끝남 · 요약', async () => {
    // 진행 중을 놓치지 않게 백그라운드 진행(300ms) · 알림(900ms)을 3배로
    await launch(slowClaude(3))
    await command('chat-new')
    await say('bgagent 해 줘')
    await expect(chat().getByTestId('chat-status')).toContainText('✓ 끝남')
    await expect(chat().locator('[data-kind="text"]').last()).toHaveText('뒤에서 세는 중이에요')
    await expect(card().locator('.chat-tools-state')).toHaveText('진행 중')
    await expect(card().locator('.chat-subagent-bg')).toHaveText('백그라운드')
    await expect(card().getByTestId('chat-agent-summary')).toHaveCount(0)
    await win.screenshot({ path: `${shots}/68-2-bg-running.png` })
    await expect(card().locator('.chat-tools-state')).toHaveText('✓ 끝남', { timeout: 10_000 })
    await expect(card().getByTestId('chat-agent-summary')).toHaveText('1줄이에요')
    await expect(card().locator('.chat-subagent-bg')).toHaveText('백그라운드')
    await expect(chat().locator('[data-kind="tools"]')).toHaveCount(0)
    await expect(chat()).not.toContainText('하위 에이전트 중간 글')
  })

  test('3: bgagent 를 보내고 알림 전에 앱을 끝냈다 다시 열면 카드가 멈춤', async () => {
    // 알림이 시험 동안 오지 않게(300ms · 900ms → 300s · 900s)
    const slow = slowClaude(1000)
    await launch(slow)
    await command('chat-new')
    await say('bgagent 해 줘')
    await expect(chat().getByTestId('chat-status')).toContainText('✓ 끝남')
    await expect(card().locator('.chat-tools-state')).toHaveText('진행 중')
    await app!.close()
    app = undefined
    await launch(slow)
    await expect(card()).toHaveCount(1)
    await expect(card().locator('.chat-tools-state')).toHaveText('멈춤')
    await expect(card().getByTestId('chat-agent-summary')).toHaveCount(0)
  })

  test('4a: subagent 턴 뒤 여기로 되감기 → 다음 보내기의 --resume-session-at 이 본 줄 anchor(u-…)', async () => {
    await launch()
    await command('chat-new')
    await say('subagent 하나')
    await expect(card().locator('.chat-tools-state')).toHaveText('✓ 끝남')
    await say('둘')
    await expect(chat().locator('[data-kind="text"]').last()).toHaveText('echo: 둘')
    const users = chat().locator('[data-kind="user"]')
    await users.nth(1).hover()
    await users.nth(1).getByTestId('chat-rewind').click()
    await input().press('Enter')
    await expect(users).toHaveCount(1)
    await say('둘 다시')
    await expect(chat().locator('[data-kind="text"]').last()).toHaveText('echo: 둘 다시')
    const last = argvs().at(-1)!
    expect(last).toContain('--fork-session')
    // subagent 턴의 본 에이전트 마지막 줄 = u-<pid>-2 (하위 줄은 s-<pid>-n)
    expect(argOf(last, '--resume-session-at')).toMatch(/^u-\d+-2$/)
  })

  test('4b: subagent 턴에서 여기서 새 대화로 나누기 → 오른쪽 대화의 보내기가 본 줄 anchor(u-…)', async () => {
    await launch()
    await command('chat-new')
    await say('subagent 하나')
    await expect(card().locator('.chat-tools-state')).toHaveText('✓ 끝남')
    await say('둘')
    await expect(chat().locator('[data-kind="text"]').last()).toHaveText('echo: 둘')
    const users = chat().locator('[data-kind="user"]')
    await users.first().hover()
    await users.first().getByTestId('chat-branch').click()
    const panes = win.locator('[data-testid="task-view"][aria-hidden="false"] [data-testid="chat-pane"]')
    await expect(panes).toHaveCount(2)
    const right = panes.nth(1)
    await expect(right.locator('[data-kind="agent"]')).toHaveCount(1)
    await right.getByTestId('chat-input').fill('갈래')
    await right.getByTestId('chat-input').press('Enter')
    await expect(right.locator('[data-kind="text"]').last()).toHaveText('echo: 갈래')
    const last = argvs().at(-1)!
    expect(last).toContain('--fork-session')
    expect(argOf(last, '--resume-session-at')).toMatch(/^u-\d+-2$/)
  })

  for (const theme of ['dark', 'light'] as const) {
    test(`5: 좁은 pane(320px) · ${theme} — 카드 머리가 넘치지 않고 글자 대비 4.5 이상 · Tab 으로 펼치기 단추 · Enter/Space`, async () => {
      await launch(bin, { theme })
      await command('chat-new')
      await say('subagent 하나')
      await expect(card().locator('.chat-tools-state')).toHaveText('✓ 끝남')
      // 640×400 · 200% → 창 안 320 CSS px. 대화 pane 이 그 폭 안에 들어간다
      await app!.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]!; w.setSize(640, 400); w.webContents.setZoomFactor(2) })
      await expect.poll(() => win.evaluate(() => document.documentElement.clientWidth)).toBeLessThanOrEqual(330)
      await card().scrollIntoViewIfNeeded()
      const paneWidth = await chat().evaluate((e) => e.getBoundingClientRect().width)
      expect(paneWidth).toBeLessThanOrEqual(330)
      const g = await card().evaluate((root) => {
        const head = root.querySelector('.chat-subagent-head') as HTMLElement
        const hb = head.getBoundingClientRect()
        const kids = Array.from(head.children).map((e) => ({ cls: e.className, text: e.textContent, right: e.getBoundingClientRect().right, left: e.getBoundingClientRect().left }))
        return { headFits: head.scrollWidth <= head.clientWidth + 1, headRight: hb.right, headLeft: hb.left, kids, cardFits: root.scrollWidth <= root.clientWidth + 1 }
      })
      expect(g.headFits, JSON.stringify(g)).toBe(true)
      expect(g.cardFits, JSON.stringify(g)).toBe(true)
      for (const k of g.kids) {
        expect(k.right, JSON.stringify(g)).toBeLessThanOrEqual(g.headRight + 1)
        expect(k.left, JSON.stringify(g)).toBeGreaterThanOrEqual(g.headLeft - 1)
      }
      // 글자 대비(WCAG, 반투명 바탕은 섞는다) — 카드 안의 보이는 글자 모두
      const bad = await card().evaluate((root) => {
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
        const over = (top: number[], under: number[]) => [0, 1, 2].map((i) => top[i]! * top[3]! + under[i]! * (1 - top[3]!)).concat(1)
        const lum = (c: number[]) => { const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(c[0]!) + 0.7152 * f(c[1]!) + 0.0722 * f(c[2]!) }
        const background = (el: Element) => {
          const layers: number[][] = []
          for (let e: Element | null = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c[3]! > 0) layers.push(c); if (c[3]! >= 1) break }
          let bg = [0, 0, 0, 1]
          for (const l of layers.reverse()) bg = over(l, bg)
          return bg
        }
        const out: Array<{ text: string; ratio: number; fg: string; bg: string }> = []
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const el = n.parentElement
          if (!el || !n.textContent!.trim() || el.closest('[aria-hidden="true"]')) continue
          const bg = background(el), fg = over(parse(getComputedStyle(el).color), bg)
          const [a, b] = [lum(fg) + 0.05, lum(bg) + 0.05]
          const ratio = Math.max(a, b) / Math.min(a, b)
          if (ratio < 4.5) out.push({ text: n.textContent!.trim(), ratio: Math.round(ratio * 100) / 100, fg: getComputedStyle(el).color, bg: bg.map(Math.round).join(',') })
        }
        return out
      })
      await captureWindow(app!, `${shots}/68-5-narrow-${theme}.png`)
      expect(bad).toEqual([])
      // 키보드: 입력칸에서 Shift+Tab 으로 펼치기 단추까지 닿고, Enter · Space 로 여닫는다
      const toggle = card().getByRole('button', { name: '하위 도구 1개' })
      await input().focus()
      let reached = false
      for (let i = 0; i < 40 && !reached; i++) {
        await win.keyboard.press('Shift+Tab')
        reached = await toggle.evaluate((e) => e === document.activeElement)
      }
      expect(reached).toBe(true)
      await win.keyboard.press('Enter')
      await expect(toggle).toHaveAttribute('aria-expanded', 'true')
      await expect(card().getByTestId('chat-agent-sub-item')).toHaveCount(1)
      await win.keyboard.press('Space')
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await expect(card().getByTestId('chat-agent-sub-item')).toHaveCount(0)
      // 포인터 영역 24px 이상(68 계획 밖 고침 — min-height 24px)
      expect(await toggle.evaluate((e) => e.getBoundingClientRect().height)).toBeGreaterThanOrEqual(23.5)
    })
  }
})

// 6: 원격 패널 대화 — 원격 서버(가짜 claude)를 띄우고 앱의 원격 패널에서 subagent 를 보낸다(remote-workspace.spec 과 같은 준비)
test.describe('원격 패널 대화', () => {
  let temp: string, root: string, data: string, url: string, token: string, server: ChildProcess
  test.describe.configure({ timeout: 120_000 })
  test.beforeEach(async () => {
    temp = realpathSync(mkdtempSync(join(tmpdir(), 'tm-e2e-68-remote-'))); root = join(temp, 'root'); data = join(temp, 'server'); mkdirSync(root)
    mkdirSync(shots, { recursive: true })
    writeFileSync(join(root, 'a.ts'), 'export const a = 1\n')
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
    server = spawn(resolve('resources/bin/taskminal-server'), ['--root', root, '--data', data, '--port', '0'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TASKMINAL_CLAUDE_BIN: FAKE, FAKE_CLAUDE_LOG: join(temp, 'claude.log') } })
    const info = await new Promise<{ url: string; tokenFile: string }>((ok, fail) => {
      let buffer = '', errors = ''
      const timer = setTimeout(() => fail(Error('server timeout ' + errors)), 15_000)
      server.stderr?.on('data', (d) => (errors += d))
      server.once('exit', (code) => { clearTimeout(timer); fail(Error('server exited ' + code + ' ' + errors)) })
      server.stdout?.on('data', (d) => { buffer += d; const line = buffer.split('\n')[0]; if (line) { try { const v = JSON.parse(line); clearTimeout(timer); ok(v) } catch { /* 줄이 덜 옴 */ } } })
    })
    url = info.url; token = readFileSync(info.tokenFile, 'utf8')
  })
  test.afterEach(async () => {
    await app?.close(); app = undefined
    if (server?.exitCode === null) { const done = new Promise<void>((r) => server.once('exit', () => r())); server.kill('SIGTERM'); await done }
    await stopRemoteTerminalHost(data)
    rmSync(temp, { recursive: true, force: true, maxRetries: 5 })
  })

  test('6: 원격 패널 대화의 agent 블록은 대화 중지됨이 아니라 펼칠 수 있는 details 로 보인다', async () => {
    const uiData = join(temp, 'client'); mkdirSync(uiData)
    seedState(uiData, [{ id: 'task', name: 'Local', paneId: 'shell', cwd: root }])
    app = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: uiData } })
    win = await firstWindow(app); await waitLoaded(win)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('app:command', 'remote-workspace'))
    await win.getByRole('textbox', { name: '원격 서버 주소', exact: true }).fill(url)
    await win.getByLabel('원격 서버 토큰', { exact: true }).fill(token)
    await win.getByRole('button', { name: '연결', exact: true }).click()
    await expect(win.getByRole('button', { name: '연결 해제', exact: true })).toBeVisible()
    await win.getByRole('button', { name: '작업 공간 열기', exact: true }).click()
    await win.getByRole('button', { name: '대화', exact: true }).click()
    await win.getByRole('button', { name: '새 Claude 대화', exact: true }).click()
    const prompt = win.getByRole('textbox', { name: '원격 대화 지시', exact: true })
    await prompt.fill('subagent remote')
    await win.getByRole('button', { name: '지시 보내기', exact: true }).click()
    const record = win.getByLabel('원격 대화 기록', { exact: true })
    await expect(record).toContainText('대화 완료', { timeout: 20_000 })
    const agent = record.locator('details').filter({ has: win.locator('summary', { hasText: /^Agent · 줄 세기 · / }) })
    await expect(agent).toHaveCount(1)
    await expect(agent.locator('summary')).toContainText('✓ 끝남')
    await expect(record).not.toContainText('대화 중지됨')
    await agent.locator('summary').click()
    await expect(agent).toHaveAttribute('open', '')
    await expect(agent).toContainText('1줄이에요')
    await expect(agent).toContainText('Read')
    await captureWindow(app, `${shots}/68-6-remote.png`)
  })
})
