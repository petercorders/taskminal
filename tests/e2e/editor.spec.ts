import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureWindow, firstWindow, seedState, waitLoaded } from './helpers'

let dir: string, app: ElectronApplication, win: Page
async function edit(name = 'example.txt') {
  await win.getByRole('button', { name, exact: true }).click()
  await win.getByRole('button', { name: '편집', exact: true }).click()
  await expect(win.getByRole('textbox', { name: '파일 편집 내용', exact: true })).toBeEnabled()
}
test.beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-editor-')))
  writeFileSync(join(dir, 'example.txt'), 'original INTERNAL-ABCDEF\nsecond line')
  writeFileSync(join(dir, 'other.txt'), 'other file')
  seedState(dir, [{ id: 't', name: '편집 검증', paneId: 'p', cwd: dir }], [], { secretCustom: [{ name: '내부값', pattern: 'INTERNAL-[A-Z]{6}' }] })
  app = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: dir } })
  win = await firstWindow(app)
  await waitLoaded(win)
  await win.getByRole('button', { name: '파일 탐색', exact: true }).click()
})
test.afterEach(async () => {
  await app?.close()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
})
test('가린 미리보기와 별도 원문 편집을 사용하고 키보드 저장으로 실제 파일을 바꾼다', async () => {
  await win.getByRole('button', { name: 'example.txt', exact: true }).click()
  await expect(win.locator('.work-source')).not.toContainText('INTERNAL-ABCDEF')
  await expect(win.locator('.work-source')).toContainText('가림')
  await win.getByRole('button', { name: '편집', exact: true }).click()
  const input = win.getByRole('textbox', { name: '파일 편집 내용', exact: true })
  await expect(input).toHaveValue('original INTERNAL-ABCDEF\nsecond line')
  await expect(input).toBeFocused()
  await input.fill('edited INTERNAL-ABCDEF\nsecond line')
  await captureWindow(app, '/tmp/taskminal-44-editor-wide.png')
  await input.press('ControlOrMeta+s')
  await expect.poll(() => readFileSync(join(dir, 'example.txt'), 'utf8')).toBe('edited INTERNAL-ABCDEF\nsecond line')
  await expect(win.getByRole('button', { name: '저장', exact: true })).toBeDisabled()
  await win.getByRole('button', { name: '미리보기로 돌아가기' }).click()
  await expect(win.locator('.work-source')).toContainText('edited')
  await expect(win.locator('.work-source')).not.toContainText('INTERNAL-ABCDEF')
})
test('파일 이동·뒤로·패널 닫기는 미저장 초안을 보존하고 명시적 버리기로만 되돌린다', async () => {
  await edit()
  await win.getByRole('textbox', { name: '파일 편집 내용', exact: true }).fill('my draft')
  await edit('other.txt')
  await edit()
  await expect(win.getByRole('textbox', { name: '파일 편집 내용', exact: true })).toHaveValue('my draft')
  await win.getByRole('button', { name: '미리보기로 돌아가기' }).click()
  await win.getByRole('button', { name: '편집', exact: true }).click()
  await expect(win.getByRole('textbox', { name: '파일 편집 내용', exact: true })).toHaveValue('my draft')
  await win.getByRole('button', { name: '작업 보조 화면 닫기' }).click()
  await win.getByRole('button', { name: '파일 탐색', exact: true }).click()
  await edit()
  await expect(win.getByRole('textbox', { name: '파일 편집 내용', exact: true })).toHaveValue('my draft')
  expect(readFileSync(join(dir, 'example.txt'), 'utf8')).toBe('original INTERNAL-ABCDEF\nsecond line')
  await win.getByRole('button', { name: '초안 버리고 되돌리기' }).click()
  await expect(win.getByRole('textbox', { name: '파일 편집 내용', exact: true })).toHaveValue('original INTERNAL-ABCDEF\nsecond line')
})
test('저장 직전 외부 변경은 초안을 보존하고 최신 비교·명시적 준비 뒤에만 저장한다', async () => {
  await edit()
  const input = win.getByRole('textbox', { name: '파일 편집 내용', exact: true })
  await input.fill('my draft')
  writeFileSync(join(dir, 'example.txt'), 'external change')
  await win.getByRole('button', { name: '저장', exact: true }).click()
  await expect(win.getByRole('alert')).toContainText('파일이 바뀌어 저장하지 않았어요')
  await expect(input).toHaveValue('my draft')
  await expect(win.getByRole('textbox', { name: '디스크 최신 내용', exact: true })).toHaveValue('external change')
  expect(readFileSync(join(dir, 'example.txt'), 'utf8')).toBe('external change')
  await expect(win.getByRole('button', { name: '저장', exact: true })).toBeDisabled()
  await win.getByRole('button', { name: '다시 읽기', exact: true }).click()
  await expect(input).toHaveValue('my draft')
  await win.getByRole('button', { name: '내 초안을 최신 파일 위에 저장하도록 준비', exact: true }).click()
  expect(readFileSync(join(dir, 'example.txt'), 'utf8')).toBe('external change')
  await win.getByRole('button', { name: '저장', exact: true }).click()
  await expect.poll(() => readFileSync(join(dir, 'example.txt'), 'utf8')).toBe('my draft')
})
test('다시 읽기는 초안을 유지하고 최신 내용을 명시적으로 선택할 수 있다', async () => {
  await edit()
  const input = win.getByRole('textbox', { name: '파일 편집 내용', exact: true })
  await input.fill('my draft')
  writeFileSync(join(dir, 'example.txt'), 'new disk text')
  await win.getByRole('button', { name: '다시 읽기', exact: true }).click()
  await expect(win.getByRole('textbox', { name: '디스크 최신 내용', exact: true })).toHaveValue('new disk text')
  await expect(input).toHaveValue('my draft')
  await win.getByRole('button', { name: '초안 버리고 최신 내용 사용', exact: true }).click()
  await expect(input).toHaveValue('new disk text')
  await expect(win.getByRole('button', { name: '저장', exact: true })).toBeDisabled()
})
test('좁은 라이트 200%에서 편집·충돌 선택이 창 안에 있고 키보드로 돌아간다', async () => {
  await edit()
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]!
    window.setSize(640, 520)
    window.webContents.setZoomFactor(2)
  })
  await win.evaluate(() => { document.documentElement.dataset.theme = 'light' })
  await expect.poll(() => win.evaluate(() => innerWidth)).toBe(320)
  const input = win.getByRole('textbox', { name: '파일 편집 내용', exact: true })
  await input.fill('draft')
  writeFileSync(join(dir, 'example.txt'), 'external')
  await win.getByRole('button', { name: '저장', exact: true }).click()
  await expect(win.getByRole('textbox', { name: '디스크 최신 내용', exact: true })).toHaveValue('external')
  for (const element of [input, win.getByRole('button', { name: '내 초안을 최신 파일 위에 저장하도록 준비', exact: true })]) {
    const box = await element.boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(await win.evaluate(() => innerWidth))
  }
  mkdirSync('test-results/editor', { recursive: true })
  await captureWindow(app, 'test-results/editor/light-compact-200.png')
  await captureWindow(app, '/tmp/taskminal-44-editor-small.png')
  await win.getByRole('button', { name: '미리보기로 돌아가기' }).focus()
  await win.keyboard.press('Enter')
  await expect(win.getByTestId('workspace-editor')).toHaveCount(0)
})
test('저장 중 새 입력과 다른 파일 이동에도 클릭 당시 내용만 저장하고 늦은 응답은 원래 초안만 갱신한다', async () => {
  // Gate the real main handler so this tests actual filesystem writes while
  // deterministically exercising renderer typing/navigation during its reply.
  await app.evaluate(({ ipcMain }) => {
    const ipc = ipcMain as unknown as {
      _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>>
      editorRelease?: () => void
      editorStarted?: boolean
    }
    const original = ipc._invokeHandlers.get('workspace:save')!
    if (!original) throw new Error('workspace:save handler missing')
    const gate = new Promise<void>((resolve) => { ipc.editorRelease = resolve })
    ipcMain.removeHandler('workspace:save')
    ipcMain.handle('workspace:save', async (...args) => {
      ipc.editorStarted = true
      await gate
      return original(...args)
    })
  })
  await edit()
  const input = win.getByRole('textbox', { name: '파일 편집 내용', exact: true })
  await input.fill('save snapshot')
  await win.getByRole('button', { name: '저장', exact: true }).click()
  await expect.poll(() => app.evaluate(({ ipcMain }) => (ipcMain as unknown as { editorStarted?: boolean }).editorStarted)).toBe(true)
  await input.fill('typed after save')
  await edit('other.txt')
  await win.getByRole('textbox', { name: '파일 편집 내용', exact: true }).fill('other draft')
  await app.evaluate(({ ipcMain }) => (ipcMain as unknown as { editorRelease(): void }).editorRelease())
  await expect.poll(() => readFileSync(join(dir, 'example.txt'), 'utf8')).toBe('save snapshot')
  await expect(win.getByRole('textbox', { name: '파일 편집 내용', exact: true })).toHaveValue('other draft')
  await edit()
  await expect(input).toHaveValue('typed after save')
  await expect(win.getByRole('button', { name: '저장', exact: true })).toBeEnabled()
  await win.getByRole('button', { name: '저장', exact: true }).click()
  await expect.poll(() => readFileSync(join(dir, 'example.txt'), 'utf8')).toBe('typed after save')
})
test('저장 응답이 유실되면 초안을 유지하고 다시 읽기 전 재전송하지 않는다', async () => {
  await app.evaluate(({ ipcMain }) => {
    const ipc = ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>>; editorSaveCalls?: number }
    const original = ipc._invokeHandlers.get('workspace:save')!
    ipc.editorSaveCalls = 0
    ipcMain.removeHandler('workspace:save')
    ipcMain.handle('workspace:save', async (...args) => {
      ipc.editorSaveCalls!++
      await original(...args)
      throw new Error('injected lost reply')
    })
  })
  await edit()
  const input = win.getByRole('textbox', { name: '파일 편집 내용', exact: true })
  await input.fill('saved without reply')
  await win.getByRole('button', { name: '저장', exact: true }).click()
  await expect(win.getByRole('alert')).toContainText('저장 결과를 확인하지 못했어요')
  await expect(input).toHaveValue('saved without reply')
  await expect(win.getByRole('button', { name: '저장', exact: true })).toBeDisabled()
  await input.press('ControlOrMeta+s')
  expect(await app.evaluate(({ ipcMain }) => (ipcMain as unknown as { editorSaveCalls: number }).editorSaveCalls)).toBe(1)
  expect(readFileSync(join(dir, 'example.txt'), 'utf8')).toBe('saved without reply')
  await win.getByRole('button', { name: '다시 읽기', exact: true }).click()
  await expect(win.getByRole('textbox', { name: '디스크 최신 내용', exact: true })).toHaveValue('saved without reply')
  await win.getByRole('button', { name: '초안 버리고 최신 내용 사용', exact: true }).click()
  await expect(input).toHaveValue('saved without reply')
  await expect(win.getByRole('button', { name: '저장', exact: true })).toBeDisabled()
})
