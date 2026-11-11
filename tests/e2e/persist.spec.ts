import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstWindow, seedState } from './helpers'

// 16단계: 셸 지킴이 — 앱을 꺼도 셸이 살아 있기. 같은 임시 userData 로 앱을 실제로 껐다 켠다.
// 지킴이는 userData 폴더가 사라지면 셸을 끝내고 나간다(afterEach 의 rmSync 가 정리).
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
async function close(): Promise<void> {
  await app.close()
  launched = undefined
}
/** 메뉴 항목 — 합성 키는 네이티브 메뉴 단축키를 부르지 않는다 */
const menu = (id: string) => app.evaluate(({ Menu }, id) => Menu.getApplicationMenu()!.getMenuItemById(id)!.click(), id)
/** 대화상자를 가짜로 — 물은 글을 모으고 정해 둔 단추를 고른다 */
async function stubDialog(answer: number): Promise<void> {
  await app.evaluate(({ dialog }, answer) => {
    const g = globalThis as unknown as { asked: string[]; answer: number }
    g.asked = []
    g.answer = answer
    dialog.showMessageBox = (async (...args: unknown[]) => {
      g.asked.push((args.at(-1) as { message: string }).message)
      return { response: g.answer, checkboxChecked: false }
    }) as typeof dialog.showMessageBox
  }, answer)
}
const asked = () => app.evaluate(() => (globalThis as unknown as { asked: string[] }).asked)
const setAnswer = (n: number) => app.evaluate((_e, n) => void ((globalThis as unknown as { answer: number }).answer = n), n)

const pane = (id: string) => win.getByTestId(`pane-${id}`)
const screen = (id: string) => pane(id).locator('.xterm-rows')
async function run(id: string, command: string): Promise<void> {
  await pane(id).click()
  await win.keyboard.type(command)
  await win.keyboard.press('Enter')
}
async function waitFor(id: string, re: RegExp): Promise<RegExpMatchArray> {
  let m: RegExpMatchArray | null = null
  await expect.poll(async () => (m = (await screen(id).innerText()).match(re)) !== null, { timeout: 15_000 }).toBe(true)
  return m!
}
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const expectGone = (pids: number[]) => expect.poll(() => pids.filter(alive), { timeout: 10_000 }).toEqual([])
const hostPid = async (): Promise<number> => {
  await expect.poll(() => win.evaluate(() => window.taskminal.host.view().then((v) => v.state))).toBe('connected')
  return win.evaluate(() => window.taskminal.host.view().then((v) => v.pid ?? 0))
}
const banner = (key: string) => win.getByTestId(`host-banner-${key}`)

test('앱을 꺼도 sleep 600 이 살아 있고, 다시 띄우면 같은 셸에 붙어 출력이 이어진다', async () => {
  seedState(userData, [{ id: 't', name: '지킴이', paneId: 'p1' }])
  await launch()
  await run('p1', 'sleep 600 & echo SL $$ $!')
  const m = await waitFor('p1', /SL (\d+) (\d+)/)
  const [shell, sleep] = [Number(m[1]), Number(m[2])]
  await close()
  expect({ shell: alive(shell), sleep: alive(sleep) }).toEqual({ shell: true, sleep: true })

  await launch()
  await expect(banner('resumed')).toContainText('셸 1개가 그대로 이어졌어요')
  await expect(screen('p1')).toContainText(`SL ${shell} ${sleep}`) // 앞 실행의 화면
  await run('p1', 'echo SAME $$ $(jobs -p | wc -l | tr -d " ")')
  expect((await waitFor('p1', /SAME (\d+) (\d+)/)).slice(1).map(Number)).toEqual([shell, 1]) // 같은 셸 · 그 셸의 작업 sleep
  expect(alive(sleep)).toBe(true)
  await win.screenshot({ path: 'test-results/persist-resumed.png' })
})

test('⌥⌘Q: 실행 중이면 묻고(기본 닫기) — 모두 끝내기면 셸 · 자식 · 지킴이가 남지 않는다', async () => {
  seedState(userData, [{ id: 't', name: '모두', paneId: 'p1' }], [], { confirmQuit: true })
  await launch()
  await run('p1', 'sleep 300 & echo QA $$ $!')
  const m = await waitFor('p1', /QA (\d+) (\d+)/)
  await run('p1', 'sleep 30')
  await expect(win.locator('[data-pane-id="p1"] [data-testid="pane-head"]')).toHaveAttribute('data-activity', 'running')
  const host = await hostPid()
  const pids = [Number(m[1]), Number(m[2]), host]

  await stubDialog(0) // 닫기
  await menu('quit-all')
  await expect.poll(asked).toEqual(['실행 중인 명령 1개를 끝낼까요?'])
  await win.waitForTimeout(300)
  expect(pids.every(alive)).toBe(true) // 아무것도 끝나지 않음

  const closed = new Promise<void>((resolve) => launched!.once('close', () => resolve()))
  await setAnswer(1) // 모두 끝내기
  await menu('quit-all')
  await closed
  launched = undefined
  await expectGone(pids)
})

test('지킴이가 죽으면 새 지킴이로 13단계 되살리기 — 이전 출력과 안내, 새 셸이 응답한다', async () => {
  seedState(userData, [{ id: 't', name: '충돌', paneId: 'p1' }])
  await launch()
  await run('p1', 'echo BEFORE_CRASH $$')
  const old = Number((await waitFor('p1', /BEFORE_CRASH (\d+)/))[1])
  const host = await hostPid()
  process.kill(host, 'SIGKILL')
  await expect(screen('p1')).toContainText('── 이전 세션', { timeout: 15_000 })
  await expect(screen('p1')).toContainText('BEFORE_CRASH')
  await expect(banner('fresh')).toContainText('셸을 새로 띄웠어요')
  await run('p1', 'echo NEW_SHELL $$')
  const fresh = Number((await waitFor('p1', /NEW_SHELL (\d+)/))[1])
  expect(fresh).not.toBe(old)
  expect(await hostPid()).not.toBe(host)
  await win.screenshot({ path: 'test-results/persist-fresh.png' })
})

test('주인 없는 셸: ⌘P 셸 지킴이 보기 → 목록 · 마지막 출력 · 끝내기', async () => {
  seedState(userData, [{ id: 't1', name: '지울 일감', paneId: 'p1' }])
  await launch()
  await run('p1', 'echo ORPHAN_MARK_$((5*5)) $$')
  const pid = Number((await waitFor('p1', /ORPHAN_MARK_25 (\d+)/))[1])
  await close()
  seedState(userData, [{ id: 't2', name: '남은 일감', paneId: 'p2' }]) // p1 이 상태에서 빠짐
  await launch()
  await expect(screen('p2')).toContainText('%')
  await win.keyboard.press('Meta+p')
  await win.keyboard.type('셸 지킴이 보기')
  await win.keyboard.press('Enter')
  const settings = win.getByTestId('settings')
  await expect(settings.locator('[data-section="host"]')).toBeVisible()
  await expect(settings.getByTestId('host-status')).toContainText('실행 중')
  const row = settings.getByTestId('orphan-p1')
  await expect(row).toBeVisible()
  await expect(settings.getByTestId('orphan-p2')).toHaveCount(0) // 주인 있는 셸은 목록에 없다
  await row.getByRole('button', { name: '마지막 출력 보기' }).click()
  await expect(settings.getByTestId('tail-p1')).toContainText('ORPHAN_MARK_25')
  await win.screenshot({ path: 'test-results/persist-orphans.png' })
  await row.getByRole('button', { name: '끝내기' }).click()
  await row.getByRole('alertdialog').getByRole('button', { name: '끝내기' }).click()
  await expectGone([pid])
  await expect(row).toHaveCount(0)
})

test('꺼져 있던 동안 입력을 기다리게 되면 다시 열 때 사이드바 확인 필요 · 위 줄', async () => {
  seedState(userData, [{ id: 't', name: '기다림 일감', paneId: 'p1' }, { id: 't2', name: '다른 일감', paneId: 'p2' }])
  await launch()
  await run('p1', `(sleep 2; printf '\\e]9;고칠까요? (y/n)\\a') & echo ARMED`)
  await waitFor('p1', /^ARMED/m)
  await close()
  await new Promise((r) => setTimeout(r, 3500)) // 앱이 꺼진 동안 알림이 온다
  await launch()
  await expect(banner('waiting')).toContainText('꺼져 있던 동안 1개가 입력을 기다려요')
  await expect(banner('waiting')).toContainText('고칠까요? (y/n)')
  await expect(win.getByTestId('attention-row')).toHaveCount(1)
  await expect(win.getByTestId('attention-row')).toContainText('기다림 일감')
  await win.screenshot({ path: 'test-results/persist-waiting.png' })
})

// 작은 고침(2026-11-11 리뷰): 위 줄의 기다림 메시지도 화면 가리기를 따른다
test('꺼져 있던 동안 온 기다림 메시지의 비밀값은 다시 열 때 위 줄에서 가린다', async () => {
  const KEY = 'sk-ant-api03-' + 'Wv3nR_k-8'.repeat(6)
  seedState(userData, [{ id: 't', name: '기다림 일감', paneId: 'p1' }])
  await launch()
  await run('p1', `(sleep 2; printf '\\e]9;키 ${KEY} 를 쓸까요?\\a') & echo ARMED`)
  await waitFor('p1', /^ARMED/m)
  await close()
  await new Promise((r) => setTimeout(r, 3500))
  await launch()
  await expect(banner('waiting')).toContainText('‹가림:')
  await expect(banner('waiting')).not.toContainText(KEY)
})

test('처음 ⌘Q 는 한 번만 안내 — 취소면 그대로, 앱만 끄기면 셸이 남고 다음에는 묻지 않는다', async () => {
  seedState(userData, [{ id: 't', name: '안내', paneId: 'p1' }])
  await launch({ TASKMINAL_QUIT_NOTICE: 'show' })
  await run('p1', 'echo NOTICE $$')
  const pid = Number((await waitFor('p1', /NOTICE (\d+)/))[1])
  await expect.poll(() => win.evaluate(() => window.taskminal.host.view().then((v) => v.state))).toBe('connected')
  await stubDialog(2) // 취소
  await app.evaluate(({ app }) => app.quit())
  await expect.poll(asked).toEqual(['이제 앱을 꺼도 셸은 계속 돌아요'])
  await win.waitForTimeout(300)
  await expect(screen('p1')).toBeVisible()

  const closed = new Promise<void>((resolve) => launched!.once('close', () => resolve()))
  await setAnswer(0) // 앱만 끄기
  await app.evaluate(({ app }) => app.quit())
  await closed
  launched = undefined
  expect(alive(pid)).toBe(true)

  await launch({ TASKMINAL_QUIT_NOTICE: 'show' })
  await stubDialog(2)
  const closed2 = new Promise<void>((resolve) => launched!.once('close', () => resolve()))
  await app.evaluate(({ app }) => app.quit())
  await closed2 // 묻지 않고 끝남
  launched = undefined
})

test('다른 버전 지킴이가 셸을 갖고 있으면 알리고, 지금 바꾸기로 끝낸다', async () => {
  seedState(userData, [{ id: 't', name: '옛 버전', paneId: 'p1' }])
  await launch({ TASKMINAL_PTYHOST_PROTOCOL: '0' })
  await run('p1', 'echo OLD $$')
  const old = Number((await waitFor('p1', /OLD (\d+)/))[1])
  await close()
  await launch()
  await expect(banner('old-host')).toContainText('새 버전과 맞지 않는 지킴이예요')
  await expect(banner('old-host')).toContainText('셸 1개')
  await win.screenshot({ path: 'test-results/persist-old-host.png' })
  await banner('old-host').getByRole('button', { name: '지금 바꾸기…' }).click()
  await win.getByRole('alertdialog').getByRole('button', { name: '지금 바꾸기' }).click()
  await expectGone([old])
  await expect(banner('old-host')).toHaveCount(0)
})

test('지킴이를 띄우지 못하면 다섯 번 다시 해 본 뒤 연결하지 못했다고 알린다', async () => {
  seedState(userData, [{ id: 't', name: '연결 안 됨', paneId: 'p1' }])
  await launch({ TASKMINAL_PTYHOST_SCRIPT: join(userData, 'no-such-host.js'), TASKMINAL_PTYHOST_RETRY_MS: '20' })
  await expect(banner('down')).toContainText('셸 지킴이에 연결하지 못했어요', { timeout: 15_000 })
  await expect(banner('down').getByRole('button', { name: '다시 연결' })).toBeVisible()
  await expect(screen('p1')).toContainText('셸을 띄우지 못했습니다')
  await win.screenshot({ path: 'test-results/persist-down.png' })
})

test('지킴이 메모리가 기준을 넘으면 한 번 알리고, 목록 보고 끄기가 설정 칸을 연다', async () => {
  seedState(userData, [{ id: 't', name: '메모리', paneId: 'p1' }])
  await launch({ TASKMINAL_PTYHOST_WARN_MB: '1', TASKMINAL_PTYHOST_STATS_MS: '300' })
  await expect(banner('memory')).toContainText('셸 지킴이가 메모리', { timeout: 10_000 })
  await banner('memory').getByRole('button', { name: '목록 보고 끄기' }).click()
  await expect(win.getByTestId('settings').locator('[data-section="host"]')).toBeVisible()
  await expect(banner('memory')).toHaveCount(0)
})
