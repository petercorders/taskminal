import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { firstWindow, seedState, waitLoaded } from './helpers'

let data: string, app: ElectronApplication, win: Page
const workflow = { id: 'wf', name: '원본 흐름', steps: [{ id: 'one', name: '점검', agent: 'claude', prompt: 'never sent', after: [] }] }
const schedule = { id: 'sched', name: '원본 예약', taskId: 'task', workflowId: 'wf', enabled: true, timing: { kind: 'interval', minutes: 10080 }, nextAt: Date.now() + 600_000, history: [] }
async function command(value: string) { await app.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0]!.webContents.send('app:command', value), value) }

test.beforeEach(async () => {
  data = mkdtempSync(join(tmpdir(), 'tm-panel-origin-'))
  seedState(data, [{ id: 'task', name: '일감', paneId: 'shell', cwd: data }, { id: 'other', name: '다른 일감', paneId: 'other-shell', cwd: data }])
  mkdirSync(join(data, 'workflows')); writeFileSync(join(data, 'workflows/journal.json'), JSON.stringify({ templates: [workflow], runs: [] }))
  mkdirSync(join(data, 'schedules')); writeFileSync(join(data, 'schedules/journal.json'), JSON.stringify({ schedules: [schedule], requests: [] }))
  app = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: data, TASKMINAL_CLAUDE_BIN: resolve('tests/fixtures/fake-claude.mjs') } })
  win = await firstWindow(app); await waitLoaded(win)
})
test.afterEach(async () => { await app?.close(); rmSync(data, { recursive: true, force: true, maxRetries: 5 }) })

test('캐시된 기존 흐름을 다른 화면에서 삭제하면 저장으로 되살리지 않는다', async () => {
  await command('workflows')
  const panel = win.getByRole('region', { name: '작업 흐름', exact: true })
  await panel.getByRole('combobox', { name: '저장된 작업 흐름' }).selectOption('wf')
  await panel.getByRole('button', { name: '편집', exact: true }).click()
  await panel.getByRole('textbox', { name: '흐름 이름', exact: true }).fill('보존할 편집 초안')
  await win.getByRole('button', { name: '작업 보조 화면 닫기' }).click()
  await win.evaluate(() => window.taskminal.workflows.remove('wf'))
  await command('workflows')
  await expect(panel.getByRole('textbox', { name: '흐름 이름', exact: true })).toHaveValue('보존할 편집 초안')
  await panel.getByRole('button', { name: '저장', exact: true }).click()
  await expect(panel.getByRole('alert')).toContainText('삭제되었습니다')
  expect((await win.evaluate(() => window.taskminal.workflows.view())).templates).toHaveLength(0)
  await expect(panel.getByRole('textbox', { name: '흐름 이름', exact: true })).toHaveValue('보존할 편집 초안')
})

test('캐시된 활성 예약이 삭제되면 저장으로 다시 예약하지 않는다', async () => {
  await command('schedules')
  const panel = win.getByRole('region', { name: '예약과 결과함', exact: true })
  await panel.getByRole('article', { name: '원본 예약' }).getByRole('button', { name: '편집', exact: true }).click()
  await panel.getByRole('textbox', { name: '예약 이름' }).fill('보존할 예약 초안')
  await win.getByRole('button', { name: '작업 보조 화면 닫기' }).click()
  await win.evaluate(() => window.taskminal.schedules.remove('sched'))
  await command('schedules')
  await expect(panel.getByRole('textbox', { name: '예약 이름' })).toHaveValue('보존할 예약 초안')
  await panel.getByRole('button', { name: '저장', exact: true }).click()
  await expect(panel.getByRole('alert')).toContainText('삭제되었습니다')
  expect((await win.evaluate(() => window.taskminal.schedules.view())).schedules).toHaveLength(0)
  await expect(panel.getByRole('textbox', { name: '예약 이름' })).toHaveValue('보존할 예약 초안')
})

test('최신 대상 조회를 기다리다 일감이 바뀌면 과거 편집을 저장하지 않는다', async () => {
  await command('workflows')
  const panel = win.getByRole('region', { name: '작업 흐름', exact: true })
  await panel.getByRole('combobox', { name: '저장된 작업 흐름' }).selectOption('wf')
  await panel.getByRole('button', { name: '편집', exact: true }).click()
  await panel.getByRole('textbox', { name: '흐름 이름', exact: true }).fill('보내면 안 되는 변경')
  await app.evaluate(({ ipcMain }) => {
    const pending = globalThis as unknown as { originReads: Array<(value: unknown) => void> }
    pending.originReads = []
    ipcMain.removeHandler('workflows:view')
    ipcMain.handle('workflows:view', () => new Promise(resolve => pending.originReads.push(resolve)))
  })
  await panel.getByRole('button', { name: '저장', exact: true }).click()
  await expect.poll(() => app.evaluate(() => (globalThis as unknown as { originReads: unknown[] }).originReads.length)).toBeGreaterThan(0)
  await win.getByTestId('task-row').filter({ has: win.getByText('다른 일감', { exact: true }) }).click()
  await app.evaluate(({ ipcMain }, value) => {
    for (const resolve of (globalThis as unknown as { originReads: Array<(value: unknown) => void> }).originReads) resolve(value)
    ipcMain.removeHandler('workflows:view')
    ipcMain.handle('workflows:view', () => value)
  }, { templates: [workflow], runs: [] })
  await win.getByTestId('task-row').filter({ has: win.getByText('일감', { exact: true }) }).click()
  await command('workflows')
  await expect(panel.getByRole('textbox', { name: '흐름 이름', exact: true })).toHaveValue('보내면 안 되는 변경')
  await expect(panel.getByRole('button', { name: '저장', exact: true })).toBeEnabled()
  expect(readFileSync(join(data, 'workflows/journal.json'), 'utf8')).not.toContain('보내면 안 되는 변경')
})
