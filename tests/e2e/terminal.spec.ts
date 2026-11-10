import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstWindow, seedState } from './helpers'

// 임시 userData 로만 띄운다. 셸은 사용자의 실제 HOME · .zshrc 로 뜬다(로그인 셸).
let userData: string
let app: ElectronApplication
let launched: ElectronApplication | undefined
let win: Page

test.beforeEach(async () => {
  userData = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-e2e-')))
  seedState(userData, [{ id: 'task-1', name: '터미널 시험', paneId: 'pane-1' }]) // 5단계부터 터미널은 일감 안에 있다
  launched = undefined
  app = launched = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: userData } })
  win = await firstWindow(app)
})

test.afterEach(async () => {
  await launched?.close()
  rmSync(userData, { recursive: true, force: true })
})

const pane = () => win.getByTestId('pane-pane-1')
const screenText = () => win.locator('.xterm-rows').innerText()

async function run(command: string): Promise<void> {
  await pane().click()
  await win.keyboard.type(command)
  await win.keyboard.press('Enter')
}

/** 출력에서 정규식이 처음 맞는 줄을 기다려 그 결과를 돌려준다 (명령 줄 자체는 숫자가 아니라 안 맞게 쓴다). */
async function waitFor(re: RegExp): Promise<RegExpMatchArray> {
  let m: RegExpMatchArray | null = null
  await expect.poll(async () => (m = (await screenText()).match(re)) !== null, { timeout: 15_000 }).toBe(true)
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

/** 셸 pid 와 백그라운드 자식 pid 를 읽는다. */
async function shellPids(tag: string): Promise<[number, number]> {
  await run(`sleep 300 & echo ${tag} $$ $!`)
  const m = await waitFor(new RegExp(`${tag} (\\d+) (\\d+)`))
  const pids: [number, number] = [Number(m[1]), Number(m[2])]
  expect(pids.every(alive)).toBe(true)
  return pids
}

async function expectGone(pids: number[]): Promise<void> {
  await expect.poll(() => pids.filter(alive), { timeout: 10_000 }).toEqual([])
}

test('셸에 친 한글이 그대로 나온다', async () => {
  await run('echo 안녕 터미널')
  await expect(win.locator('.xterm-rows')).toContainText('안녕 터미널')
  await expect.poll(async () => (await screenText()).split('안녕 터미널').length - 1).toBeGreaterThanOrEqual(2) // 입력 줄 + 출력 줄
  await win.screenshot({ path: 'test-results/terminal.png' })
})

test('stty size 가 화면의 터미널 크기와 같고, 창을 줄이면 따라 바뀐다', async () => {
  const sizeOf = async () => [await pane().getAttribute('data-rows'), await pane().getAttribute('data-cols')].join(' ')

  await run('echo SIZE1 $(stty size)')
  const first = await waitFor(/SIZE1 (\d+ \d+)/)
  expect(first[1]).toBe(await sizeOf())

  const before = await sizeOf()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(800, 500))
  await expect.poll(sizeOf).not.toBe(before)
  await run('echo SIZE2 $(stty size)')
  const second = await waitFor(/SIZE2 (\d+ \d+)/)
  expect(second[1]).toBe(await sizeOf())
})

// 16단계: 종료 경로 ①~④ 는 셸을 끝내지 않는다 — 셸 지킴이에 남고, 다시 붙으면 같은 셸(같은 $$)이다.
// 셸까지 끝내는 길(⌥⌘Q · pane 닫기 · 지킴이 죽음)은 persist.spec.ts.

/** 지금 pane 의 셸 pid ($$) */
async function shellPid(tag: string): Promise<number> {
  await run(`echo ${tag} $$`)
  return Number((await waitFor(new RegExp(`${tag} (\\d+)`)))[1])
}

test('종료 경로 ① 앱 종료: 셸과 그 자식이 남고, 다시 띄우면 같은 셸에 붙는다', async () => {
  const pids = await shellPids('PIDA')
  await app.close()
  launched = undefined
  await win.waitForTimeout(500).catch(() => {})
  expect(pids.every(alive)).toBe(true)
  app = launched = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: userData } })
  win = await firstWindow(app)
  await expect(win.locator('.xterm-rows')).toContainText('PIDA') // 앞 실행의 화면이 이어진다
  expect(await shellPid('AGAINA')).toBe(pids[0])
})

test('종료 경로 ② 창 닫기: 셸은 남고, 창을 다시 열면 같은 셸에 붙는다', async () => {
  const pids = await shellPids('PIDB')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close())
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0)
  expect(pids.every(alive)).toBe(true)
  expect(await app.evaluate(({ app }) => app.isReady())).toBe(true) // 앱은 그대로
  const reopened = app.waitForEvent('window')
  await app.evaluate(({ app }) => app.emit('activate')) // Dock 아이콘 누르기
  win = await reopened
  expect(await shellPid('AGAINB')).toBe(pids[0])
})

test('종료 경로 ③ 새로 고침: 같은 셸에 다시 붙고 화면이 이어진다', async () => {
  const old = await shellPids('PIDC')
  await win.reload()
  await expect(win.locator('.xterm-rows')).toContainText('PIDC')
  expect(await shellPid('AGAINC')).toBe(old[0])
  expect(old.every(alive)).toBe(true)
})

test('종료 경로 ④ 렌더러 충돌: 셸은 남고 창이 다시 읽혀 같은 셸에 붙는다', async () => {
  const pids = await shellPids('PIDE')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.forcefullyCrashRenderer())
  // main 이 같은 창을 다시 읽어 다시 붙는다. Playwright 는 충돌한 Page 를 되살리지 못해 main 에서 화면 글을 읽는다
  const shown = () =>
    app.evaluate(({ BrowserWindow }) => {
      const wc = BrowserWindow.getAllWindows()[0]!.webContents
      return wc.isCrashed() || wc.isLoading() ? '' : (wc.executeJavaScript(`document.querySelector('.xterm-rows')?.innerText ?? ''`) as Promise<string>)
    })
  await expect.poll(shown, { timeout: 15_000 }).toContain(`PIDE ${pids[0]} ${pids[1]}`)
  expect(pids.every(alive)).toBe(true)
})

test('새로 고침해도 셸에 HUP 이 가지 않는다 (trap 이 돌지 않음)', async () => {
  await run(`trap 'echo GHOST_$((40+2))' HUP; echo READY_$((1+1))`)
  await waitFor(/READY_2/)
  await win.reload()
  await run('echo FRESH_$((2+3))')
  await waitFor(/FRESH_5/)
  await win.waitForTimeout(1000)
  expect(await screenText()).not.toContain('GHOST_42')
})

test('pane 닫기는 SIGHUP 을 무시하는 셸도 끝낸다 (지킴이가 2초 뒤 SIGKILL)', async () => {
  await run(`trap '' HUP; echo PIDF $$`)
  const pid = Number((await waitFor(/PIDF (\d+)/))[1])
  await win.keyboard.press('Meta+w')
  await expectGone([pid])
})

test('앱을 끝낸 뒤 다시 띄우면 새 셸이 곧바로 응답한다', async () => {
  // 종료 때 셸을 SIGKILL 하면 zsh 가 정리 없이 죽어 다음 셸이 약 10초 늦게 떴다(3단계 리뷰 반영 중 측정).
  await run('echo FIRST_$((3*3))')
  await waitFor(/FIRST_9/)
  await app.close()
  app = launched = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: userData } })
  win = await firstWindow(app)
  const t0 = Date.now()
  await run('echo AGAIN_$((4*4))')
  await waitFor(/AGAIN_16/)
  expect(Date.now() - t0).toBeLessThan(4000)
})
