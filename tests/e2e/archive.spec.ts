import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstWindow, runCli, seedState, taskJson, waitLoaded } from './helpers'

// 25단계 보관함 · 주간 정리
let userData: string
let app: ElectronApplication
let win: Page

test.beforeEach(() => {
  userData = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-e2e-')))
})
test.afterEach(async () => {
  await app?.close()
  rmSync(userData, { recursive: true, force: true, maxRetries: 5 })
})

async function launch(): Promise<void> {
  app = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: userData } })
  win = await firstWindow(app)
  await waitLoaded(win)
}
const command = (id: string) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0]!.webContents.send('app:command', c), id)
const pane = (id: string) => win.getByTestId(`pane-${id}`)
const screen = (id: string) => pane(id).locator('.xterm-rows')
const row = (name: string) => win.locator(`[data-testid="task-row"][data-task-name="${name}"]`)
const savedState = () => JSON.parse(readFileSync(join(userData, 'state.json'), 'utf8'))
async function run(id: string, text: string): Promise<void> {
  await pane(id).click()
  await win.keyboard.type(text)
  await win.keyboard.press('Enter')
}
async function pidOf(id: string, tag: string): Promise<number> {
  await run(id, `echo ${tag}_PID=$$`)
  let pid = 0
  await expect.poll(async () => ((pid = Number(/_PID=(\d+)/.exec((await screen(id).textContent()) ?? '')?.[1] ?? 0)), pid), { timeout: 15_000 }).toBeGreaterThan(0)
  return pid
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('보관 → 셸이 끝나고 사이드바에서 빠짐 · 보관함에서 되살리면 탭 · 메모 그대로 새 셸', async () => {
  const a = { ...taskJson({ id: 'a', name: 'A', paneId: 'pa', cwd: '/tmp' }), notes: [{ id: 'n1', text: '배포 메모', at: 1 }] }
  writeFileSync(join(userData, 'state.json'), JSON.stringify({ version: 1, tasks: [a, taskJson({ id: 'b', name: 'B', paneId: 'pb' })], activeTaskId: 'a', settings: { confirmQuit: false } }))
  await launch()
  const pid = await pidOf('pa', 'A')
  await command('archive')
  await expect(row('A')).toHaveCount(0)
  await expect(win.getByTestId('toast')).toContainText('‘A’ 을 보관했어요 · 스크롤은 지웠어요')
  await expect.poll(() => alive(pid), { timeout: 10_000 }).toBe(false)
  await expect(pane('pa')).toHaveCount(0)
  await expect(win.getByTestId('archive-open')).toContainText('보관함 1')
  await expect.poll(() => savedState().tasks.find((t: { id: string }) => t.id === 'a').archivedAt).toBeGreaterThan(0)
  // B 가 활성
  await expect(win.locator('[data-testid="task-view"][data-task-name="B"]')).toBeVisible()

  await win.getByTestId('archive-open').click()
  const panel = win.getByTestId('archive-panel')
  await expect(panel.getByTestId('archive-row')).toHaveCount(1)
  await expect(panel.getByTestId('archive-row')).toContainText('메모 1')
  await panel.getByLabel('보관함에서 찾기').fill('배포')
  await expect(panel.getByTestId('archive-row')).toHaveCount(1)
  await panel.getByLabel('보관함에서 찾기').fill('없는말')
  await expect(panel.getByTestId('archive-row')).toHaveCount(0)
  await panel.getByLabel('보관함에서 찾기').fill('')
  await win.screenshot({ path: 'test-results/archive-panel.png' })
  await panel.getByRole('button', { name: '되살리기' }).click()
  await expect(row('A')).toBeVisible()
  await expect(win.getByTestId('archive-panel')).toHaveCount(0)
  // 터미널 pane 은 새 id 로 새 셸 — 그 폴더에서
  const view = win.locator('[data-testid="task-view"][data-task-name="A"]')
  await expect(view.locator('.terminal-pane')).toHaveCount(1)
  const st = savedState().tasks.find((t: { id: string }) => t.id === 'a')
  await expect.poll(() => savedState().tasks.find((t: { id: string }) => t.id === 'a').archivedAt).toBeUndefined()
  expect(st.notes[0].text).toBe('배포 메모')
  const newPane = Object.keys(savedState().tasks.find((t: { id: string }) => t.id === 'a').panes)[0]!
  expect(newPane).not.toBe('pa')
  await run(newPane, 'echo BACK_$((2+3)) $(pwd)')
  await expect(screen(newPane)).toContainText(/BACK_5 \/(private\/)?tmp/, { timeout: 15_000 })
})

test('돌고 있는 명령이 있으면 한 번 묻는다 — 취소면 그대로, 끄고 보관 · 알림 ⌘Z 로 되돌림', async () => {
  seedState(userData, [
    { id: 'a', name: 'A', paneId: 'pa' },
    { id: 'b', name: 'B', paneId: 'pb' },
  ])
  await launch()
  await run('pa', 'sleep 600')
  // 셸 통합이 '실행 중' 을 알린 뒤에 보관
  await expect(win.locator('[data-testid="pane-slot"][data-pane-id="pa"]').getByTestId('pane-head')).toHaveAttribute('data-activity', 'running', { timeout: 15_000 })
  await command('archive')
  await expect(win.getByRole('alertdialog')).toBeVisible()
  const dialog = win.getByRole('alertdialog')
  await expect(dialog).toContainText('‘sleep 600’ 가 아직 돌고 있어요')
  await expect(dialog).toContainText('터미널 1개 중 1개에서 돌고 있어요')
  await win.screenshot({ path: 'test-results/archive-confirm.png' })
  await dialog.getByRole('button', { name: '취소' }).click()
  await expect(row('A')).toBeVisible()
  await command('archive')
  await win.getByRole('alertdialog').getByRole('button', { name: '끄고 보관' }).click()
  await expect(row('A')).toHaveCount(0)
  await win.keyboard.press('Meta+z')
  await expect(row('A')).toBeVisible()
  await expect.poll(() => savedState().tasks.find((t: { id: string }) => t.id === 'a').archivedAt).toBeUndefined()
})

test('확인 창이 열린 사이 그 일감이 지워지면 확인 창이 닫히고 아무것도 보관하지 않는다', async () => {
  seedState(userData, [
    { id: 'a', name: 'A', paneId: 'pa' },
    { id: 'b', name: 'B', paneId: 'pb' },
  ])
  await launch()
  await run('pa', 'sleep 600')
  // 셸 통합이 '실행 중' 을 알린 뒤에 보관
  await expect(win.locator('[data-testid="pane-slot"][data-pane-id="pa"]').getByTestId('pane-head')).toHaveAttribute('data-activity', 'running', { timeout: 15_000 })
  await command('archive')
  await expect(win.getByRole('alertdialog')).toBeVisible()
  const r = await runCli(userData, 'task', 'remove', 'A', '--force')
  expect(r.code).toBe(0)
  // 지우기가 열린 대화상자를 닫는다 — 남은 확인 창으로 지운 일감을 보관하지 않는다
  await expect(win.getByRole('alertdialog')).toHaveCount(0)
  await expect.poll(() => savedState().tasks.map((t: { id: string; archivedAt?: number }) => [t.id, t.archivedAt ?? null])).toEqual([['b', null]])
})

test('완료한 지 7일 넘은 일감은 완료 칸 머리에 보관할까요? n — 누르면 보관', async () => {
  seedState(userData, [
    { id: 'a', name: 'A', paneId: 'pa' },
    { id: 'd', name: 'D', paneId: 'pd', statusId: 'done' },
  ])
  await launch()
  const chip = win.getByTestId('archive-suggest')
  await expect(chip).toHaveText('보관할까요? 1')
  await win.screenshot({ path: 'test-results/archive-suggest.png' })
  await chip.click()
  await expect(row('D')).toHaveCount(0)
  await expect(chip).toHaveCount(0)
})

test('지운 일감은 보관함 › 최근 지운 것에 남고 되살릴 수 있다 · ⌘P 에서 보관 일감 이름으로 되살리기', async () => {
  seedState(userData, [
    { id: 'a', name: 'A', paneId: 'pa' },
    { id: 'b', name: 'Bravo', paneId: 'pb' },
    { id: 'c', name: 'Charlie', paneId: 'pc' },
  ])
  await launch()
  await row('Bravo').hover()
  await win.getByRole('button', { name: 'Bravo 지우기' }).click()
  await win.getByRole('alertdialog').getByRole('button', { name: '지우기' }).click()
  await win.getByRole('button', { name: '알림 닫기' }).click()
  await expect.poll(() => savedState().tasks.length).toBe(2)
  await command('archive-open')
  const panel = win.getByTestId('archive-panel')
  await panel.getByTestId('archive-deleted-tab').click()
  await expect(panel.getByTestId('deleted-row')).toHaveCount(1)
  await expect(panel.getByTestId('deleted-row')).toContainText('Bravo')
  await expect(panel.getByTestId('deleted-row')).toContainText(/\d+일 남음/)
  await win.screenshot({ path: 'test-results/archive-deleted.png' })
  await panel.getByRole('button', { name: '되살리기' }).click()
  await expect(row('Bravo')).toBeVisible()

  // ⌘P: 보관 일감은 기본 목록에 없고, 이름을 치면 나온다
  await win.locator('[data-testid="task-view"][data-task-name="Bravo"]').waitFor()
  await row('Charlie').click()
  await command('archive')
  await expect(row('Charlie')).toHaveCount(0)
  await command('palette')
  const palette = win.getByRole('dialog', { name: '명령 팔레트' })
  await expect(palette.locator('[data-kind="task"]').filter({ hasText: 'Charlie' })).toHaveCount(0)
  await win.keyboard.type('Charl')
  const hit = palette.locator('[data-kind="task"]').filter({ hasText: 'Charlie' })
  await expect(hit).toContainText('🗄 보관함')
  await hit.click()
  await expect(row('Charlie')).toBeVisible()
})

test('최근 지운 것도 찾기로 거르고 ↩ 는 거른 줄을 · 글 있는 찾기 칸의 ⌘⌫ 는 지우기가 아님 · 보관한 채 지운 일감은 보이게 되살림 (리뷰)', async () => {
  seedState(userData, [
    { id: 'a', name: 'A', paneId: 'pa' },
    { id: 'b', name: 'Bravo', paneId: 'pb' },
    { id: 'd', name: 'Delta', paneId: 'pd' },
  ])
  await launch()
  await row('Delta').click()
  await command('archive')
  await expect(row('Delta')).toHaveCount(0)
  await command('archive-open')
  const panel = win.getByTestId('archive-panel')
  await win.keyboard.type('Del')
  await win.keyboard.press('Meta+Backspace')
  await expect(win.getByRole('alertdialog')).toHaveCount(0)
  await expect(panel.getByTestId('archive-row')).toHaveCount(1)
  // 보관한 채 지우기
  await panel.getByRole('button', { name: 'Delta 지우기' }).click()
  await win.getByRole('alertdialog').getByRole('button', { name: '지우기' }).click()
  await win.getByRole('button', { name: '알림 닫기' }).click()
  await row('Bravo').hover()
  await win.getByRole('button', { name: 'Bravo 지우기' }).click()
  await win.getByRole('alertdialog').getByRole('button', { name: '지우기' }).click()
  await win.getByRole('button', { name: '알림 닫기' }).click()
  await expect.poll(() => savedState().tasks.length).toBe(1)

  await command('archive-open')
  await panel.getByTestId('archive-deleted-tab').click()
  await expect(panel.getByTestId('deleted-row')).toHaveCount(2)
  await panel.getByLabel('보관함에서 찾기').fill('Del')
  await expect(panel.getByTestId('deleted-row')).toHaveCount(1)
  await expect(panel.getByTestId('deleted-row')).toHaveAttribute('data-task-name', 'Delta')
  await win.keyboard.press('Enter')
  await expect(row('Delta')).toBeVisible()
  await expect(win.locator('[data-testid="task-view"][data-task-name="Delta"]')).toHaveAttribute('aria-hidden', 'false')
  await expect(row('Bravo')).toHaveCount(0)
  await expect.poll(() => savedState().tasks.find((t: { id: string }) => t.id === 'd')?.archivedAt).toBeUndefined()
})

test('주간 정리: 이번 주 명령 기록 → 칸 · 표 · 실패 한 줄 · 마크다운으로 복사', async () => {
  seedState(userData, [
    { id: 'a', name: 'Alpha', paneId: 'pa' },
    { id: 'b', name: 'Beta', paneId: 'pb' },
  ])
  mkdirSync(join(userData, 'history'), { recursive: true, mode: 0o700 })
  const now = Date.now()
  const line = (id: string, taskId: string, ms: number, code: number) => JSON.stringify({ id, taskId, paneId: 'pa', cmd: 'make', cwd: '/', startedAt: now - 60_000, endedAt: now - 60_000 + ms, code, tail: [] })
  writeFileSync(join(userData, 'history', 'a.jsonl'), [line('h1', 'a', 3_600_000, 0), line('h2', 'a', 60_000, 2)].join('\n') + '\n', { mode: 0o600 })
  writeFileSync(join(userData, 'history', 'b.jsonl'), line('h3', 'b', 60_000, 0) + '\n', { mode: 0o600 })
  await launch()
  await win.getByTestId('weekly-open').click()
  const panel = win.getByTestId('weekly-panel')
  await expect(panel.getByTestId('weekly-label')).toContainText('(이번 주)')
  await expect(panel.locator('[data-kpi="다룬 일감"] b')).toHaveText('2')
  await expect(panel.locator('[data-kpi="명령"] b')).toHaveText('3')
  await expect(panel.locator('[data-kpi="실패"] b')).toHaveText('1')
  await expect(panel).toContainText('실패 1번 중 1번이 Alpha에서 났어요')
  await expect(panel.getByTestId('weekly-table')).toContainText('Alpha')
  await win.screenshot({ path: 'test-results/weekly.png' })
  await panel.getByTestId('weekly-copy').click()
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toContain('| Alpha | 1h | 2 | 1 |')
  // 앞 주는 비었다
  await panel.getByRole('button', { name: '앞 주' }).click()
  await expect(panel.locator('[data-kpi="명령"] b')).toHaveText('0')
})
