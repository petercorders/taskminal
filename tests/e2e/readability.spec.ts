import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { firstWindow, seedState, waitLoaded } from './helpers'

// 26단계 D: 가독성을 잰다 — 화면마다 보이는 글자의 크기 · 대비(WCAG) · 줄 간격.
// 기준: 대비 4.5:1(큰 글자 24px · 굵은 18.66px 이상은 3:1) · 글자 12px 이상 · 대화 · 대화상자 본문 14px 이상 · 여러 줄 글은 줄 간격 1.4 이상.
// 끈(disabled) 컨트롤은 WCAG 대로 대비에서 뺀다. 터미널 글자(xterm)는 글꼴 설정이 따로라 뺀다.
// 측정 결과는 test-results/readability/<화면>.json · .png 에 남는다(전후 비교용).
const FAKE_CLAUDE = resolve(__dirname, '../fixtures/fake-claude.mjs')
const OUT = 'test-results/readability'
let userData: string
let app: ElectronApplication | undefined
let win: Page

interface Sample {
  text: string
  size: number
  weight: number
  lineHeight: number
  lines: number
  contrast: number
  large: boolean
  body: boolean
  where: string
}

/** 화면의 보이는 글자를 모두 잰다 — 창 안에서 돈다 */
async function measure(page: Page): Promise<Sample[]> {
  return page.evaluate(() => {
    const parse = (c: string): [number, number, number, number] => {
      const m = c.match(/rgba?\(([^)]+)\)/)
      if (!m) return [0, 0, 0, 0]
      const p = m[1]!.split(/[ ,/]+/).filter(Boolean).map(Number)
      return [p[0]!, p[1]!, p[2]!, p[3] ?? 1]
    }
    const over = (top: number[], under: number[]) => {
      const a = top[3]!
      return [0, 1, 2].map((i) => top[i]! * a + under[i]! * (1 - a)).concat(1)
    }
    const lum = (c: number[]) => {
      const f = (v: number) => {
        const s = v / 255
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * f(c[0]!) + 0.7152 * f(c[1]!) + 0.0722 * f(c[2]!)
    }
    // 바탕: 위로 올라가며 칠해진 바탕을 쌓는다(반투명은 섞는다)
    const background = (el: Element): number[] => {
      const layers: number[][] = []
      for (let e: Element | null = el; e; e = e.parentElement) {
        const c = parse(getComputedStyle(e).backgroundColor)
        if (c[3] > 0) layers.push(c)
        if (c[3] >= 1) break
      }
      let bg = [0, 0, 0, 1]
      for (const l of layers.reverse()) bg = over(l, bg)
      return bg
    }
    const out: Sample[] = []
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    const seen = new Set<Element>()
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement
      if (!el || seen.has(el) || !n.textContent!.trim()) continue
      seen.add(el)
      if (el.closest('.xterm, [aria-hidden="true"], script, style, noscript')) continue
      if (el.closest('button:disabled, input:disabled, select:disabled, [aria-disabled="true"]')) continue
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      if (r.width < 1 || r.height < 1 || cs.visibility !== 'visible' || Number(cs.opacity) < 0.05) continue
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue
      // 조상의 opacity 도 글자 색에 곱한다
      let op = 1
      for (let e: Element | null = el; e; e = e.parentElement) op *= Number(getComputedStyle(e).opacity)
      const bg = background(el)
      const fg0 = parse(cs.color)
      const fg = over([fg0[0], fg0[1], fg0[2], fg0[3] * op], bg)
      const l1 = lum(fg)
      const l2 = lum(bg)
      const size = parseFloat(cs.fontSize)
      const weight = Number(cs.fontWeight) || 400
      const lh = cs.lineHeight === 'normal' ? 1.2 : parseFloat(cs.lineHeight) / size
      // 줄 수 = 글자 범위의 줄 상자(패딩 있는 단추를 여러 줄로 세지 않게)
      const range = document.createRange()
      range.selectNodeContents(n)
      const lines = new Set(Array.from(range.getClientRects()).filter((q) => q.width > 0).map((q) => Math.round(q.top))).size
      const where = el.closest('[data-testid]')?.getAttribute('data-testid') ?? el.tagName.toLowerCase()
      const body = !!el.closest('[data-testid="chat-pane"] [data-kind="text"], [data-testid="chat-user-text"], [role="dialog"] p, .modal p')
      out.push({
        text: n.textContent!.trim().slice(0, 40),
        size,
        weight,
        lineHeight: Math.round(lh * 100) / 100,
        lines,
        contrast: Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100,
        large: size >= 24 || (size >= 18.66 && weight >= 700),
        body,
        where,
      })
    }
    return out
  })
}

function problems(samples: Sample[]) {
  return samples.flatMap((s) => {
    const p: string[] = []
    if (s.contrast < (s.large ? 3 : 4.5)) p.push(`대비 ${s.contrast}`)
    if (s.size < 12) p.push(`글자 ${s.size}px`)
    if (s.body && s.size < 14) p.push(`본문 ${s.size}px`)
    if (s.lines >= 2 && s.lineHeight < 1.4) p.push(`줄 간격 ${s.lineHeight}`)
    return p.length ? [`${s.where} «${s.text}» ${p.join(' · ')}`] : []
  })
}

async function record(name: string) {
  mkdirSync(OUT, { recursive: true })
  await win.waitForTimeout(300)
  const samples = await measure(win)
  const bad = problems(samples)
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify({ count: samples.length, problems: bad, samples }, null, 1))
  await win.screenshot({ path: join(OUT, `${name}.png`) })
  return bad
}

async function launch(tasks: Parameters<typeof seedState>[1]) {
  seedState(userData, tasks)
  app = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: userData, TASKMINAL_CLAUDE_BIN: FAKE_CLAUDE } })
  win = await firstWindow(app)
  await win.setViewportSize({ width: 1280, height: 800 }).catch(() => {})
  await waitLoaded(win)
}
async function command(c: string) {
  await app!.evaluate(({ BrowserWindow }, cmd) => BrowserWindow.getAllWindows()[0]!.webContents.send('app:command', cmd), c)
}

test.describe.configure({ timeout: 120_000 })
test.beforeEach(() => {
  userData = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-e2e-')))
})
test.afterEach(async () => {
  await app?.close()
  app = undefined
  rmSync(userData, { recursive: true, force: true })
})

test('가독성: 사이드바 · 터미널 · 대화 · 팔레트 · 설정 · 새 일감 — 대비 · 크기 · 줄 간격 기준', async () => {
  await launch([
    { id: 'task-a', name: '결제 API 고치기', paneId: 'pane-a', cwd: userData },
    { id: 'task-b', name: '랜딩 페이지', paneId: 'pane-b', cwd: userData, statusId: 'wait' },
    { id: 'task-c', name: '지난주 정리', paneId: 'pane-c', cwd: userData, statusId: 'done' },
  ])
  const bad: string[] = []
  bad.push(...(await record('main')).map((p) => `main: ${p}`))

  await command('chat-new')
  const chat = win.locator('[data-testid="task-view"][aria-hidden="false"] [data-testid="chat-pane"]')
  await expect(chat.getByTestId('chat-empty')).toBeVisible()
  bad.push(...(await record('chat-empty')).map((p) => `chat-empty: ${p}`))
  await chat.getByTestId('chat-input').fill('안녕')
  await chat.getByTestId('chat-input').press('Enter')
  await expect(chat.getByTestId('chat-status')).toContainText('끝남')
  bad.push(...(await record('chat')).map((p) => `chat: ${p}`))

  await command('palette')
  await expect(win.getByTestId('palette')).toBeVisible()
  bad.push(...(await record('palette')).map((p) => `palette: ${p}`))
  await win.keyboard.press('Escape')

  await command('settings')
  await expect(win.getByRole('dialog').first()).toBeVisible()
  bad.push(...(await record('settings')).map((p) => `settings: ${p}`))
  await win.keyboard.press('Escape')

  await command('new-task')
  await expect(win.getByRole('dialog').first()).toBeVisible()
  bad.push(...(await record('new-task')).map((p) => `new-task: ${p}`))
  await win.keyboard.press('Escape')

  expect(bad, bad.join('\n')).toEqual([])
})

test('가독성: 일감이 없는 첫 화면', async () => {
  await launch([])
  const bad = (await record('empty')).map((p) => `empty: ${p}`)
  expect(bad, bad.join('\n')).toEqual([])
})
