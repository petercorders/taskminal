import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstWindow, seedState, waitLoaded } from './helpers'

// 19단계: 명령 기록 ⌘Y · 모든 출력 찾기 ⇧⌘F
let userData: string
let app: ElectronApplication | undefined
let win: Page

const ANT = 'sk-ant-api03-' + 'Zk8aB_c-d'.repeat(8)

async function launch() {
  app = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: userData } })
  win = await firstWindow(app)
  await waitLoaded(win)
}

test.describe.configure({ timeout: 90_000 })

test.beforeEach(async () => {
  userData = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-e2e-')))
  seedState(userData, [
    { id: 'task-a', name: 'A 일감', paneId: 'pane-a', cwd: '/tmp' },
    { id: 'task-b', name: 'B 일감', paneId: 'pane-b', cwd: '/tmp' },
  ])
  await launch()
})
test.afterEach(async () => {
  await app?.close()
  rmSync(userData, { recursive: true, force: true })
})

const term = (id: string) => win.getByTestId(`pane-${id}`)
const screenOf = (id: string) => term(id).locator('.xterm-rows').innerText()
const panel = () => win.getByTestId('history-panel')
const rows = () => panel().getByTestId('history-row')
const row = (text: string) => rows().filter({ hasText: text })
const taskRow = (name: string) => win.locator(`[data-testid="task-row"][data-task-name="${name}"]`)
/** 줄 고르기(펼치기) — 이미 골랐으면 그대로(다시 누르면 접힌다) */
async function select(text: string) {
  if ((await row(text).getAttribute('aria-selected')) !== 'true') await row(text).locator('.history-line').click()
}
const historyFile = (taskId: string) => join(userData, 'history', `${taskId}.jsonl`)

async function waitText(id: string, re: RegExp) {
  await expect.poll(async () => re.test(await screenOf(id)), { timeout: 15_000 }).toBe(true)
}
/** 좁은 pane 은 줄이 접힌다 — 줄바꿈을 빼고 */
const flatOf = async (id: string) => (await screenOf(id)).replace(/\n/g, '')
/** 명령을 치고 다음 프롬프트까지(그 명령의 기록이 생긴 뒤) */
async function run(id: string, command: string, until: RegExp) {
  await term(id).click()
  await win.keyboard.type(command)
  await win.keyboard.press('Enter')
  await waitText(id, until)
}
const fileLines = (taskId: string) =>
  existsSync(historyFile(taskId))
    ? readFileSync(historyFile(taskId), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { id: string; cmd: string; code: number })
    : []

test('D 마다 기록 · ⌘Y 칸: 이 일감 → ⌥R 모든 일감 → 실패 칩, 파일 0600 · 비밀값 원문 없음', async () => {
  await waitText('pane-a', /%/)
  await run('pane-a', 'sleep 0.6 && echo A$((1+1))OK', /A2OK/)
  await run('pane-a', 'sleep 0.6; false', /false[\s\S]*%[\s\S]*$/)
  await run('pane-a', `sleep 0.6; echo ${ANT} >/dev/null; echo SEC$((1))`, /SEC1/)
  await taskRow('B 일감').click()
  await waitText('pane-b', /%/)
  await run('pane-b', 'sleep 0.6 && echo B$((1+1))OK', /B2OK/)
  await taskRow('A 일감').click()
  await term('pane-a').click()

  await win.keyboard.press('Meta+y')
  await expect(panel()).toBeVisible()
  await expect(panel().getByRole('textbox', { name: '기록에서 찾기' })).toBeFocused()
  await expect(rows()).toHaveCount(3) // 이 일감(기본)
  await expect(row('A$((1+1))OK')).toHaveCount(1)
  await expect(row('false')).toHaveAttribute('data-failed', 'true')
  // 명령 글자의 비밀값은 칸에서도 가린 글
  await expect(panel()).not.toContainText(ANT)
  await expect(row('SEC$((1))')).toContainText('‹가림:')

  await win.keyboard.press('Alt+r') // 이 일감 → 모든 일감
  await expect(panel().getByTestId('history-scope-all')).toHaveAttribute('aria-checked', 'true')
  await expect(rows()).toHaveCount(4)
  await expect(row('B$((1+1))OK')).toContainText('B 일감')
  await panel().getByTestId('history-chip-failed').click()
  await expect(rows()).toHaveCount(1)
  await win.screenshot({ path: 'test-results/history-panel.png' })

  // 저장: 일감마다 파일 · 0600 · 폴더 0700 · 원문 비밀값 없음
  await expect.poll(() => fileLines('task-a').length).toBe(3)
  expect(fileLines('task-b')).toHaveLength(1)
  expect(statSync(historyFile('task-a')).mode & 0o777).toBe(0o600)
  expect(statSync(join(userData, 'history')).mode & 0o777).toBe(0o700)
  expect(readFileSync(historyFile('task-a'), 'utf8')).not.toContain(ANT)
  expect(fileLines('task-a').find((e) => e.cmd === 'sleep 0.6; false')?.code).toBe(1)

  // 가린 자리가 든 명령은 ⌥↩ 로도 실행하지 않고 넣기만 (리뷰 — 가린 글자가 실행되지 않게)
  await panel().getByTestId('history-chip-failed').click() // 실패 칩 끄기
  await select('SEC$((1))')
  await expect(row('SEC$((1))').getByTestId('history-split')).toContainText('새 pane 에 넣기')

  // 설정 › 개인정보 › 명령 기록 모두 지우기 (확인 뒤)
  await win.getByRole('button', { name: '설정' }).click()
  await win.getByRole('button', { name: '개인정보' }).click()
  await win.getByTestId('history-clear').click()
  await win.getByRole('alertdialog').getByRole('button', { name: '모두 지우기' }).click()
  await expect(rows()).toHaveCount(0)
  await expect(panel().getByTestId('history-empty')).toBeVisible()
  await expect.poll(() => existsSync(historyFile('task-a')) || existsSync(historyFile('task-b'))).toBe(false)
})

test('↩ 입력줄에 넣기(실행 안 함) · ⌥↩ 오른쪽 분할에서 실행 · 위험 명령은 넣기만', async () => {
  await waitText('pane-a', /%/)
  await run('pane-a', 'sleep 0.6 && echo INS$((1+1))', /INS2/)
  await run('pane-a', 'sleep 0.6 && echo DEP$((2+3)) deploy', /DEP5 deploy/)
  await win.keyboard.press('Meta+y')
  await expect(rows()).toHaveCount(2)

  // ↩: 고른 줄을 지금 pane 입력줄에 — 실행하지 않는다
  await select('INS$((1+1))')
  await row('INS$((1+1))').getByTestId('history-insert').click()
  await expect.poll(async () => ((await screenOf('pane-a')).match(/INS\$\(\(1\+1\)\)/g) ?? []).length).toBe(2)
  await win.waitForTimeout(800)
  expect(((await screenOf('pane-a')).match(/^INS2$/gm) ?? []).length).toBe(1)
  await win.keyboard.press('Control+c')

  // ⌥↩: 그 폴더로 오른쪽 분할에서 실행
  await panel().getByRole('textbox', { name: '기록에서 찾기' }).click()
  await win.keyboard.press('ArrowDown') // 최근 것부터 — DEP 다음 INS
  await win.keyboard.press('ArrowDown')
  await expect(row('INS$((1+1))')).toHaveAttribute('aria-selected', 'true')
  await win.keyboard.press('Alt+Enter')
  const slots = win.locator('[data-testid="task-view"]:visible [data-testid="pane-slot"]')
  await expect(slots).toHaveCount(2)
  const newPane = await slots.nth(1).getAttribute('data-pane-id')
  await waitText(newPane!, /INS2/)

  // 위험 명령(deploy): 새 pane 에 넣기만
  await select('DEP$((2+3))')
  await expect(row('DEP$((2+3))').getByTestId('history-split')).toContainText('새 pane 에 넣기')
  await row('DEP$((2+3))').getByTestId('history-split').click()
  await expect(slots).toHaveCount(3)
  const third = (await slots.evaluateAll((els) => els.map((e) => e.getAttribute('data-pane-id')))).find((id) => id !== 'pane-a' && id !== newPane)!
  await expect.poll(async () => (await flatOf(third)).includes('DEP$((2+3)) deploy'), { timeout: 15_000 }).toBe(true)
  await win.waitForTimeout(1200)
  expect(await flatOf(third)).not.toContain('DEP5')
  await win.screenshot({ path: 'test-results/history-split.png' })
})

test('지우기 → 되돌리기 · 지우기 → 알림이 끝나면 파일에서도 · 재시작 뒤 이전 세션 · 출력으로 가기 흐림', async () => {
  await waitText('pane-a', /%/)
  await run('pane-a', 'sleep 0.6 && echo KEEP$((1))', /KEEP1/)
  await run('pane-a', 'sleep 0.6 && echo GONE$((1))', /GONE1/)
  await win.keyboard.press('Meta+y')
  await expect(rows()).toHaveCount(2)
  await expect.poll(() => fileLines('task-a').length).toBe(2)

  // 출력으로 가기: 이번 실행의 기록은 마커가 있다
  await select('KEEP$((1))')
  await expect(row('KEEP$((1))').getByTestId('history-goto')).toBeEnabled()

  // 지우기 → 되돌리기
  await select('GONE$((1))')
  await row('GONE$((1))').getByTestId('history-more').click()
  await row('GONE$((1))').getByTestId('history-remove').click()
  await expect(rows()).toHaveCount(1)
  await win.getByTestId('toast-action').click()
  await expect(rows()).toHaveCount(2)

  // 지우기 → 알림(5초)이 끝나면 파일에서
  await select('GONE$((1))')
  await row('GONE$((1))').getByTestId('history-more').click()
  await row('GONE$((1))').getByTestId('history-remove').click()
  await expect(rows()).toHaveCount(1)
  expect(fileLines('task-a')).toHaveLength(2) // 아직 — 되돌릴 수 있는 동안
  await expect(win.getByTestId('toast')).toHaveCount(0, { timeout: 8000 })
  await expect.poll(() => fileLines('task-a').map((e) => e.cmd)).toEqual(['sleep 0.6 && echo KEEP$((1))'])

  // 재시작: '이전 세션' 날 · 출력으로 가기 흐림
  await app!.close()
  await launch()
  await term('pane-a').click()
  await win.keyboard.press('Meta+y')
  await expect(rows()).toHaveCount(1)
  await expect(panel().locator('.history-day h3')).toContainText('이전 세션')
  await expect(panel().getByTestId('history-no-integration')).toHaveCount(0) // 다시 붙은 셸은 통합 신호 전이어도 '통합 없음' 이 아니다
  await select('KEEP$((1))')
  await expect(row('KEEP$((1))').getByTestId('history-goto')).toBeDisabled()
  await expect(row('KEEP$((1))')).toContainText('출력이 스크롤 밖이에요')
  await win.screenshot({ path: 'test-results/history-restart.png' })
})

test('⇧⌘F: 두 일감에서 찾기 → ↩ 그 pane 으로 · ⌘F 막대에 같은 글자, ⌘↩ 열어 둔 채, 정규식 오류, 비밀값 원문 0개 · 가림 종류로는 찾음', async () => {
  await waitText('pane-a', /%/)
  await run('pane-a', 'echo GF$((7*6))X; echo ' + ANT, /GF42X/)
  await taskRow('B 일감').click()
  await waitText('pane-b', /%/)
  await run('pane-b', 'echo GF$((7*6))X-b', /GF42X-b/)
  await taskRow('A 일감').click()
  await term('pane-a').click()

  const find = () => win.getByTestId('global-find')
  const gfRows = () => find().getByTestId('gf-row')
  await win.keyboard.press('Meta+Shift+f')
  await expect(find()).toBeVisible()
  await win.keyboard.type('gf42x')
  // 각 일감: 명령 줄(GF$((7*6))X)은 안 맞고 출력 줄만
  await expect(gfRows()).toHaveCount(2)
  await expect(find()).toContainText('A 일감')
  await expect(find()).toContainText('B 일감')
  await expect(find().getByTestId('gf-context')).toBeVisible() // 고른 줄의 앞뒤 — 비밀값이 든 명령 줄도 가린 글로
  await expect(find()).not.toContainText(ANT)
  await win.screenshot({ path: 'test-results/global-find.png' })

  // ⌘↩: 창을 연 채 뒤 화면만 B 로
  await win.keyboard.press('ArrowDown')
  await win.keyboard.press('Meta+Enter')
  await expect(find()).toBeVisible()
  await expect(find().getByRole('textbox')).toBeFocused() // 뒤에서 보이게 된 터미널이 포커스를 가져가도 돌아온다
  await expect(win.locator('[data-testid="task-view"]:visible')).toHaveAttribute('data-task-name', 'B 일감')
  // ↩: 그 줄로 가고 창을 닫고, 그 pane 의 ⌘F 막대에 같은 글자
  await win.keyboard.press('ArrowUp')
  await win.keyboard.press('Enter')
  await expect(find()).toHaveCount(0)
  await expect(win.locator('[data-testid="task-view"]:visible')).toHaveAttribute('data-task-name', 'A 일감')
  await expect(win.getByTestId('find-bar').getByRole('textbox')).toHaveValue('GF42X')
  await expect(win.getByTestId('find-count')).toHaveText(/^1\/1$/)
  await win.keyboard.press('Escape')

  // 다시 열면 낱말 그대로 · 정규식 오류
  await term('pane-a').click()
  await win.keyboard.press('Meta+Shift+f')
  await expect(find().getByRole('textbox')).toHaveValue('gf42x')
  await find().getByTestId('gf-re').click()
  await win.keyboard.type('(')
  await expect(find().getByTestId('gf-error')).toContainText('정규식을 읽을 수 없어요: ( 가 닫히지 않았어요')

  // 비밀값: 원문으로는 0개 + 가림 종류로 찾는 길
  await find().getByTestId('gf-re').click()
  await find().getByRole('textbox').fill(ANT)
  await expect(find().getByTestId('gf-empty')).toBeVisible()
  await expect(find().getByTestId('gf-secret')).toContainText('가림:Anthropic 키')
  await find().getByTestId('gf-secret').getByRole('button').click()
  await expect(gfRows()).toHaveCount(2) // 명령 줄 · 출력 줄
  await expect(find()).not.toContainText(ANT)
  await win.screenshot({ path: 'test-results/global-find-secret.png' })
})

test('⌘P 출력 결과 아래 "모두 보기 ⇧⌘F" — 같은 낱말로 열기 · 안 연 탭은 저장된 출력에서', async () => {
  await waitText('pane-a', /%/)
  await run('pane-a', 'echo PAL$((5*5))Z', /PAL25Z/)
  await taskRow('B 일감').click()
  await waitText('pane-b', /%/)
  await run('pane-b', 'echo SAVED$((3*3))Y', /SAVED9Y/)
  await taskRow('A 일감').click()
  await term('pane-a').click()

  await win.keyboard.press('Meta+p')
  await win.keyboard.type('PAL25')
  const all = win.locator('[data-testid="palette-item"][data-kind="find-all"]')
  await expect(all).toBeVisible()
  await all.click()
  await expect(win.getByTestId('global-find').getByRole('textbox')).toHaveValue('PAL25')
  await expect(win.getByTestId('global-find').getByTestId('gf-row')).toHaveCount(1)
  await win.keyboard.press('Escape')

  // 재시작 — B 는 열지 않은 탭: 저장된 출력에서 찾는다
  await app!.close()
  await launch()
  await term('pane-a').click()
  await win.keyboard.press('Meta+Shift+f')
  await win.keyboard.type('SAVED9Y')
  await expect(win.getByTestId('global-find').getByTestId('gf-row')).toHaveCount(1)
  await expect(win.getByTestId('gf-saved')).toContainText('열지 않은 탭 1개는 저장된 출력에서 찾았어요')
  await win.screenshot({ path: 'test-results/global-find-saved.png' })
  // ↩: 안 연 탭은 이제 막 출력을 되살린다 — 되살린 뒤 그 줄 · ⌘F 막대가 맞는다 (리뷰)
  await win.keyboard.press('Enter')
  await expect(win.locator('[data-testid="task-view"]:visible')).toHaveAttribute('data-task-name', 'B 일감')
  await expect(win.getByTestId('find-bar').getByRole('textbox')).toHaveValue('SAVED9Y')
  await expect(win.getByTestId('find-count')).toHaveText(/^1\/1$/)
})
