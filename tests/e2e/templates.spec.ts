import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstWindow, seedState } from './helpers'

// 12단계: 템플릿 — 시작 명령은 pane 마다 한 번 · 탭 "▾" 로 템플릿 탭 · 탭/일감을 템플릿으로 저장 · JSON 편집(줄 번호 오류)
let userData: string
let launched: ElectronApplication | undefined
let app: ElectronApplication
let win: Page
let marks: string

async function launch() {
  app = launched = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: userData } })
  win = await firstWindow(app)
}
async function restart() {
  await launched!.close()
  launched = undefined
  await launch()
}

const marksTemplate = (file: string) => ({
  id: 'tpl-marks',
  name: '표시 둘',
  tabs: [{ title: '표시', layout: { split: 'right', a: { pane: { command: `echo a >> '${file}'` } }, b: { pane: { command: `echo b >> '${file}'` } } } }],
})

test.beforeEach(async ({}, info) => {
  userData = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-e2e-')))
  marks = join(userData, 'marks.txt')
  seedState(userData, [{ id: 'task-a', name: 'A 일감', paneId: 'pane-a', cwd: '/tmp' }], [], {
    templates: [{ id: 'tpl-basic', name: '기본', tabs: [{ layout: { pane: {} } }] }, marksTemplate(marks)],
    ...(info.title.includes('셸 통합을 끄면') ? { shellIntegration: false } : {}),
  })
  launched = undefined
  await launch()
  await expect(win.getByTestId('pane-pane-a')).toBeVisible()
})
test.afterEach(async () => {
  await launched?.close()
  rmSync(userData, { recursive: true, force: true })
})

const lines = () => (existsSync(marks) ? readFileSync(marks, 'utf8').split('\n').filter(Boolean).sort() : [])
const view = (name: string) => win.locator(`[data-testid="task-view"][data-task-name="${name}"]`)
const taskRow = (name: string) => win.locator(`[data-testid="task-row"][data-task-name="${name}"]`)
const savedState = () => JSON.parse(readFileSync(join(userData, 'state.json'), 'utf8'))

async function createFromTemplate(name: string, template: string) {
  await win.getByRole('button', { name: '새 일감' }).first().click()
  const dialog = win.getByRole('dialog', { name: '새 일감' })
  await dialog.getByLabel('이름').fill(name)
  await dialog.getByLabel('작업 폴더').fill('/tmp')
  await dialog.getByTestId('new-task-template').selectOption({ label: template })
  await dialog.getByRole('button', { name: /만들기/ }).click()
  await expect(view(name)).toBeVisible()
}
async function openTemplateMenu(task: string) {
  await view(task).getByRole('button', { name: '템플릿 탭' }).click()
  await expect(win.getByTestId('template-menu')).toBeVisible()
}

test('템플릿 일감: pane 마다 시작 명령이 한 번 — 오가고 껐다 켜도 다시 돌지 않는다', async () => {
  await createFromTemplate('표시 일감', '표시 둘')
  await expect(view('표시 일감').getByTestId('pane-slot')).toHaveCount(2)
  await expect.poll(lines, { timeout: 15_000 }).toEqual(['a', 'b'])
  // 보낸 명령은 저장 파일에서 지워진다(command 는 템플릿 저장용으로 남는다)
  await expect.poll(() => Object.values(savedState().tasks[1]?.panes ?? {}).map((p: any) => [p.command, p.pendingCommand ?? null]).sort()).toEqual([
    [`echo a >> '${marks}'`, null],
    [`echo b >> '${marks}'`, null],
  ])
  await win.screenshot({ path: 'test-results/templates-created.png' })

  await taskRow('A 일감').click()
  await taskRow('표시 일감').click()
  await restart()
  await expect(view('표시 일감').getByTestId('pane-slot')).toHaveCount(2)
  await expect(view('표시 일감').locator('.xterm-rows').first()).toContainText('%', { timeout: 15_000 })
  // 4초 대체 경로까지 지나도록 기다린 뒤에도 그대로
  await win.waitForTimeout(5_000)
  expect(lines()).toEqual(['a', 'b'])
})

test('셸 통합을 끄면 프롬프트 신호 없이도 시작 명령이 돈다', async () => {
  await createFromTemplate('표시 일감', '표시 둘')
  await expect.poll(lines, { timeout: 15_000 }).toEqual(['a', 'b'])
})

test('탭 줄 ▾: 템플릿의 탭을 이 일감에 붙이고 그 탭의 시작 명령이 돈다 · Esc 로 닫힘', async () => {
  await openTemplateMenu('A 일감')
  await win.screenshot({ path: 'test-results/templates-menu.png' })
  await win.keyboard.press('Escape')
  await expect(win.getByTestId('template-menu')).toHaveCount(0)

  await openTemplateMenu('A 일감')
  await win.getByRole('menuitem', { name: '표시 둘' }).click()
  await expect(view('A 일감').getByTestId('tab')).toHaveCount(2)
  await expect(view('A 일감').getByRole('tab', { selected: true })).toHaveText('표시')
  await expect(view('A 일감').getByTestId('pane-slot').filter({ visible: true })).toHaveCount(2)
  await expect.poll(lines, { timeout: 15_000 }).toEqual(['a', 'b'])
})

test('이 탭을 템플릿으로 저장 → 새 일감에서 같은 분할 · 저장을 두 번 눌러도 하나', async () => {
  await view('A 일감').getByRole('button', { name: '아래로 나누기' }).click()
  await expect(view('A 일감').getByTestId('pane-slot')).toHaveCount(2)
  await openTemplateMenu('A 일감')
  await win.getByRole('menuitem', { name: '이 탭을 템플릿으로 저장…' }).click()
  const dialog = win.getByRole('dialog', { name: '탭을 템플릿으로 저장' })
  await expect(dialog.getByTestId('template-name')).toBeFocused()
  await dialog.getByTestId('template-name').fill('위아래')
  await dialog.getByTestId('template-name-save').dblclick()
  await expect(dialog).toHaveCount(0)
  await expect.poll(() => savedState().settings.templates.map((t: any) => t.name)).toEqual(['기본', '표시 둘', '위아래'])
  expect(savedState().settings.templates[2].tabs[0].layout.split).toBe('down')

  await createFromTemplate('새 일감', '위아래')
  await expect(view('새 일감').getByTestId('pane-slot')).toHaveCount(2)
})

test('일감 우클릭 › 템플릿으로 저장 — 이름은 일감 이름으로 시작', async () => {
  await taskRow('A 일감').click({ button: 'right' })
  await win.getByTestId('task-menu').getByRole('menuitem', { name: '템플릿으로 저장…' }).click()
  const dialog = win.getByRole('dialog', { name: '일감을 템플릿으로 저장' })
  await expect(dialog.getByTestId('template-name')).toHaveValue('A 일감')
  await win.keyboard.press('Enter')
  await expect.poll(() => savedState().settings.templates.map((t: any) => t.name)).toContain('A 일감')
})

test('JSON 편집: 오류는 줄 번호와 함께 · 오류면 저장 막힘 · 고치면 저장 · 새 템플릿 · Esc 는 편집기만 닫는다', async () => {
  await win.keyboard.press('Meta+Comma')
  const settings = win.getByTestId('settings')
  await settings.getByRole('navigation', { name: '설정 칸' }).getByRole('button', { name: '일감 관리' }).click()
  await settings.getByRole('button', { name: '기본 JSON 편집' }).click()
  const editor = win.getByRole('dialog', { name: /템플릿 편집/ })
  const json = editor.getByTestId('template-json')
  await expect(json).toBeFocused()

  await json.fill('{\n  "name": "고친 기본"\n  "tabs": [{ "layout": { "pane": {} } }]\n}')
  await expect(editor.getByTestId('template-errors')).toContainText('3번째 줄')
  await expect(editor.getByTestId('template-save')).toBeDisabled()
  await json.fill('{\n  "name": "고친 기본",\n  "tabs": [{ "layout": { "pane": { "comand": "x" } } }]\n}')
  await expect(editor.getByTestId('template-errors')).toContainText('comand')
  await win.screenshot({ path: 'test-results/templates-editor-error.png' })

  await json.fill('{\n  "name": "고친 기본",\n  "tabs": [{ "layout": { "pane": { "command": "ls" } } }]\n}')
  await expect(editor.getByTestId('template-errors')).toBeEmpty()
  await win.keyboard.press('Meta+Enter')
  await expect(editor).toHaveCount(0)
  await expect(settings.getByTestId('template-item').first().getByLabel('템플릿 이름')).toHaveValue('고친 기본')
  await expect.poll(() => savedState().settings.templates[0]).toEqual({ id: 'tpl-basic', name: '고친 기본', tabs: [{ layout: { pane: { command: 'ls' } } }] })

  await settings.getByRole('button', { name: '+ 새 템플릿' }).click()
  await expect(win.getByRole('dialog', { name: '새 템플릿' })).toBeVisible()
  await win.keyboard.press('Escape')
  await expect(win.getByRole('dialog', { name: '새 템플릿' })).toHaveCount(0)
  await expect(settings).toBeVisible() // 설정 창은 그대로
  await settings.getByRole('button', { name: '+ 새 템플릿' }).click()
  await win.getByRole('dialog', { name: '새 템플릿' }).getByTestId('template-save').click()
  await expect(settings.getByTestId('template-item')).toHaveCount(3)
})
