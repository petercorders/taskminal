import { expect, type ElectronApplication, type Page, type Locator } from '@playwright/test'
import { execFile } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// e2e 가 미리 깔아 두는 저장 파일. 앱이 쓰는 모양(AppState version 1)과 같아야 normalizeState 를 통과한다.

export interface SeedTask {
  id: string
  name: string
  paneId: string
  cwd?: string
  groupId?: string | null
  color?: string | null
  /** 기본 'doing' (21b 흐름 보기 시험이 칸을 나눈다) */
  statusId?: string
  /** 빠른 명령 (20단계) */
  quickCommands?: Array<Record<string, unknown>>
}

export function taskJson(t: SeedTask) {
  const cwd = t.cwd ?? '~'
  return {
    id: t.id,
    name: t.name,
    cwd,
    statusId: t.statusId ?? 'doing',
    groupId: t.groupId ?? null,
    color: t.color ?? null,
    tabs: [{ id: `${t.id}-tab`, layout: { type: 'pane', paneId: t.paneId }, activePaneId: t.paneId }],
    activeTabId: `${t.id}-tab`,
    panes: { [t.paneId]: { id: t.paneId, cwd } },
    createdAt: 1,
    ...(t.quickCommands ? { quickCommands: t.quickCommands } : {}),
  }
}

const defaultSettings = (groups: Array<{ id: string; name: string }>) => ({
  statuses: [
    { id: 'doing', name: '진행 중', color: '#79b8ff' },
    { id: 'wait', name: '대기', color: '#e5b567' },
    { id: 'done', name: '완료', color: '#8b9097' },
  ],
  groups,
  templates: [{ id: 'tpl-basic', name: '기본', tabs: [{ layout: { pane: {} } }] }],
  fontSize: 13,
  shell: null,
  // 실행 중인 명령이 있으면 끄기 전에 묻는 설정(기본 켜짐)은 시험 정리(app.close)를 대화상자에서 멈추게 한다 → 그것을 보는 시험만 켠다
  confirmQuit: false,
  // 26단계부터 새 일감 기본은 대화 — 그 전에 쓴 시험은 '새 일감 = 셸' 을 전제한다. 대화 시작은 chat-first.spec 이 따로 본다
  newTaskStart: 'terminal',
})

export function seedState(userData: string, tasks: SeedTask[], groups: Array<{ id: string; name: string }> = [], settings: Record<string, unknown> = {}): void {
  const state = {
    version: 1,
    tasks: tasks.map(taskJson),
    activeTaskId: tasks[0]?.id ?? null,
    settings: { ...defaultSettings(groups), ...settings },
  }
  writeFileSync(join(userData, 'state.json'), JSON.stringify(state))
}

/**
 * app.firstWindow() 대신 — 창이 안 뜨면 그때의 창 목록 · main 출력을 오류에 담는다.
 * 전체 e2e 에서 가끔 창이 안 뜨는 원인을 찾으려고 둔다(2026-11-10: 7 · 9단계 전체 실행에서 한 건씩, 따로 25번 띄우면 0건).
 */
export async function firstWindow(app: ElectronApplication): Promise<Page> {
  let out = ''
  app.process().stderr?.on('data', (d) => (out += String(d)))
  app.process().stdout?.on('data', (d) => (out += String(d)))
  try {
    return await app.firstWindow({ timeout: 20_000 })
  } catch (error) {
    const windows = await app
      .evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((w) => ({ visible: w.isVisible(), url: w.webContents.getURL(), loading: w.webContents.isLoading(), crashed: w.webContents.isCrashed() })),
      )
      .catch((e: unknown) => `main 응답 없음: ${String(e)}`)
    const report = `창이 뜨지 않음 (pid ${app.process().pid}) 창=${JSON.stringify(windows)} 출력=${out.slice(-1500)} 원래 오류=${String(error)}`
    // Playwright 가 다음 실행 때 지우는 outputDir(test-results/playwright) 밖에 쌓아 둔다 — 다시 돌리다 진단을 잃지 않게(2026-11-10 11단계에서 한 번 잃음)
    mkdirSync('test-results/launch-hangs', { recursive: true })
    appendFileSync('test-results/launch-hangs/log.txt', `${new Date().toISOString()} ${report}\n`)
    throw new Error(report)
  }
}

/**
 * 상태 읽기가 끝난 화면까지 기다린다 — 사이드바는 읽는 중에도 그려지고, 그동안 온 명령(메뉴 · app:command)은 버린다
 * (App runCommand 의 loading 막음). 창이 뜨자마자 명령을 보내는 시험은 이것부터 (18단계 회고: 메뉴 시험 4건이 이 경합으로 실패).
 */
export async function waitLoaded(win: Page): Promise<void> {
  await expect(win.locator('[data-testid="task-view"], [data-testid="empty-view"], [data-testid="first-run"]').first()).toBeVisible()
}

/**
 * 24단계 `taskminal` 명령을 앱 밖 셸에서 부른 것처럼 — 저장소의 resources/bin/taskminal 을 그대로(PATH 에 넣지 않는다).
 * 이 시험을 돌리는 환경의 TASKMINAL_* · ELECTRON_RUN_AS_NODE 는 빼고 시험 userData 만 준다
 */
export function runCli(userData: string, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('TASKMINAL_') && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v
  env['TASKMINAL_USER_DATA'] = userData
  return new Promise((done) => {
    execFile(resolve(__dirname, '../../resources/bin/taskminal'), args, { env, timeout: 60_000 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : -1) : 0
      done({ code, out: String(stdout), err: String(stderr) })
    })
  })
}

/** Playwright screenshots crop Electron zoomed windows; capture the native viewport for visual review. */
export async function captureWindow(app: ElectronApplication, path: string): Promise<void> {
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0]!.webContents
    await contents.executeJavaScript(`new Promise(resolve => {
      const timer = setTimeout(resolve, 300)
      requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve() }))
    })`)
    return (await contents.capturePage()).toPNG().toString('base64')
  })
  writeFileSync(path, Buffer.from(png, 'base64'))
}

export interface TextProblem {
  /** 문제가 된 글자(앞 40자) */
  text: string
  /** '상자 밖: <잘라 내는 조상>' · '덮임: <그 자리에 잡힌 요소>' */
  reason: string
}

/**
 * 대상 안 글자가 사용자 눈에 실제로 보이는가 — 문제 목록(비면 통과). `expect(await visibleTextProblems(x)).toEqual([])`.
 * 상자 경계 단정은 PR #24(70-5)에서 목록 fieldset 이 23px 로 눌려 줄을 상자 밖(단추 밑)에 그리는데도 통과했다 —
 * 그래서 상자가 아니라 글자 줄(Range client rect)을 잰다. 글자 노드의 줄마다:
 *   1. 스크롤로 보이는 자리에 옮긴다 — 안쪽 스크롤 상자부터 바깥 · 창까지, 상자의 scroll-padding 을 지켜서(sticky 머리).
 *      스크롤해야 보이는 글자는 문제로 세지 않는다.
 *   2. 줄이 잘라 내는 조상(overflow 가 visible 아닌 것, 축마다) · 창의 안쪽 상자 안에 있는가 — 아니면 '상자 밖'
 *      (옮겨도 못 들어오는 것: 상자보다 큰 줄 · 상자 밖에 그려진 줄 · 말줄임으로 잘린 글자)
 *   3. 줄 가운데의 elementFromPoint 가 그 글자를 담은 요소(대상 안)인가 — 아니면 '덮임'
 * 세지 않는 것: 공백뿐인 글자 · visibility 가 visible 아닌 글자 · 상자 없는 글자(display:none) · 1px 미만 줄.
 * '덮임' 은 pointer-events:none 인 글자에서 보지 않는다(elementFromPoint 가 그 글자를 지나친다) — '상자 밖' 은 본다.
 * 한계: sticky 머리가 scroll-padding 없이 줄을 덮으면 '덮임' 오탐이 날 수 있다(그때는 그 상자에 scroll-padding 을 둔다).
 * fieldset 의 legend 는 fieldset 테두리 위에 그려지고 그 overflow 에 잘리지 않으므로 그 fieldset 을 잘라 내는 조상으로 보지 않는다.
 * 재는 동안 바꾼 스크롤 위치는 끝나면 되돌린다. 허용 오차 1px.
 */
export async function visibleTextProblems(target: Locator): Promise<TextProblem[]> {
  return target.evaluate((root) => {
    const TOL = 1
    type Box = { left: number; top: number; right: number; bottom: number }
    const name = (e: Element | null) => (e ? `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ''}${Array.from(e.classList).map((c) => `.${c}`).join('')}` : '없음')
    const inner = (e: Element): Box => {
      const r = e.getBoundingClientRect()
      const left = r.left + e.clientLeft, top = r.top + e.clientTop
      return { left, top, right: left + e.clientWidth, bottom: top + e.clientHeight }
    }
    const doc = document.documentElement
    const viewport = (): Box => ({ left: 0, top: 0, right: doc.clientWidth, bottom: doc.clientHeight })
    /** 글자 요소에서 위로, 잘라 내는 조상(안쪽부터) — 축마다 자르는지 · 스크롤되는지 */
    const clippers = (el: Element) => {
      const out: Array<{ e: Element; x: boolean; y: boolean; sx: boolean; sy: boolean }> = []
      for (let e: Element | null = el; e && e !== doc; e = e.parentElement) {
        const s = getComputedStyle(e)
        if (e.tagName === 'FIELDSET' && el.closest('legend')?.parentElement === e) continue
        const scrolls = (v: string) => v === 'auto' || v === 'scroll'
        if (s.overflowX !== 'visible' || s.overflowY !== 'visible') out.push({ e, x: s.overflowX !== 'visible', y: s.overflowY !== 'visible', sx: scrolls(s.overflowX), sy: scrolls(s.overflowY) })
      }
      return out
    }
    const saved = new Map<Element, [number, number]>()
    const scrollBy = (e: Element, dx: number, dy: number) => {
      if (!saved.has(e)) saved.set(e, [e.scrollLeft, e.scrollTop])
      e.scrollLeft += dx
      e.scrollTop += dy
    }
    /** 줄 r 을 상자 b 안으로 — 넘친 쪽만큼 스크롤(앞쪽 우선) */
    const delta = (lo: number, hi: number, blo: number, bhi: number) => (lo < blo ? lo - blo : hi > bhi ? Math.min(hi - bhi, lo - blo) : 0)
    const problems: Array<{ text: string; reason: string }> = []
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement
      const text = (n.textContent ?? '').trim()
      if (!el || !text || getComputedStyle(el).visibility !== 'visible') continue
      const range = document.createRange()
      range.selectNodeContents(n)
      const clips = clippers(el)
      const lines = range.getClientRects().length
      for (let i = 0; i < lines; i++) {
        const line = () => range.getClientRects()[i]
        if (!line() || line()!.width < 1 || line()!.height < 1) continue
        // 1. 보이는 자리로 — 안쪽 스크롤 상자부터 바깥으로, 마지막에 창
        for (const c of clips) {
          // scrollIntoView 처럼 scroll-padding 을 지킨다 — sticky 머리가 있는 상자는 그만큼 비워 두고 옮긴다(안 그러면 머리 밑에 놓여 '덮임')
          const r = line()!, b = inner(c.e), s = getComputedStyle(c.e), pad = (v: string) => parseFloat(v) || 0
          const top = b.top + pad(s.scrollPaddingTop), bottom = b.bottom - pad(s.scrollPaddingBottom)
          const left = b.left + pad(s.scrollPaddingLeft), right = b.right - pad(s.scrollPaddingRight)
          scrollBy(c.e, c.sx ? delta(r.left, r.right, left, right) : 0, c.sy ? delta(r.top, r.bottom, top, bottom) : 0)
        }
        const se = document.scrollingElement
        if (se) {
          const r = line()!, v = viewport()
          scrollBy(se, delta(r.left, r.right, v.left, v.right), delta(r.top, r.bottom, v.top, v.bottom))
        }
        // 2. 잘라 내는 조상 · 창 안인가
        const r = line()!
        const label = `${text.slice(0, 40)}${lines > 1 ? ` (${i + 1}/${lines}줄)` : ''}`
        const outside = [...clips.map((c) => ({ ...c, b: inner(c.e) })), { e: null, x: true, y: true, b: viewport() }].find(
          (c) => (c.x && (r.left < c.b.left - TOL || r.right > c.b.right + TOL)) || (c.y && (r.top < c.b.top - TOL || r.bottom > c.b.bottom + TOL)),
        )
        if (outside) {
          problems.push({ text: label, reason: `상자 밖: ${outside.e ? name(outside.e) : '창'} ${JSON.stringify({ line: [r.left, r.top, r.right, r.bottom].map(Math.round), box: [outside.b.left, outside.b.top, outside.b.right, outside.b.bottom].map(Math.round) })}` })
          continue
        }
        // 3. 그 자리에서 보이는 것이 이 글자인가 — pointer-events:none 인 글자는 hit test 가 지나쳐 뒤 요소를 돌려주므로 판정하지 않는다(오탐)
        if (getComputedStyle(n.parentElement!).pointerEvents === 'none') continue
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        if (!hit || !root.contains(hit) || !hit.contains(n)) problems.push({ text: label, reason: `덮임: ${name(hit)}` })
      }
    }
    for (const [e, [x, y]] of Array.from(saved).reverse()) {
      e.scrollLeft = x
      e.scrollTop = y
    }
    return problems
  })
}

/** Use the visible settings navigation at the current viewport/zoom. */
export async function selectSettingsSection(settings: Locator, title: string): Promise<void> {
  // Electron's native zoom can reach the renderer after a dialog opens.
  // Re-evaluate the visible mode if that transition hides the chosen control.
  await expect(async()=>{
    const compact = settings.getByRole('combobox', { name: '설정 칸 선택', exact: true })
    if (await compact.isVisible()) await compact.selectOption({ label: title }, { timeout: 750 })
    else await settings.getByRole('navigation').getByRole('button', { name: title, exact: true }).click({ timeout: 750 })
  }).toPass({ timeout: 5000, intervals: [50,100,250] })
}

/** Only for a freshly-created test server data directory: stop its private PTY guardian. */
export async function stopRemoteTerminalHost(serverData: string): Promise<void> {
  const { createHash } = await import('node:crypto')
  const { tmpdir } = await import('node:os')
  const { socketPath, PTYHOST_PROTOCOL } = await import('../../src/shared/ptyhost')
  const { oneShot } = await import('../../src/main/ptyhost/client')
  const socket = socketPath(join(serverData, 'terminal-host'), PTYHOST_PROTOCOL, tmpdir(), s => createHash('sha1').update(s).digest('hex'), process.platform)
  await oneShot(socket, [{ op: 'hello', version: PTYHOST_PROTOCOL }, { op: 'shutdown' }])
}
