import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstWindow, seedState, taskJson, waitLoaded } from './helpers'

let userData: string
let app: ElectronApplication
let win: Page
test.beforeEach(() => {
  userData = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-e2e-')))
})
test.afterEach(async () => {
  await app?.close()
  rmSync(userData, { recursive: true, force: true, maxRetries: 5 })
})
async function launch(count = 1) {
  seedState(userData, [{ id: 'live', name: 'Live', paneId: 'plive' }])
  const state = JSON.parse(readFileSync(join(userData, 'state.json'), 'utf8'))
  for (let i = 0; i < count; i++) state.tasks.push({ ...taskJson({ id: `a${i}`, name: `Archive ${i}`, paneId: `pa${i}` }), archivedAt: Date.now() - i })
  writeFileSync(join(userData, 'state.json'), JSON.stringify(state))
  app = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: userData } })
  win = await firstWindow(app)
  await waitLoaded(win)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('app:command', 'archive-open'))
  await expect(win.getByTestId('archive-panel')).toBeVisible()
}

test('보관함 버튼 Enter는 탭 전환·삭제를 실행하고 체크박스 Space는 포커스된 항목만 고른다', async () => {
  await launch(2)
  const panel = win.getByTestId('archive-panel')
  const check = panel.getByLabel('Archive 1 고르기')
  await check.focus()
  await win.keyboard.press('Space')
  await expect(check).toBeChecked()
  await expect(panel.getByLabel('Archive 0 고르기')).not.toBeChecked()
  await panel.getByTestId('archive-deleted-tab').focus()
  await win.keyboard.press('Enter')
  await expect(panel.getByTestId('archive-deleted-tab')).toHaveAttribute('aria-selected', 'true')
  await panel.getByRole('tab', { name: '보관한 일감 2' }).click()
  await panel.getByRole('button', { name: 'Archive 1 지우기' }).focus()
  await win.keyboard.press('Enter')
  await expect(win.getByRole('alertdialog')).toContainText('Archive 1')
})

test('보관함 긴 목록의 방향키 선택은 화면 안에 있고 검색을 줄이면 첫 행으로 돌아온다', async () => {
  await launch(40)
  const panel = win.getByTestId('archive-panel')
  const search = panel.getByLabel('보관함에서 찾기')
  for (let i = 0; i < 35; i++) await win.keyboard.press('ArrowDown')
  const selected = panel.locator('[role="option"][aria-selected="true"]')
  await expect(selected).toHaveAttribute('data-task-name', 'Archive 35')
  await expect.poll(() => selected.evaluate((el) => {
    const row = el.getBoundingClientRect()
    const list = el.parentElement!.getBoundingClientRect()
    // scrollTop은 정수지만 행 높이는 소수 px일 수 있다.
    return row.top >= list.top - 1 && row.bottom <= list.bottom + 1
  })).toBe(true)
  await search.fill('Archive 39')
  await expect(selected).toHaveAttribute('data-task-name', 'Archive 39')
})

test('최근 지운 것 목록 읽기 실패는 빈 결과와 구분하고 다시 시도할 수 있다', async () => {
  await launch()
  await app.evaluate(({ ipcMain }) => {
    let tries = 0
    ipcMain.removeHandler('backup:list')
    ipcMain.handle('backup:list', () => {
      if (++tries === 1) throw new Error('test list unavailable')
      return []
    })
  })
  const panel = win.getByTestId('archive-panel')
  await panel.getByTestId('archive-deleted-tab').click()
  await expect(panel.getByRole('alert')).toContainText('백업 목록을 읽지 못했어요')
  await expect(panel).not.toContainText('30일 안에 지운 일감이 없어요')
  await panel.getByRole('button', { name: '다시 시도' }).click()
  await expect(panel).toContainText('30일 안에 지운 일감이 없어요')
  await expect(panel.getByRole('alert')).toHaveCount(0)
})

test('최근 지운 것 일부 백업 오류는 읽힌 일감을 유지하고 재시도로 회복한다', async () => {
  await launch()
  const snapshot = JSON.parse(readFileSync(join(userData, 'state.json'), 'utf8'))
  snapshot.tasks.push(taskJson({ id: 'gone', name: 'Gone', paneId: 'pgone' }))
  await app.evaluate(({ ipcMain }, snap) => {
    let failed = true
    ipcMain.removeHandler('backup:list')
    ipcMain.removeHandler('backup:read')
    ipcMain.handle('backup:list', () => ['good', 'bad'].map((name) => ({ name, at: Date.now() })))
    ipcMain.handle('backup:read', (_event, name) => {
      if (name === 'bad' && failed) {
        failed = false
        throw new Error('test read unavailable')
      }
      return snap
    })
  }, snapshot)
  const panel = win.getByTestId('archive-panel')
  await panel.getByTestId('archive-deleted-tab').click()
  await expect(panel.getByTestId('deleted-row')).toHaveAttribute('data-task-name', 'Gone')
  await expect(panel.getByRole('alert')).toContainText('백업 1개를 읽지 못했어요')
  await panel.getByRole('button', { name: '다시 시도' }).click()
  await expect(panel.getByRole('alert')).toHaveCount(0)
  await expect(panel.getByTestId('deleted-row')).toHaveCount(1)
})

test('최근 지운 것에서 나가면 늦은 목록 응답은 백업 파일을 읽지 않고 다시 열 때 새로 읽는다', async () => {
  await launch()
  await app.evaluate(({ ipcMain }) => {
    let calls = 0
    let reads = 0
    ipcMain.removeHandler('backup:list')
    ipcMain.removeHandler('backup:read')
    ipcMain.handle('backup:list', () => {
      calls++
      if (calls !== 1) return []
      return new Promise((resolve) => ipcMain.once('test:release-backup-list', () => resolve([{ name: 'old', at: Date.now() }])))
    })
    ipcMain.handle('backup:read', () => { reads++; throw new Error('must not read stale list') })
    ipcMain.on('test:backup-counts', (_event, result: { calls: number; reads: number }) => { Object.assign(result, { calls, reads }) })
  })
  const panel = win.getByTestId('archive-panel')
  await panel.getByTestId('archive-deleted-tab').click()
  await expect(panel.getByRole('status')).toHaveText('읽는 중…')
  await panel.getByRole('tab', { name: '보관한 일감 1' }).click()
  await app.evaluate(({ ipcMain }) => { ipcMain.emit('test:release-backup-list') })
  await win.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
  const counts = () => app.evaluate(({ ipcMain }) => {
    const result = { calls: 0, reads: 0 }
    ipcMain.emit('test:backup-counts', null, result)
    return result
  })
  expect(await counts()).toEqual({ calls: 1, reads: 0 })
  await panel.getByTestId('archive-deleted-tab').click()
  await expect(panel).toContainText('30일 안에 지운 일감이 없어요')
  expect(await counts()).toEqual({ calls: 2, reads: 0 })
  await win.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
})
