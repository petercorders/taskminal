import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstWindow, seedState, selectSettingsSection, waitLoaded } from './helpers'

// 61: 설정 › 셸 지킴이 '이 Mac 의 다른 지킴이' — 다른 데이터 폴더로 띄운 앱이 남긴 지킴이가 줄에 보이고,
// '셸까지 끝내기…' 확인 뒤 사라진다 · 지금 앱의 지킴이는 줄에 없다 (docs/stages/61-65-orca-gap-v5.md).
// 다른 지킴이는 두 번째 앱(다른 임시 데이터 폴더)을 띄워 셸을 연 뒤 앱만 닫아 남긴다 — 앱이 지킴이를 띄우는 길 그대로.
// 정리: 이 시험이 만든 임시 폴더를 가리키는 지킴이만 끝낸다(다른 시험 · 사용자의 지킴이는 건드리지 않는다).
let mine: string
let other: string
let launched: ElectronApplication | undefined
let win: Page

test.describe.configure({ timeout: 90_000 })
test.beforeEach(() => {
  mine = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-e2e-')))
  other = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-e2e-other-')))
  launched = undefined
})

/** 이 시험의 임시 폴더를 데이터 폴더로 쓰는 지킴이 pid 들 (ps 명령줄의 `host.js <소켓> <데이터 폴더>`) */
function hostPids(folder: string): number[] {
  const out = execFileSync('ps', ['-A', '-ww', '-o', 'pid=,command='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } })
  return out
    .split('\n')
    .map((l) => /^\s*(\d+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m && /\/host\.js /.test(m[2]!) && m[2]!.endsWith(` ${folder}`))
    .map((m) => Number(m[1]))
}

test.afterEach(async () => {
  await launched?.close()
  rmSync(mine, { recursive: true, force: true, maxRetries: 5 })
  rmSync(other, { recursive: true, force: true, maxRetries: 5 })
  // 지킴이는 데이터 폴더 · 소켓이 사라지면 2초 안에 스스로 끝난다(development.md 16). 그래도 남은 것만 이 시험 것으로 골라 끝낸다
  await expect.poll(() => [...hostPids(mine), ...hostPids(other)], { timeout: 8_000 }).toEqual([]).catch(() => {})
  for (const pid of [...hostPids(mine), ...hostPids(other)]) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* 이미 끝남 */
    }
  }
})

async function launch(userData: string): Promise<ElectronApplication> {
  const app = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: userData } })
  launched = app
  win = await firstWindow(app)
  await waitLoaded(win)
  return app
}
async function shellUp(paneId: string) {
  const pane = win.getByTestId(`pane-${paneId}`)
  await pane.click()
  await win.keyboard.type('echo HOST_UP_$((5+6))')
  await win.keyboard.press('Enter')
  await expect.poll(async () => /^HOST_UP_11/m.test(await pane.locator('.xterm-rows').innerText()), { timeout: 15_000 }).toBe(true)
}

test('다른 데이터 폴더의 지킴이가 줄에 보이고 셸까지 끝내기 → 확인 뒤 사라진다 · 지금 앱의 지킴이는 줄에 없다', async () => {
  // ① 다른 데이터 폴더로 앱을 띄워 셸을 열고, 앱만 닫는다 → 그 지킴이는 셸과 함께 남는다
  seedState(other, [{ id: 'task-o', name: '다른 앱 일감', paneId: 'pane-o', cwd: '/tmp' }])
  const otherApp = await launch(other)
  await shellUp('pane-o')
  await otherApp.close()
  launched = undefined
  await expect.poll(() => hostPids(other).length, { timeout: 10_000 }).toBe(1)
  const otherPid = hostPids(other)[0]!

  // ② 이 앱(다른 임시 폴더)을 띄우고 셸을 열어 이 앱의 지킴이도 뜨게 한다
  seedState(mine, [{ id: 'task-m', name: '이 앱 일감', paneId: 'pane-m', cwd: '/tmp' }])
  await launch(mine)
  await shellUp('pane-m')
  await expect.poll(() => hostPids(mine).length, { timeout: 10_000 }).toBe(1)
  const minePid = hostPids(mine)[0]!

  await win.keyboard.press('Meta+Comma')
  const settings = win.getByTestId('settings')
  await expect(settings).toBeVisible()
  await selectSettingsSection(settings, '셸 지킴이')
  const list = settings.getByTestId('host-others')
  const otherRow = list.getByTestId(`other-host-${otherPid}`)
  await expect(otherRow).toBeVisible({ timeout: 15_000 })
  await expect(otherRow.locator('.host-other-folder')).toHaveAttribute('title', other)
  await expect(otherRow).toContainText('셸 1개')
  await expect(otherRow).toContainText('실행 중인 명령 없음')
  // 지금 앱의 지킴이는 목록에 없다(pid 로도 · 데이터 폴더로도)
  await expect(list.getByTestId(`other-host-${minePid}`)).toHaveCount(0)
  await expect(list.locator(`.host-other-folder[title="${mine}"]`)).toHaveCount(0)
  await win.screenshot({ path: 'test-results/host-scan-others.png' })

  // ③ 셸까지 끝내기… → 줄 안 확인 → 닫기는 아무것도 하지 않는다
  await otherRow.getByRole('button', { name: '셸까지 끝내기…' }).click()
  const confirm = otherRow.getByRole('alertdialog')
  await expect(confirm).toContainText('이 지킴이와 셸 1개가 끝나요')
  await confirm.getByRole('button', { name: '닫기' }).click()
  await expect(confirm).toHaveCount(0)
  expect(hostPids(other)).toEqual([otherPid])

  // ④ 다시 열어 끝내기 → 그 지킴이가 사라지고 줄도 사라진다
  await otherRow.getByRole('button', { name: '셸까지 끝내기…' }).click()
  await otherRow.getByRole('alertdialog').getByRole('button', { name: '끝내기', exact: true }).click()
  await expect(settings.getByTestId('host-other-note')).toHaveText('지킴이와 셸을 끝냈어요.', { timeout: 10_000 })
  await expect(list.getByTestId(`other-host-${otherPid}`)).toHaveCount(0)
  await expect.poll(() => hostPids(other), { timeout: 10_000 }).toEqual([])
  // 이 앱의 지킴이 · 셸은 그대로
  expect(hostPids(mine)).toEqual([minePid])
  await win.screenshot({ path: 'test-results/host-scan-ended.png' })
})
