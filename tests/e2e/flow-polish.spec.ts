import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
  writeFileSync(join(dir, 'long.txt'), Array.from({ length: 40 }, (_, i) => `줄 ${i + 1}`).join('\n'))
  seedState(dir, [{ id: 't', name: '흐름 일감', paneId: 'p', cwd: dir }])
  mkdirSync(join(dir, 'workflows'))
  writeFileSync(join(dir, 'workflows/journal.json'), JSON.stringify({ templates: [workflow], runs: [] }))
  app = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: dir, TASKMINAL_CLAUDE_BIN: resolve('tests/fixtures/fake-claude.mjs') } })
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
