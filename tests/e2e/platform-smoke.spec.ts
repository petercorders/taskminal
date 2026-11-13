import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, mkdirSync, writeFileSync, readdirSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { seedState, waitLoaded } from './helpers'
import { redact } from '../../src/shared/redact'
import { oneShot } from '../../src/main/ptyhost/client'

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
  let ownedMainPid = 0, guardianPath = '', guardianPid = 0
  const launchers: Array<ReturnType<ElectronApplication['process']>> = []
  const launcherFor = new WeakMap<ElectronApplication, ReturnType<ElectronApplication['process']>>()
  const lifecycle = join(userData, 'lifecycle.log')
  const alive = (pid: number) => { try { if (pid <= 0) return false; process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' } }
  const launch = () => step('launch', async () => {
    // Playwright는 chromiumSandbox:true가 없으면 스스로 --no-sandbox를 붙인다.
    const instance = await electron.launch({ executablePath: APP, env, args: [], chromiumSandbox: true, timeout: 20_000 })
    const launcher = instance.process()
    launchers.push(launcher)
    launcherFor.set(instance, launcher)
    for (const stream of [launcher.stdout, launcher.stderr]) stream?.on('data', (data: Buffer) => {
      output.push(String(data))
      while (output.join('').length > 64 * 1024) output.shift()
    })
    app = instance
    closed = false
    ownedMainPid = await instance.evaluate(({ app, BrowserWindow }, file) => {
      const add = (message: string) => {
        try { process.getBuiltinModule('node:fs').appendFileSync(file, `${new Date().toISOString()} [${process.pid}] ${message}\n`) } catch { /* 진단만 기록 */ }
      }
      app.on('before-quit', (event) => add(`before-quit prevented=${event.defaultPrevented}`))
      app.on('will-quit', (event) => add(`will-quit prevented=${event.defaultPrevented}`))
      app.on('quit', (_event, code) => add(`quit code=${code}`))
      app.on('window-all-closed', () => add('window-all-closed'))
      const watch = (window: Electron.BrowserWindow) => {
        window.on('close', () => add('window close'))
        window.on('closed', () => add('window closed'))
        window.webContents.on('will-prevent-unload', () => add('will-prevent-unload'))
        window.webContents.on('destroyed', () => add('webContents destroyed'))
      }
      for (const window of BrowserWindow.getAllWindows()) watch(window)
      app.on('browser-window-created', (_event, window) => watch(window))
      process.on('uncaughtExceptionMonitor', (error) => add(`uncaughtException ${error.message}`))
      process.on('exit', (code) => add(`process exit ${code}`))
      add('lifecycle instrumented')
      return process.pid
    }, lifecycle)
    mark(`owned main PID=${ownedMainPid}, Playwright launcher PID=${launcher.pid}`)
    return instance
  })
  const quitNormally = async (instance: ElectronApplication) => {
    const pid = ownedMainPid
    // 종료 후 Playwright 내부 객체가 지워지므로 시작할 때 보관한 ChildProcess를 쓴다.
    const launcher = launcherFor.get(instance)!
    // 메뉴의 정상 app.quit 경로. Inspector 평가가 반환된 뒤 실행하여 Playwright.close의 즉시 CDP 분리와 구별한다.
    await instance.evaluate(({ app }) => { setImmediate(() => app.quit()) })
    // Windows의 app.process()는 cmd.exe wrapper일 수 있다. 실제 main의 exit0 기록과 PID 소멸을 함께 확인한다.
    await bounded(new Promise<void>((resolve, reject) => {
      const timer = setInterval(() => {
        const log = existsSync(lifecycle) ? readFileSync(lifecycle, 'utf8') : ''
        const exit = new RegExp(`\\[${pid}\\] process exit (-?\\d+)`).exec(log)
        if (!exit) return
        if (exit[1] !== '0') { clearInterval(timer); clearTimeout(deadline); reject(new Error(`normal app.quit main exit ${exit[1]}`)); return }
        if (!alive(pid)) { clearInterval(timer); clearTimeout(deadline); resolve() }
      }, 25)
      const deadline = setTimeout(() => { clearInterval(timer); reject(new Error(`normal app.quit main PID ${pid} has not exited`)) }, 9500)
      deadline.unref()
    }), 10_000, 'normal app.quit process exit')
    mark(`normal app.quit main PID=${pid} exit=0, alive=false; launcher exitCode=${launcher.exitCode} signal=${launcher.signalCode}`)
  }
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
    guardianPath = host.sockPath ?? ''
    guardianPid = host.pid ?? 0
    await expect(win.getByTestId('pane-p1')).toBeVisible()
    const pane = win.getByTestId('pane-p1')
    mark('START shell input/output')
    await pane.click()
    await win.keyboard.type(process.platform === 'win32' ? "Write-Output ('PLATFORM_' + 'OK 한글')" : "printf 'PLATFORM_%s\\n' 'OK 한글'")
    await win.keyboard.press('Enter')
    await expect(pane.locator('.xterm-rows')).toContainText('PLATFORM_OK 한글', { timeout: 20_000 })
    mark('DONE shell input/output')
    await app.evaluate(({ ipcMain }) => {
      const writes: string[] = []
      ;(globalThis as unknown as { shortcutWrites: string[] }).shortcutWrites = writes
      ipcMain.on('pty:write', (_event, _pane: string, data: string) => writes.push(data))
    })
    mark('START palette')
    await win.keyboard.press(process.platform === 'darwin' ? 'Meta+p' : 'Control+p')
    await expect(win.getByTestId('palette')).toBeVisible()
    await win.keyboard.press('Escape')
    await expect(win.getByTestId('palette')).toBeHidden()
    const shortcutWrites = await app.evaluate(() => (globalThis as unknown as { shortcutWrites: string[] }).shortcutWrites.join(''))
    expect(shortcutWrites).not.toContain('\x10')
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
    await step('normal quit before relaunch', () => quitNormally(app!))
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
    await step('normal quit after relaunch', () => quitNormally(app!))
    closed = true
  } finally {
    mark(`START cleanup (last stage: ${currentStage})`)
    if (!closed && app) {
      try { await bounded(app.close(), 10_000, 'cleanup close') }
      catch (error) { mark(`cleanup close failed: ${String(error)}`) }
      // 두 번째 app.close가 resolve해도 실제 프로세스 종료를 뜻하지 않을 수 있다.
      if (alive(ownedMainPid)) {
        mark(`cleanup: kill only owned main PID ${ownedMainPid}`)
        try { process.kill(ownedMainPid, 'SIGKILL') } catch { /* 이미 끝남 */ }
      }
      const launcher = launcherFor.get(app)!
      if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill('SIGKILL')
    }
    // Windows에서는 살아 있는 셸/지킴이의 cwd 디렉터리를 지울 수 없다. 이 시험의 지킴이만 정상 종료한다.
    if (guardianPath) {
      await oneShot(guardianPath, [{ op: 'shutdown' }], 2000).catch(() => null)
      if (alive(guardianPid)) {
        await new Promise((resolve) => setTimeout(resolve, 250))
        if (alive(guardianPid)) { try { process.kill(guardianPid, 'SIGKILL') } catch { /* 이미 끝남 */ } }
      }
    }
    for (const launcher of launchers) {
      if (launcher.exitCode === null && launcher.signalCode === null) {
        mark(`cleanup: stop only owned launcher PID ${launcher.pid}`)
        launcher.kill('SIGKILL')
      }
    }
    // 임시 데이터의 진단 로그만 보존한다. 계정·상태·셸 기록은 올리지 않는다.
    const diagnostics = testInfo.outputPath('native-diagnostics')
    mkdirSync(diagnostics, { recursive: true })
    writeFileSync(join(diagnostics, 'stages.log'), stages.join('\n'))
    writeFileSync(join(diagnostics, 'app-output.log'), redact(output.join('')))
    const sources = [join(userData, 'ptyhost.log'), lifecycle]
    const logs = join(userData, 'logs')
    if (existsSync(logs)) for (const name of readdirSync(logs).filter((name) => /^main-[\d-]+\.log$/.test(name)).slice(0, 10)) sources.push(join(logs, name))
    for (const file of sources) {
      try {
        if (lstatSync(file).isFile()) writeFileSync(join(diagnostics, file.split(/[\\/]/).at(-1)!), redact(readFileSync(file, 'utf8').slice(-64 * 1024)))
      } catch { /* 진단 파일이 없거나 앱이 닫히며 갱신 중이면 나머지 로그를 보존한다 */ }
    }
    try { rmSync(userData, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }) }
    catch (error) { mark(`temporary data cleanup failed: ${String(error)}`) } // 본래 실패를 정리 오류로 덮지 않는다
    mark('DONE cleanup')
    writeFileSync(join(diagnostics, 'stages.log'), stages.join('\n'))
  }
})
