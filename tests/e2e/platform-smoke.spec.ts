import { _electron as electron, expect, test } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { firstWindow, seedState, waitLoaded } from './helpers'

const APP = process.env['TASKMINAL_E2E_APP_PATH'] || ''
test.skip(process.env['TASKMINAL_E2E_PACKAGED'] !== '1' || !APP || !existsSync(APP), 'OS별 실제 패키지 빌드에서만 실행')

test('OS별 패키지: 한글 셸·CLI·렌더러 재연결·종료 뒤 지킴이 유지', async () => {
  test.setTimeout(90_000)
  const userData = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-platform-')))
  seedState(userData, [{ id: 't', name: 'OS 검증', paneId: 'p1', cwd: userData }])
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((pair): pair is [string, string] => typeof pair[1] === 'string')), TASKMINAL_USER_DATA: userData, TASKMINAL_RENDERER: 'dom', TASKMINAL_QUIT_NOTICE: 'seen', TASKMINAL_FIRST_RUN: 'seen' }
  delete env['ELECTRON_RUN_AS_NODE']
  if (process.platform === 'win32') {
    // 실제 계정 CLI를 찾지 못하게 PATH를 임시 npm shim과 Windows 시스템 도구로 한정한다.
    const bin = join(userData, 'npm'), pkg = join(bin, 'node_modules', '@openai', 'codex')
    mkdirSync(join(pkg, 'bin'), { recursive: true })
    writeFileSync(join(bin, 'codex.cmd'), '@echo off\r\nexit /b 99\r\n') // 실행되면 시험이 실패한다
    writeFileSync(join(pkg, 'package.json'), '{"type":"module"}')
    writeFileSync(join(pkg, 'bin', 'codex.js'), readFileSync('tests/fixtures/fake-codex.mjs', 'utf8'))
    delete env['Path']
    env['PATH'] = bin + ';' + join(env['SystemRoot'] || 'C:\\Windows', 'System32')
    delete env['TASKMINAL_CODEX_BIN']
  }
  const args: string[] = [] // 네이티브 CI에서 사용자 네임스페이스를 준비하며 샌드박스를 끄지 않는다.
  let app = await electron.launch({ executablePath: APP, env, args })
  let closed = false
  try {
    let win = await firstWindow(app)
    await waitLoaded(win)
    await expect.poll(() => win.evaluate(() => window.taskminal.host.view().then((v) => v.state)), { timeout: 20_000 }).toBe('connected')
    const expected = process.env['TASKMINAL_EXPECT_VERSION'] || (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version
    expect((await win.evaluate(() => window.taskminal.appInfo())).version).toBe(expected)
    const host = await win.evaluate(() => window.taskminal.host.view())
    await expect(win.getByTestId('pane-p1')).toBeVisible()
    const pane = win.getByTestId('pane-p1')
    await pane.click()
    await win.keyboard.type(process.platform === 'win32' ? "Write-Output ('PLATFORM_' + 'OK 한글')" : "printf 'PLATFORM_%s\\n' 'OK 한글'")
    await win.keyboard.press('Enter')
    await expect(pane.locator('.xterm-rows')).toContainText('PLATFORM_OK 한글', { timeout: 20_000 })
    await win.keyboard.press(process.platform === 'darwin' ? 'Meta+p' : 'Control+p')
    await expect(win.getByTestId('palette')).toBeVisible()
    await win.keyboard.press('Escape')
    await expect(win.getByTestId('palette')).toBeHidden()

    // 같은 바이너리를 Node 모드로 열어 패키지 CLI와 IPC 연결도 확인한다.
    const resources = process.platform === 'darwin' ? join(dirname(APP), '..', 'Resources') : join(dirname(APP), 'resources')
    const cli = await new Promise<string>((resolve, reject) => execFile(APP, [join(resources, 'app.asar', 'out', 'main', 'cli.js'), 'list', '--json'],
      { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 15_000, windowsHide: true }, (err, stdout) => err ? reject(err) : resolve(stdout)))
    expect(cli).toContain('OS 검증')

    if (process.platform === 'win32') {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('app:command', 'chat-new-codex'))
      const chat = win.locator('[data-testid="task-view"][aria-hidden="false"] [data-testid="chat-pane"]')
      await expect(chat).toBeVisible()
      await chat.getByTestId('chat-input').fill('Windows npm shim 한글')
      await chat.getByTestId('chat-input').press('Enter')
      await expect(chat.locator('[data-kind="text"]').first()).toHaveText('echo: Windows npm shim 한글', { timeout: 20_000 })
      await expect(chat.getByTestId('chat-status')).toContainText('끝남')
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('app:command', 'close-pane'))
      await expect(win.getByTestId('pane-p1')).toBeVisible()
    }

    await win.reload()
    await waitLoaded(win)
    await expect.poll(() => win.evaluate(() => window.taskminal.host.view().then((v) => v.pid)), { timeout: 15_000 }).toBe(host.pid)
    await expect(win.getByTestId('pane-p1').locator('.xterm-rows')).toContainText('PLATFORM_OK 한글', { timeout: 15_000 })
    await app.close()
    closed = true
    app = await electron.launch({ executablePath: APP, env, args })
    closed = false
    win = await firstWindow(app)
    await waitLoaded(win)
    await expect.poll(() => win.evaluate(() => window.taskminal.host.view().then((v) => v.pid)), { timeout: 15_000 }).toBe(host.pid)
    await expect(win.getByTestId('pane-p1').locator('.xterm-rows')).toContainText('PLATFORM_OK 한글', { timeout: 15_000 })
    await win.screenshot({ path: `test-results/platform-${process.platform}-${process.arch}.png` })
    // 테스트가 만든 셸만 명시적으로 종료한다. 실제 사용자 데이터/앱은 건드리지 않는다.
    await win.evaluate(() => window.taskminal.host.action('restart'))
  } finally {
    if (!closed) await app.close().catch(() => {})
    rmSync(userData, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
  }
})
