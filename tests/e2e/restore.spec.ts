import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstWindow, seedState, taskJson } from './helpers'

// 13단계: 재시작 복원 — 같은 임시 userData 로 앱을 실제로 껐다 켠다.
let userData: string
let work: string
let app: ElectronApplication
let launched: ElectronApplication | undefined
let win: Page

test.beforeEach(() => {
  userData = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-e2e-')))
  work = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-cwd-')))
  launched = undefined
})
test.afterEach(async () => {
  await launched?.close()
  rmSync(userData, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
})

async function launch(env: Record<string, string> = {}): Promise<void> {
  app = launched = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: userData, ...env } })
  win = await firstWindow(app)
}
async function quit(): Promise<void> {
  await app.close()
  launched = undefined
}

const pane = (id: string) => win.getByTestId(`pane-${id}`)
const screen = (id: string) => pane(id).locator('.xterm-rows')
async function run(id: string, command: string): Promise<void> {
  await pane(id).click()
  await win.keyboard.type(command)
  await win.keyboard.press('Enter')
}
const scrollDir = () => join(userData, 'scrollback')
const scrollFiles = () => (existsSync(scrollDir()) ? readdirSync(scrollDir()).sort() : [])
const savedState = () => JSON.parse(readFileSync(join(userData, 'state.json'), 'utf8'))
const count = (text: string, word: string) => text.split(word).length - 1

test('cd 한 폴더 · 이전 출력 · 탭 이름이 재시작 뒤에도 그대로, 이전 세션 줄이 보인다', async () => {
  const folder = join(work, '한글 폴더')
  mkdirSync(folder)
  seedState(userData, [{ id: 't', name: '복원', paneId: 'p1' }])
  await launch()
  await run('p1', `cd '${folder}' && echo MARK$((40+2))`)
  await expect(screen('p1')).toContainText('MARK42')
  await expect(win.getByTestId('tab').first()).toContainText('한글 폴더') // 탭 이름이 cd 를 따라간다
  await expect.poll(() => savedState().tasks[0].panes.p1.cwd).toBe(folder)
  await quit()

  expect(scrollFiles()).toEqual(['p1.txt'])
  expect(statSync(join(scrollDir(), 'p1.txt')).mode & 0o777).toBe(0o600)
  await launch()
  await expect(screen('p1')).toContainText('MARK42')
  await expect(screen('p1')).toContainText('── 이전 세션')
  await run('p1', 'echo "PWD=$PWD"')
  await expect(screen('p1')).toContainText(`PWD=${folder}`)
  await win.screenshot({ path: 'test-results/restore-after-restart.png' })
})

test('셸 통합이 꺼져 있어도 lsof 로 폴더를 따라가 재시작 뒤 같은 폴더', async () => {
  seedState(userData, [{ id: 't', name: '통합 없음', paneId: 'p1' }], [], { shellIntegration: false })
  await launch({ TASKMINAL_CWD_POLL_MS: '300' })
  await run('p1', `cd '${work}' && echo MOVED$((1+1))`)
  await expect(screen('p1')).toContainText('MOVED2')
  await expect.poll(() => savedState().tasks[0].panes.p1.cwd, { timeout: 10_000 }).toBe(work)
  await quit()

  await launch({ TASKMINAL_CWD_POLL_MS: '300' })
  await run('p1', 'echo "PWD=$PWD"')
  await expect(screen('p1')).toContainText(`PWD=${work}`)
})

test('새로 고침해도 이전 출력이 보이고, 한 화면에 두 번 되살아나지 않는다', async () => {
  seedState(userData, [{ id: 't', name: '새로 고침', paneId: 'p1' }])
  await launch()
  await run('p1', 'echo ONCE$((3+4))')
  await expect(screen('p1')).toContainText('ONCE7')
  await win.reload()
  await expect(screen('p1')).toContainText('── 이전 세션')
  await expect(screen('p1')).toContainText('ONCE7')
  await run('p1', 'echo AFTER$((1+1))')
  await expect(screen('p1')).toContainText('AFTER2')
  expect(count(await screen('p1').innerText(), 'ONCE7')).toBe(1)
  expect(count(await screen('p1').innerText(), '── 이전 세션')).toBe(1)
})

test('설정에서 끄면 저장된 스크롤을 모두 지우고 되살리지 않는다', async () => {
  seedState(userData, [{ id: 't', name: '끄기', paneId: 'p1' }])
  await launch()
  await run('p1', 'echo SECRET$((5+5))')
  await expect(screen('p1')).toContainText('SECRET10')
  await quit()
  expect(scrollFiles()).toEqual(['p1.txt'])

  const s = savedState()
  s.settings.restoreScrollback = false
  writeFileSync(join(userData, 'state.json'), JSON.stringify(s))
  await launch()
  await run('p1', 'echo NEW$((1+1))')
  await expect(screen('p1')).toContainText('NEW2')
  await expect(screen('p1')).not.toContainText('SECRET10')
  await expect.poll(scrollFiles).toEqual([])
  await quit()
  expect(scrollFiles()).toEqual([])
})

test('닫은 탭의 파일은 지우고, 이번에 안 본 탭의 파일은 남았다가 그 탭을 열면 되살아난다', async () => {
  const t = taskJson({ id: 't', name: '탭 둘', paneId: 'pa' })
  t.tabs.push({ id: 't-tab2', layout: { type: 'pane', paneId: 'pb' }, activePaneId: 'pb' })
  ;(t.panes as Record<string, unknown>)['pb'] = { id: 'pb', cwd: '~' }
  seedState(userData, [])
  const state = JSON.parse(readFileSync(join(userData, 'state.json'), 'utf8'))
  state.tasks = [t]
  state.activeTaskId = 't'
  writeFileSync(join(userData, 'state.json'), JSON.stringify(state))

  await launch()
  await run('pa', 'echo AAA$((1+1))')
  await expect(screen('pa')).toContainText('AAA2')
  await win.getByTestId('tab').nth(1).getByRole('tab').click()
  await run('pb', 'echo BBB$((1+1))')
  await expect(screen('pb')).toContainText('BBB2')
  await quit()
  expect(scrollFiles()).toEqual(['pa.txt', 'pb.txt'])

  // 둘째 실행: 마지막에 본 탭(pb)으로 열린다 — pa 는 이번에 안 봤다. pb 탭을 닫는다
  await launch()
  await expect(screen('pb')).toContainText('BBB2')
  await expect(pane('pa')).toHaveCount(0)
  await win.getByRole('button', { name: /탭 닫기/ }).nth(1).click()
  await expect(win.getByTestId('tab')).toHaveCount(1)
  await quit()
  expect(scrollFiles()).toEqual(['pa.txt'])

  await launch()
  await expect(screen('pa')).toContainText('AAA2')
})

test('전체 화면 프로그램(less)을 띄운 채 꺼도 되살린 화면은 일반 화면', async () => {
  seedState(userData, [{ id: 't', name: 'less', paneId: 'p1' }])
  await launch()
  await run('p1', 'seq $((70000+1)) 70050 | less')
  await expect(screen('p1')).toContainText('70001')
  await quit()

  await launch()
  await expect(screen('p1')).toContainText('── 이전 세션')
  await expect(screen('p1')).toContainText('70050 | less') // 일반 화면에 남은 명령 줄
  await expect(screen('p1')).not.toContainText('70001')
  await win.screenshot({ path: 'test-results/restore-less.png' })
})
