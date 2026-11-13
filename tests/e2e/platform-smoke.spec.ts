import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, mkdirSync, writeFileSync, readdirSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { seedState, waitLoaded } from './helpers'
import { redact } from '../../src/shared/redact'

const APP = process.env['TASKMINAL_E2E_APP_PATH'] || ''
test.skip(process.env['TASKMINAL_E2E_PACKAGED'] !== '1' || !APP || !existsSync(APP), 'OS별 실제 패키지 빌드에서만 실행')

test('OS별 패키지: 한글 셸·CLI·렌더러 재연결·종료 뒤 지킴이 유지', async ({}, testInfo) => {
  test.setTimeout(120_000)
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
  const stages: string[] = [], output: string[] = []
  let currentStage = 'setup'
  const mark = (message: string) => {
    const line = `${new Date().toISOString()} [${process.platform}] ${message}`
    stages.push(line)
    console.log(line)
  }
  const step = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    currentStage = name
    mark(`START ${name}`)
    try {
      const value = await test.step(name, run)
      mark(`DONE ${name}`)
      return value
    } catch (error) {
      mark(`FAIL ${name}: ${String(error)}`)
      throw error
    }
  }
  const bounded = async <T>(promise: Promise<T>, ms: number, name: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${name} timed out after ${ms}ms`)), ms) })])
    } finally { clearTimeout(timer) }
  }
  const launch = () => step('launch', async () => {
    // Playwright는 chromiumSandbox:true가 없으면 스스로 --no-sandbox를 붙인다.
    const instance = await electron.launch({ executablePath: APP, env, args: [], chromiumSandbox: true, timeout: 20_000 })
    for (const stream of [instance.process().stdout, instance.process().stderr]) stream?.on('data', (data: Buffer) => {
      output.push(String(data))
      while (output.join('').length > 64 * 1024) output.shift()
    })
    return instance
  })
  let app: ElectronApplication | null = null
  let closed = true
  try {
    app = await launch()
    closed = false
    let win = await step('first window', () => app!.firstWindow({ timeout: 15_000 }))
    await step('window loaded', () => waitLoaded(win))
    await step('host connected', () => expect.poll(() => win.evaluate(() => window.taskminal.host.view().then((v) => v.state)), { timeout: 20_000 }).toBe('connected'))
    const expected = process.env['TASKMINAL_EXPECT_VERSION'] || (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version
    expect((await win.evaluate(() => window.taskminal.appInfo())).version).toBe(expected)
    const host = await win.evaluate(() => window.taskminal.host.view())
    await expect(win.getByTestId('pane-p1')).toBeVisible()
    const pane = win.getByTestId('pane-p1')
    mark('START shell input/output')
    await pane.click()
    await win.keyboard.type(process.platform === 'win32' ? "Write-Output ('PLATFORM_' + 'OK 한글')" : "printf 'PLATFORM_%s\\n' 'OK 한글'")
    await win.keyboard.press('Enter')
    await expect(pane.locator('.xterm-rows')).toContainText('PLATFORM_OK 한글', { timeout: 20_000 })
    mark('DONE shell input/output')
    mark('START palette')
    await win.keyboard.press(process.platform === 'darwin' ? 'Meta+p' : 'Control+p')
    await expect(win.getByTestId('palette')).toBeVisible()
    await win.keyboard.press('Escape')
    await expect(win.getByTestId('palette')).toBeHidden()
    mark('DONE palette')

    // 같은 바이너리를 Node 모드로 열어 패키지 CLI와 IPC 연결도 확인한다.
    const resources = process.platform === 'darwin' ? join(dirname(APP), '..', 'Resources') : join(dirname(APP), 'resources')
    const cli = await step('CLI IPC', () => new Promise<string>((resolve, reject) => execFile(APP, [join(resources, 'app.asar', 'out', 'main', 'cli.js'), 'list', '--json'],
      { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 15_000, windowsHide: true }, (err, stdout) => err ? reject(err) : resolve(stdout))))
    expect(cli).toContain('OS 검증')

    if (process.platform === 'win32') {
      mark('START Windows npm fake Codex')
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('app:command', 'chat-new-codex'))
      const chat = win.locator('[data-testid="task-view"][aria-hidden="false"] [data-testid="chat-pane"]')
      await expect(chat).toBeVisible()
      await chat.getByTestId('chat-input').fill('Windows npm shim 한글')
      await chat.getByTestId('chat-input').press('Enter')
      await expect(chat.locator('[data-kind="text"]').first()).toHaveText('echo: Windows npm shim 한글', { timeout: 20_000 })
      await expect(chat.getByTestId('chat-status')).toContainText('끝남')
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('app:command', 'close-pane'))
      await expect(win.getByTestId('pane-p1')).toBeVisible()
      mark('DONE Windows npm fake Codex')
    }

    await step('reload', async () => {
      await win.reload()
      await waitLoaded(win)
      await expect.poll(() => win.evaluate(() => window.taskminal.host.view().then((v) => v.pid)), { timeout: 15_000 }).toBe(host.pid)
      await expect(win.getByTestId('pane-p1').locator('.xterm-rows')).toContainText('PLATFORM_OK 한글', { timeout: 15_000 })
    })
    await step('close before relaunch', () => bounded(app!.close(), 10_000, 'close before relaunch'))
    closed = true
    mark('START relaunch')
    app = await launch()
    closed = false
    win = await step('relaunch first window', () => app!.firstWindow({ timeout: 15_000 }))
    await step('relaunch window loaded', () => waitLoaded(win))
    await expect.poll(() => win.evaluate(() => window.taskminal.host.view().then((v) => v.pid)), { timeout: 15_000 }).toBe(host.pid)
    await expect(win.getByTestId('pane-p1').locator('.xterm-rows')).toContainText('PLATFORM_OK 한글', { timeout: 15_000 })
    mark('DONE relaunch and guardian reattach')
    await win.screenshot({ path: `test-results/platform-${process.platform}-${process.arch}.png` })
    // 테스트가 만든 셸만 명시적으로 종료한다. 실제 사용자 데이터/앱은 건드리지 않는다.
    await step('test guardian cleanup', () => bounded(win.evaluate(() => window.taskminal.host.action('restart')), 10_000, 'test guardian cleanup'))
  } finally {
    mark(`START cleanup (last stage: ${currentStage})`)
    if (!closed && app) {
      try { await bounded(app.close(), 10_000, 'cleanup close') }
      catch (error) {
        mark(`cleanup close failed: ${String(error)}; kill only owned app PID ${app.process().pid}`)
        app.process().kill('SIGKILL')
      }
    }
    // 임시 데이터의 진단 로그만 보존한다. 계정·상태·셸 기록은 올리지 않는다.
    const diagnostics = testInfo.outputPath('native-diagnostics')
    mkdirSync(diagnostics, { recursive: true })
    writeFileSync(join(diagnostics, 'stages.log'), stages.join('\n'))
    writeFileSync(join(diagnostics, 'app-output.log'), redact(output.join('')))
    const sources = [join(userData, 'ptyhost.log')]
    const logs = join(userData, 'logs')
    if (existsSync(logs)) for (const name of readdirSync(logs).filter((name) => /^main-[\d-]+\.log$/.test(name)).slice(0, 10)) sources.push(join(logs, name))
    for (const file of sources) {
      try {
        if (lstatSync(file).isFile()) writeFileSync(join(diagnostics, file.split(/[\\/]/).at(-1)!), redact(readFileSync(file, 'utf8').slice(-64 * 1024)))
      } catch { /* 진단 파일이 없거나 앱이 닫히며 갱신 중이면 나머지 로그를 보존한다 */ }
    }
    rmSync(userData, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
    mark('DONE cleanup')
  }
})
