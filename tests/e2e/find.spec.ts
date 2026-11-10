import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstWindow, seedState } from './helpers'

// 15d: ⌘F 터미널 안 찾기
let userData: string
let app: ElectronApplication
let win: Page

test.beforeEach(async () => {
  userData = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-e2e-')))
  seedState(userData, [{ id: 't', name: '찾기', paneId: 'p1' }])
  app = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: userData } })
  win = await firstWindow(app)
})
test.afterEach(async () => {
  await app.close()
  rmSync(userData, { recursive: true, force: true })
})

const bar = () => win.getByTestId('find-bar')
const count = () => win.getByTestId('find-count')

test('⌘F → 입력하면 n/m, ↩ 다음 · ⇧↩ 이전, Esc 로 닫고 터미널에 다시 친다', async () => {
  await win.getByTestId('pane-p1').click()
  await win.keyboard.type('for i in 1 2 3; do echo NEEDLE$((i*0))X; done')
  await win.keyboard.press('Enter')
  await expect(win.getByTestId('pane-p1').locator('.xterm-rows')).toContainText('NEEDLE0X')

  await win.keyboard.press('Meta+f')
  await expect(bar()).toBeVisible()
  await win.keyboard.type('needle0x') // 대소문자 무시
  await expect(count()).toHaveText(/^\d\/3$/)
  const first = await count().innerText()
  await win.keyboard.press('Enter')
  await expect(count()).not.toHaveText(first)
  await win.keyboard.press('Shift+Enter')
  await expect(count()).toHaveText(first)
  await win.screenshot({ path: 'test-results/find-bar.png' })

  await win.keyboard.press('Escape')
  await expect(bar()).toHaveCount(0)
  await win.keyboard.type('echo AFTER$((1+1))')
  await win.keyboard.press('Enter')
  await expect(win.getByTestId('pane-p1').locator('.xterm-rows')).toContainText('AFTER2')
})

test('없는 말은 없음, 열린 채 ⌘F 는 입력칸 전체 선택', async () => {
  await win.getByTestId('pane-p1').click()
  await win.keyboard.press('Meta+f')
  await win.keyboard.type('zzqqnotthere')
  await expect(count()).toHaveText('없음')
  await win.getByTestId('pane-p1').click()
  await win.keyboard.press('Meta+f')
  await win.keyboard.type('abc') // 전체 선택돼 있어 바뀐다
  await expect(bar().getByRole('textbox')).toHaveValue('abc')
})

test('입력칸에 포커스가 있는 채 ⌘F 도 전체 선택 · 다른 탭으로 가면 막대가 닫힌다 (15d 리뷰)', async () => {
  await win.getByTestId('pane-p1').click()
  await win.keyboard.press('Meta+f')
  await win.keyboard.type('first')
  await win.keyboard.press('Meta+f') // 포커스가 입력칸에 있는 채
  await win.keyboard.type('second')
  await expect(bar().getByRole('textbox')).toHaveValue('second')
  await win.keyboard.press('Escape')
  await win.getByTestId('pane-p1').click()
  await win.keyboard.press('Meta+f')
  await expect(bar()).toBeVisible()
  await win.keyboard.press('Meta+t') // 새 탭 — 막대의 pane 이 숨는다
  await expect(win.getByTestId('tab')).toHaveCount(2)
  await expect(bar()).toHaveCount(0)
})
