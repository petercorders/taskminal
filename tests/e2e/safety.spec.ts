import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstWindow, seedState, taskJson } from './helpers'

// 17단계 데이터 안전: 백업 · 되돌리기 · 손상 복구 · 비밀값 가리기 (디스크 · 화면)
let userData: string
let app: ElectronApplication
let launched: ElectronApplication | undefined
let win: Page

test.beforeEach(() => {
  userData = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-e2e-')))
  launched = undefined
})
test.afterEach(async () => {
  await launched?.close()
  rmSync(userData, { recursive: true, force: true })
})

async function launch(env: Record<string, string> = {}): Promise<void> {
  app = launched = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: userData, ...env } })
  win = await firstWindow(app)
}
/** ⌥⌘Q — 셸까지 끝내고 페이지가 내려가며 스크롤을 동기로 쓴다 */
async function quit(): Promise<void> {
  const closed = new Promise<void>((resolve) => launched!.once('close', () => resolve()))
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('quit-all')!.click())
  await closed
  launched = undefined
}
const command = (id: string) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0]!.webContents.send('app:command', c), id)
const pane = (id: string) => win.getByTestId(`pane-${id}`)
const screen = (id: string) => pane(id).locator('.xterm-rows')
const row = (name: string) => win.locator(`[data-testid="task-row"][data-task-name="${name}"]`)
async function run(id: string, text: string): Promise<void> {
  await pane(id).click()
  await win.keyboard.type(text)
  await win.keyboard.press('Enter')
}
const backupNames = () => (existsSync(join(userData, 'backups')) ? readdirSync(join(userData, 'backups')).filter((n) => n.startsWith('state-')) : [])
const savedState = () => JSON.parse(readFileSync(join(userData, 'state.json'), 'utf8'))
// 명령 줄에는 키 전체가 없고(셸이 이어 붙임) 출력 줄에만 있다
const KEY_TAIL = 'Q'.repeat(40)
const PRINT_KEY = `printf 'KEYLINE %s\\n' "sk-ant-api03-$(printf 'Q%.0s' {1..40})"`

test('일감 지우기 → 알림 ⌘Z 로 되돌림 · 알림이 지난 뒤엔 설정 › 백업에서 이 일감만 되살리기', async () => {
  seedState(userData, [
    { id: 'a', name: 'A', paneId: 'p1' },
    { id: 'b', name: 'B', paneId: 'p2' },
  ])
  await launch()
  await expect(row('B')).toBeVisible()
  await expect.poll(backupNames).toHaveLength(1) // 시작 백업
  expect(backupNames()[0]).toMatch(/-start\.json$/)

  await row('B').hover()
  await win.getByRole('button', { name: 'B 지우기' }).click()
  await win.getByRole('alertdialog').getByRole('button', { name: '지우기' }).click()
  await expect(row('B')).toHaveCount(0)
  await expect(win.getByTestId('toast')).toContainText('‘B’ 일감을 지웠어요')
  await win.keyboard.press('Meta+z')
  await expect(row('B')).toBeVisible()
  await expect(win.getByTestId('toast')).toHaveCount(0)
  await expect.poll(() => savedState().tasks.map((t: { id: string }) => t.id)).toEqual(['a', 'b'])

  // 다시 지우고 알림은 닫는다 → 설정 › 백업
  await row('B').hover()
  await win.getByRole('button', { name: 'B 지우기' }).click()
  await win.getByRole('alertdialog').getByRole('button', { name: '지우기' }).click()
  await win.getByRole('button', { name: '알림 닫기' }).click()
  await expect.poll(() => savedState().tasks.length).toBe(1)
  await command('backup-restore')
  const preview = win.getByTestId('backup-preview')
  await expect(win.getByTestId('backup-row').first()).toBeVisible()
  await expect(preview.locator('[data-task-name="B"]')).toBeVisible()
  await win.screenshot({ path: 'test-results/safety-backup-list.png' })
  await preview.locator('[data-task-name="B"]').getByTestId('restore-task').click()
  await expect(win.getByTestId('backup-message')).toContainText('‘B’ 일감을 되살렸어요')
  await expect(win.locator('[data-reason="restore"]').first()).toBeVisible() // 되돌리기 전 백업이 목록에
  await win.keyboard.press('Escape')
  await expect(row('B')).toBeVisible()
  await expect(pane('p2')).toBeVisible() // 되살린 일감이 열리고 셸이 뜬다
  await run('p2', 'echo BACK$((1+1))')
  await expect(screen('p2')).toContainText('BACK2')
})

test('깨진 state.json 으로 시작 → 마지막 정상 백업으로 되살리고 안내 · 깨진 파일은 옆에', async () => {
  const good = { version: 1, tasks: [taskJson({ id: 'g', name: '살아남은 일감', paneId: 'pg' })], activeTaskId: 'g', settings: {} }
  mkdirSync(join(userData, 'backups'), { recursive: true })
  writeFileSync(join(userData, 'backups', 'state-20261110T010000000Z-auto.json'), JSON.stringify(good))
  writeFileSync(join(userData, 'backups', 'state-20261111T010000000Z-auto.json'), '{깨진 백업') // 더 새 것이 깨졌으면 건너뛴다
  writeFileSync(join(userData, 'state.json'), '{"version":1,"tasks":[')
  await launch()
  await expect(row('살아남은 일감')).toBeVisible()
  await expect(win.getByTestId('state-notice')).toContainText('백업으로 되살렸어요')
  expect(readdirSync(userData).filter((n) => n.startsWith('state.json.') && n.endsWith('.bak'))).toHaveLength(1)
  expect(savedState().tasks[0].name).toBe('살아남은 일감')
  await win.screenshot({ path: 'test-results/safety-recovered.png' })
})

test('sk-ant 키를 출력한 뒤 스크롤 파일에 원문이 없고 화면은 가린 칸 · 비밀값 아님 · ⌘Z · 복사', async () => {
  seedState(userData, [{ id: 't', name: '키', paneId: 'p1' }])
  await launch()
  await run('p1', PRINT_KEY)
  await expect(screen('p1')).toContainText('KEYLINE sk-ant-api03-')
  // 화면: 가린 칸 · 칩 · 처음 안내
  const mask = pane('p1').locator('.secret-mask[data-kind="Anthropic 키"]').first()
  await expect(mask).toHaveText('🔒 Anthropic 키 · 보기')
  await expect(win.getByTestId('secret-chip')).toHaveText('🔒 1개 가림')
  await expect(win.getByTestId('secret-notice')).toContainText('비밀값 1개를 가렸어요')
  await win.screenshot({ path: 'test-results/safety-mask.png' })
  await win.getByTestId('secret-notice').getByRole('button', { name: '괜찮아요' }).click()

  // 복사: 줄을 끌어 고른 뒤 복사하면 ‹가림›
  const before = await app.evaluate(({ clipboard }) => clipboard.readText())
  try {
    const line = screen('p1').locator('div', { hasText: /^KEYLINE / })
    const box = (await line.boundingBox())!
    await win.mouse.move(box.x + 2, box.y + box.height / 2)
    await win.mouse.down()
    await win.mouse.move(box.x + box.width - 4, box.y + box.height / 2, { steps: 5 })
    await win.mouse.up()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.copy())
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toContain('KEYLINE ‹가림:Anthropic 키›')
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).not.toContain(KEY_TAIL)
  } finally {
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), before)
  }

  // 칸 메뉴 → 비밀값 아님 → 가림이 사라지고 알림 · ⌘Z 로 되돌림
  await mask.click()
  await expect(win.getByTestId('secret-menu')).toBeVisible()
  await win.getByTestId('secret-menu').getByRole('menuitem', { name: /비밀값 아님/ }).click()
  await expect(pane('p1').locator('.secret-mask')).toHaveCount(0)
  await expect(win.getByTestId('toast')).toContainText('이 값을 이제 가리지 않아요')
  await expect.poll(() => (savedState().settings.secretAllow?.length ?? 0)).toBe(1)
  await win.keyboard.press('Meta+z')
  await expect(pane('p1').locator('.secret-mask')).toHaveCount(1)
  await expect.poll(() => (savedState().settings.secretAllow?.length ?? 0)).toBe(0)

  // ⇧⌘H 화면 가리기 끄기 · 켜기
  await pane('p1').click()
  await win.keyboard.press('Shift+Meta+h')
  await expect(pane('p1').locator('.secret-mask')).toHaveCount(0)
  await win.keyboard.press('Shift+Meta+h')
  await expect(pane('p1').locator('.secret-mask')).toHaveCount(1)
  // ⌥⌘→ 로 가린 칸에 포커스 → ↩ 로 열기
  await win.keyboard.press('Alt+Meta+ArrowRight')
  await expect(mask).toBeFocused()
  await win.keyboard.press('Enter')
  await expect(mask).toHaveAttribute('data-open', 'true')
  await win.keyboard.press('Escape')

  await quit()
  const text = readFileSync(join(userData, 'scrollback', 'p1.txt'), 'utf8')
  expect(text).toContain('KEYLINE ‹가림:Anthropic 키›')
  expect(text).not.toContain(KEY_TAIL)
})

test('이미 남은 스크롤 파일은 첫 실행에 가려 다시 쓴다 · 설정 › 개인정보에 정리 결과', async () => {
  seedState(userData, [{ id: 't', name: '옛 파일', paneId: 'p1' }])
  mkdirSync(join(userData, 'scrollback'), { recursive: true, mode: 0o700 })
  writeFileSync(join(userData, 'scrollback', 'p1.txt'), `old ghp_${'a1B2c3D4e5'.repeat(4)}\r\n`, { mode: 0o600 })
  await launch()
  await expect(row('옛 파일')).toBeVisible()
  await expect.poll(() => readFileSync(join(userData, 'scrollback', 'p1.txt'), 'utf8')).toContain('‹가림:GitHub 토큰›')
  await expect(screen('p1')).toContainText('old ‹가림:GitHub 토큰›') // 되살린 화면도 가린 모양
  expect(existsSync(join(userData, 'scrollback-redacted-v1'))).toBe(true)
  await command('privacy')
  await expect(win.getByTestId('redact-status')).toContainText('비밀값 1개 가림')
  await win.screenshot({ path: 'test-results/safety-privacy.png' })
})

test('WebGL · 줄바꿈된 긴 토큰도 줄마다 가린 칸이 제자리에 (스파이크)', async () => {
  seedState(userData, [{ id: 't', name: '긴 토큰', paneId: 'p1' }])
  await launch({ TASKMINAL_RENDERER: 'webgl' })
  await expect(pane('p1')).toHaveAttribute('data-renderer', 'webgl')
  const cols = Number(await pane('p1').getAttribute('data-cols'))
  // 화면 폭보다 긴 키 → 두 줄 이상으로 접힌다
  await pane('p1').click()
  await win.keyboard.type(`printf 'W %s\\n' "sk-ant-api03-$(printf 'Z%.0s' {1..${cols + 20}})"`)
  await win.keyboard.press('Enter')
  const masks = pane('p1').locator('.secret-mask')
  await expect(masks).toHaveCount(2)
  const [a, b] = [(await masks.nth(0).boundingBox())!, (await masks.nth(1).boundingBox())!]
  const host = (await pane('p1').boundingBox())!
  expect(b.y).toBeGreaterThan(a.y) // 다음 줄
  expect(a.x).toBeGreaterThan(host.x) // 'W ' 뒤에서 시작
  expect(b.x).toBeLessThan(a.x) // 둘째 줄은 처음 칸부터
  expect(a.x + a.width).toBeLessThanOrEqual(host.x + host.width + 1)
  await expect(masks.nth(0)).toHaveText('🔒 Anthropic 키 · 보기')
  await win.screenshot({ path: 'test-results/safety-webgl-wrap.png' })
})

test('전체 되돌리기: 남는 pane 은 같은 셸(셸 지킴이) · 백업에 없는 pane 은 끝난다', async () => {
  seedState(userData, [{ id: 'a', name: 'A', paneId: 'p1' }])
  await launch()
  await run('p1', 'echo PID=$$')
  await expect(screen('p1')).toContainText(/PID=\d+/)
  const pid = /PID=(\d+)/.exec((await screen('p1').textContent()) ?? '')![1]
  await expect.poll(backupNames).toHaveLength(1)
  // 지금 모습을 바꾼다: 탭 하나 더 (새 pane) + 글자 크기
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('new-tab')!.click())
  await expect(win.getByTestId('tab')).toHaveCount(2)
  await expect.poll(() => savedState().tasks[0].tabs.length).toBe(2)

  await command('backup-restore')
  await expect(win.getByTestId('backup-diff')).toContainText('바뀐 일감')
  await win.getByTestId('restore-all').click()
  const confirm = win.getByTestId('restore-confirm')
  await expect(confirm).toContainText('터미널 1개가 끝나요')
  await win.keyboard.press('Meta+Backspace')
  await expect(win.getByTestId('backup-message')).toContainText('되돌렸어요')
  await win.keyboard.press('Escape')
  await expect(win.getByTestId('tab')).toHaveCount(1)
  await run('p1', 'echo PID=$$ AGAIN')
  await expect(screen('p1')).toContainText(`PID=${pid} AGAIN`)
})

test('내보내기는 명령 속 키를 가린 파일 · 가져오기 합치기는 없는 일감을 더한다', async () => {
  const t = taskJson({ id: 'a', name: 'A', paneId: 'p1' }) as ReturnType<typeof taskJson> & { panes: Record<string, Record<string, string>> }
  t.panes['p1']!['command'] = `export ANTHROPIC_API_KEY=sk-ant-api03-${KEY_TAIL}`
  writeFileSync(join(userData, 'state.json'), JSON.stringify({ version: 1, tasks: [t], activeTaskId: 'a', settings: { confirmQuit: false } }))
  const out = join(userData, 'export.json')
  const incoming = join(userData, 'incoming.json')
  writeFileSync(incoming, JSON.stringify({ version: 1, tasks: [taskJson({ id: 'c', name: '가져온 일감', paneId: 'pc' })], activeTaskId: 'c', settings: {} }))
  await launch()
  await app.evaluate(({ dialog }, paths) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: paths.out })) as typeof dialog.showSaveDialog
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [paths.incoming] })) as typeof dialog.showOpenDialog
  }, { out, incoming })
  await expect(row('A')).toBeVisible() // 읽기가 끝나기 전 명령은 받지 않는다
  await command('backup-restore')
  await win.getByRole('button', { name: '내보내기…' }).click()
  await expect(win.getByTestId('backup-message')).toContainText('내보냈어요')
  const text = readFileSync(out, 'utf8')
  expect(text).toContain('‹가림:Anthropic 키›')
  expect(text).not.toContain(KEY_TAIL)

  await win.getByRole('button', { name: '가져오기…' }).click()
  await expect(win.getByTestId('import-dialog')).toContainText('가져온 일감')
  await win.getByTestId('import-merge').click()
  await expect(win.getByTestId('backup-message')).toContainText('일감 1개를 더했어요')
  await win.keyboard.press('Escape')
  await expect(row('가져온 일감')).toBeVisible()
  await expect(row('A')).toBeVisible()
  expect(backupNames().some((n) => n.endsWith('-import.json'))).toBe(true)
})
