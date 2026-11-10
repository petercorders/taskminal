import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstWindow, seedState, taskJson } from './helpers'

// 15e: 보이는 pane 만 WebGL — 이 파일만 TASKMINAL_RENDERER=webgl (playwright 설정 기본은 dom)
let userData: string
let app: ElectronApplication
let win: Page

test.beforeEach(async () => {
  userData = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-e2e-')))
  const t = taskJson({ id: 't', name: 'WebGL', paneId: 'pa' })
  t.tabs.push({ id: 't-tab2', layout: { type: 'pane', paneId: 'pb' }, activePaneId: 'pb' })
  ;(t.panes as Record<string, unknown>)['pb'] = { id: 'pb', cwd: '~' }
  seedState(userData, [])
  const state = JSON.parse(readFileSync(join(userData, 'state.json'), 'utf8'))
  state.tasks = [t]
  state.activeTaskId = 't'
  writeFileSync(join(userData, 'state.json'), JSON.stringify(state))
  app = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: userData, TASKMINAL_RENDERER: 'webgl' } })
  win = await firstWindow(app)
})
test.afterEach(async () => {
  await app.close()
  rmSync(userData, { recursive: true, force: true })
})

const host = (id: string) => win.getByTestId(`pane-${id}`)

test('보이는 pane 은 WebGL(canvas), 다른 탭으로 가면 놓고 DOM, 돌아오면 다시 WebGL', async () => {
  await expect(host('pa')).toHaveAttribute('data-renderer', 'webgl')
  await expect(host('pa').locator('canvas').first()).toBeAttached()
  await win.getByTestId('tab').nth(1).getByRole('tab').click()
  await expect(host('pb')).toHaveAttribute('data-renderer', 'webgl')
  await expect(host('pa')).toHaveAttribute('data-renderer', 'dom')
  await win.getByTestId('tab').nth(0).getByRole('tab').click()
  await expect(host('pa')).toHaveAttribute('data-renderer', 'webgl')
  await win.screenshot({ path: 'test-results/webgl.png' })
})

test('WebGL 로 그려도 입력 · 출력이 된다 (화면 글은 canvas 라 셸 쪽 결과 파일로 확인)', async () => {
  const out = join(userData, 'typed.txt')
  await host('pa').click()
  await win.keyboard.type(`echo WEBGL$((2+2)) > '${out}'`)
  await win.keyboard.press('Enter')
  await expect.poll(() => {
    try {
      return readFileSync(out, 'utf8').trim()
    } catch {
      return ''
    }
  }).toBe('WEBGL4')
})
