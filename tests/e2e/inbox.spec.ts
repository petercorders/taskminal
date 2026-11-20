import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstWindow, seedState, waitLoaded } from './helpers'

// 66: 알림 받은편지함 — 보고 있지 않은 pane 의 알림을 전체 보기 '지난 알림' · 사이드바 '· 알림 N' 으로 (docs/stages/66-notification-inbox.md '돌려야 할 e2e' 7가지).
// macOS 배너 · 소리는 모든 종류에서 끈다 — 실제 알림 센터에 쌓이지 않게. 받은편지함은 꺼 둔 종류도 남긴다(설정은 방해만 끈다).
// 사용자 dotfile 이 셸을 흔들지 않게 빈 ZDOTDIR 로 띄운다(셸 통합은 앱이 넣는다).
const QUIET = { banner: false, sound: false }
let userData: string
let app: ElectronApplication | undefined
let win: Page

test.describe.configure({ timeout: 90_000 })
test.beforeEach(() => {
  userData = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-e2e-inbox-')))
  seedState(
    userData,
    [
      { id: 'task-a', name: 'A 일감', paneId: 'pane-a', cwd: '/tmp' },
      { id: 'task-b', name: 'B 일감', paneId: 'pane-b', cwd: '/tmp' },
      { id: 'task-c', name: 'C 일감', paneId: 'pane-c', cwd: '/tmp' },
    ],
    [],
    { notify: { wait: QUIET, long: QUIET, fail: QUIET, exit: QUIET } },
  )
})
test.afterEach(async () => {
  await app?.close()
  app = undefined
  rmSync(userData, { recursive: true, force: true, maxRetries: 5 })
})

async function launch() {
  const zdot = join(userData, 'zdot')
  mkdirSync(zdot, { recursive: true })
  app = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: userData, ZDOTDIR: zdot } })
  win = await firstWindow(app)
  await waitLoaded(win)
}

// 흐름 보기에서 확인이 필요한 일감은 '확인 필요' 칸(attention-row)으로 옮겨진다 — 둘 다 같은 일감 줄
const row = (name: string) => win.locator(`[data-testid="task-row"][data-task-name="${name}"], [data-testid="attention-row"][data-task-name="${name}"]`).first()
const term = (id: string) => win.getByTestId(`pane-${id}`)
const screenOf = (id: string) => term(id).locator('.xterm-rows').innerText()
const visibleTask = () => win.locator('[data-testid="task-view"]:visible')
const overviewButton = () => win.getByTestId('sidebar').locator('.sidebar-overview')
const overview = () => win.getByTestId('overview')
const inboxRows = () => overview().getByTestId('overview-inbox-row')
const inboxFile = (): Array<{ kind: string; taskId: string; paneId: string; title: string; body: string; read: boolean }> => {
  const f = join(userData, 'inbox.json')
  if (!existsSync(f)) return []
  try {
    return JSON.parse(readFileSync(f, 'utf8'))
  } catch {
    return []
  }
}

async function waitText(id: string, re: RegExp) {
  await expect.poll(async () => re.test(await screenOf(id)), { timeout: 20_000 }).toBe(true)
}
async function type(line: string) {
  await win.keyboard.type(line)
  await win.keyboard.press('Enter')
}
/** 그 일감으로 가서 셸이 뜬 것을 확인한다 */
async function goShell(task: string, paneId: string) {
  await row(task).click()
  await expect(visibleTask()).toHaveAttribute('data-task-name', task)
  await term(paneId).click()
  const mark = `READY_${paneId.slice(-1)}_`
  await type(`echo ${mark}$((40+2))`)
  await waitText(paneId, new RegExp(`^${mark}42`, 'm'))
}
/** 그 일감에서 1초 뒤 끝나는 명령을 치고 곧바로 다른 일감을 본다 — 알림은 보고 있지 않은 pane 에서 온다 */
async function laterIn(task: string, paneId: string, command: string, thenView: string) {
  await goShell(task, paneId)
  await type(`sleep 1; ${command}`)
  await row(thenView).click()
  await expect(visibleTask()).toHaveAttribute('data-task-name', thenView)
}
async function openOverview() {
  await overviewButton().click()
  await expect(overview()).toBeVisible()
}
async function closeOverview() {
  await overview().getByRole('button', { name: '일감으로 돌아가기' }).click()
  await expect(overview()).toHaveCount(0)
}

test('보고 있는 pane 의 실패는 남지 않고, 다른 일감을 보는 동안의 실패는 지난 알림 · 사이드바 알림 1 → 누르면 그 pane 이 열리고 안 읽음이 사라진다', async () => {
  await launch()
  // ① 보고 있는 A 의 실패 — 남지 않는다
  await goShell('A 일감', 'pane-a')
  await type('false')
  await type('echo VIEWED_$((1+1))')
  await waitText('pane-a', /^VIEWED_2/m)
  await expect(overviewButton()).toHaveText('전체 보기')

  // ② B 에서 실패 — A 를 보는 동안
  await laterIn('B 일감', 'pane-b', 'false', 'A 일감')
  await expect(overviewButton()).toHaveText('전체 보기 · 알림 1', { timeout: 10_000 })
  await openOverview()
  await expect(inboxRows()).toHaveCount(1)
  const r = inboxRows().first()
  await expect(r).toContainText('명령이 실패했습니다')
  await expect(r).toContainText('· 안 읽음')
  await expect(r).toContainText('B 일감 · sleep 1; false · exit 1') // 본문: 일감 · 명령 · 종료 코드
  await expect(overview().locator('#overview-inbox-title')).toContainText('안 읽음 1')
  await win.screenshot({ path: 'test-results/inbox-row.png' })

  // ③ 줄을 누르면 B 의 그 pane 이 열리고 안 읽음이 사라진다
  await r.click()
  await expect(overview()).toHaveCount(0)
  await expect(visibleTask()).toHaveAttribute('data-task-name', 'B 일감')
  await expect(term('pane-b')).toBeVisible()
  await expect(overviewButton()).toHaveText('전체 보기')
  await openOverview()
  await expect(inboxRows()).toHaveCount(1) // A 의 실패는 끝까지 없다
  await expect(inboxRows().first()).not.toContainText('안 읽음')
  await expect.poll(() => inboxFile().map((e) => [e.paneId, e.read])).toEqual([['pane-b', true]])
})

test('다시 띄워도(같은 임시 데이터) 지난 알림 · 읽음이 남는다 · 비우기… 의 Esc 는 확인 창만 닫고, 확인하면 목록이 빈다', async () => {
  await launch()
  // B 의 실패 두 번 — 하나는 줄을 눌러 읽음, 하나는 안 읽음으로 둔다(마지막에 A 를 본다)
  await laterIn('B 일감', 'pane-b', 'false', 'A 일감')
  await expect(overviewButton()).toHaveText('전체 보기 · 알림 1', { timeout: 10_000 })
  await openOverview()
  await inboxRows().first().click()
  await expect(overviewButton()).toHaveText('전체 보기')
  await laterIn('B 일감', 'pane-b', 'exit 3', 'A 일감') // 셸이 실패로 끝남(exit 3) — '셸 닫힘'
  await expect(overviewButton()).toHaveText('전체 보기 · 알림 1', { timeout: 10_000 })
  await expect.poll(() => inboxFile().map((e) => e.read).sort()).toEqual([false, true]) // 파일까지 쓰인 뒤 끈다

  await app!.close()
  app = undefined
  await launch()
  await expect(visibleTask()).toHaveAttribute('data-task-name', 'A 일감')
  await expect(overviewButton()).toHaveText('전체 보기 · 알림 1')
  await openOverview()
  await expect(inboxRows()).toHaveCount(2)
  await expect(inboxRows().filter({ hasText: '안 읽음' })).toHaveCount(1)
  await expect(inboxRows().filter({ hasText: '안 읽음' })).toContainText('셸이 닫혔습니다')
  await expect(inboxRows().filter({ hasText: '명령이 실패했습니다' })).not.toContainText('안 읽음')

  // 비우기… → Esc 는 확인 창만 닫는다(전체 보기는 그대로)
  await overview().getByRole('button', { name: '비우기…' }).click()
  const confirm = win.getByRole('alertdialog').filter({ hasText: '지난 알림 비우기' })
  await expect(confirm).toBeVisible()
  await win.keyboard.press('Escape')
  await expect(confirm).toHaveCount(0)
  await expect(overview()).toBeVisible()
  await expect(inboxRows()).toHaveCount(2)
  // 확인하면 목록이 빈다
  await overview().getByRole('button', { name: '비우기…' }).click()
  await confirm.getByRole('button', { name: '비우기', exact: true }).click()
  await expect(inboxRows()).toHaveCount(0)
  await expect(overview().getByTestId('overview-inbox')).toContainText('지난 알림이 없어요')
  await expect(overviewButton()).toHaveText('전체 보기')
  await expect.poll(() => inboxFile().length).toBe(0)
})

test('일감을 지우고 되돌리기를 놓치면 그 일감의 지난 알림만 사라진다', async () => {
  await launch()
  await laterIn('B 일감', 'pane-b', 'false', 'A 일감')
  await laterIn('C 일감', 'pane-c', 'false', 'A 일감')
  await expect(overviewButton()).toHaveText('전체 보기 · 알림 2', { timeout: 10_000 })

  await row('B 일감').hover()
  await win.getByRole('button', { name: 'B 일감 지우기' }).click()
  await win.getByRole('alertdialog').getByRole('button', { name: '지우기' }).click()
  await expect(win.locator('[data-task-name="B 일감"]')).toHaveCount(0)
  // 되돌리기 알림이 떠 있는 동안은 아직 남는다 — 알림을 닫아 되돌리기를 놓친다
  await win.getByRole('button', { name: '알림 닫기' }).click()
  await expect(overviewButton()).toHaveText('전체 보기 · 알림 1')
  await openOverview()
  await expect(inboxRows()).toHaveCount(1)
  await expect(inboxRows().first()).toContainText('C 일감')
  await expect.poll(() => inboxFile().map((e) => e.taskId)).toEqual(['task-c'])
})

test('전체 보기를 연 채 활성 pane 의 명령이 실패하면 줄이 생기고 안 읽음으로 남는다', async () => {
  await launch()
  await goShell('A 일감', 'pane-a')
  await type('sleep 1; false')
  await openOverview() // 전체 보기가 터미널을 덮는 동안 A 는 보고 있지 않다
  await expect(inboxRows()).toHaveCount(1, { timeout: 10_000 })
  await expect(inboxRows().first()).toContainText('명령이 실패했습니다')
  await expect(inboxRows().first()).toContainText('안 읽음')
  await expect(overviewButton()).toHaveText('전체 보기 · 알림 1')
  await win.waitForTimeout(500)
  await expect(inboxRows().first()).toContainText('안 읽음') // 열려 있는 동안 읽음이 되지 않는다
  // 전체 보기를 닫고 그 pane 을 보면 읽음(그 pane 을 보면 그 시각까지의 알림이 읽음)
  await closeOverview()
  await expect(overviewButton()).toHaveText('전체 보기')
})

test('다른 일감을 보는 동안 셸이 exit 0 으로 닫히면 줄은 남되 안 읽음 수에 들지 않는다', async () => {
  await launch()
  await laterIn('B 일감', 'pane-b', 'exit 0', 'A 일감')
  await expect.poll(() => inboxFile().map((e) => [e.kind, e.paneId, e.read]), { timeout: 10_000 }).toEqual([['exit', 'pane-b', true]])
  await expect(overviewButton()).toHaveText('전체 보기')
  await openOverview()
  await expect(inboxRows()).toHaveCount(1)
  await expect(inboxRows().first()).toContainText('셸이 닫혔습니다')
  await expect(inboxRows().first()).not.toContainText('안 읽음')
  await expect(overview().locator('#overview-inbox-title')).not.toContainText('안 읽음')
})
