import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureWindow, firstWindow, seedState, waitLoaded } from './helpers'

test('320 CSS px·200% 설정은 본문 폭을 지키며 모든 칸·찾기·돌아가기·닫기에 도달한다', async () => {
  const data = mkdtempSync(join(tmpdir(), 'taskminal-settings-reflow-'))
  seedState(data, [{ id: 'task', name: '설정 확인', paneId: 'pane', cwd: data }])
  const app = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: data } })
  try {
    const win = await firstWindow(app)
    await waitLoaded(win)
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]!; window.setSize(640, 400); window.webContents.setZoomFactor(2) })
    const open = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('app:command', 'settings'))
    await open()
    const settings = win.getByTestId('settings')
    await expect(settings).toBeVisible()
    await expect.poll(() => win.evaluate(() => {
      const body = document.querySelector<HTMLElement>('.settings-body')!, heading = body.querySelector('h1')!.getBoundingClientRect()
      return body.clientWidth >= innerWidth * .85 && body.clientHeight >= innerHeight * .55 && heading.width >= 240 && body.scrollWidth <= body.clientWidth + 1
    })).toBe(true)
    mkdirSync('test-results/settings-reflow', { recursive: true })
    await win.evaluate(() => { document.documentElement.dataset.theme = 'light' })
    await captureWindow(app, 'test-results/settings-reflow/settings-320-css-light.png')
    await win.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
    const navigation = settings.getByRole('combobox', { name: '설정 칸 선택' })
    await expect(navigation.locator('option')).toHaveCount(10)
    for (const [id, title] of [['general', '일반'], ['tasks', '일감 관리'], ['look', '모양'], ['term', '터미널'], ['keys', '단축키'], ['notify', '알림 · 활동'], ['host', '셸 지킴이'], ['privacy', '개인정보'], ['backup', '백업 · 되돌리기'], ['about', '정보']]) {
      await navigation.selectOption(id)
      await expect(settings.getByRole('heading', { level: 1 })).toHaveText(title)
    }
    await settings.getByRole('button', { name: '설정 찾기 열기', exact: true }).click()
    const search = settings.getByRole('searchbox', { name: '설정 찾기' })
    await expect(search).toBeFocused()
    await search.fill('커서')
    await expect(settings.getByTestId('setting-row')).toHaveCount(2)
    await search.press('Escape'); await expect(search).toHaveValue(''); await expect(settings).toBeVisible()
    await navigation.selectOption('general')
    await captureWindow(app, 'test-results/settings-reflow/settings-320-css-search.png')
    await settings.getByRole('button', { name: '설정 닫기', exact: true }).click()
    await expect(settings).toHaveCount(0)
    await open()
    await settings.getByRole('button', { name: '일감으로 돌아가기', exact: true }).click()
    await expect(settings).toHaveCount(0)
    await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0]!;w.webContents.setZoomFactor(1);w.setSize(1200,800)})
    await expect.poll(()=>win.evaluate(()=>innerWidth)).toBeGreaterThan(700)
    await open()
    await expect(settings.getByRole('button',{name:'설정 닫기',exact:true})).toHaveCount(1)
    await expect(settings.getByRole('combobox',{name:'설정 칸 선택'})).toHaveCount(0)
    await expect(settings.getByRole('searchbox',{name:'설정 찾기'})).toBeFocused()
    await settings.getByRole('button',{name:'설정 닫기',exact:true}).click()
    await expect(settings).toHaveCount(0)
  } finally { await app.close(); rmSync(data, { recursive: true, force: true, maxRetries: 5 }) }
})
