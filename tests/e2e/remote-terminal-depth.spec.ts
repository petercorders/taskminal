import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, realpathSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { stopRemoteTerminalHost, firstWindow, seedState, waitLoaded } from './helpers'

const require = createRequire(resolve('package.json'))
const electronBin = require('electron') as string
let temp: string, root: string, url: string, token: string, workspace: string, session: string
let server: ChildProcess, app: ElectronApplication | undefined, win: Page

async function rpc(method: string, args: unknown[]) {
  const response = await fetch(url + '/rpc', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) })
  expect(response.status).toBe(200)
  return (await response.json()).data
}
async function startServer(port = '0') {
  server = spawn(process.platform === 'win32' ? electronBin : resolve('resources/bin/taskminal-server'), [
    ...(process.platform === 'win32' ? [resolve('out/main/server.js')] : []), '--root', root, '--data', join(temp, 'server'), '--port', port,
  ], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
  const info = await new Promise<{ url: string; tokenFile: string }>((done, reject) => {
    let output = '', errors = ''
    const timer = setTimeout(() => reject(Error('server timeout ' + errors)), 15000)
    server.stderr?.on('data', (data) => { errors += data })
    server.once('exit', (code) => { clearTimeout(timer); reject(Error(`server exit ${code}: ${errors}`)) })
    server.stdout?.on('data', (data) => {
      output += data
      const first = output.split('\n')[0]
      if (first) { try { const result = JSON.parse(first); clearTimeout(timer); done(result) } catch { /* partial startup line */ } }
    })
  })
  url = info.url; token = readFileSync(info.tokenFile, 'utf8')
}
async function stopServer() {
  if (server?.exitCode === null) { const stopped = new Promise<void>((done) => server.once('exit', () => done())); server.kill('SIGTERM'); await stopped }
}
test.beforeEach(async () => {
  temp = realpathSync(mkdtempSync(join(tmpdir(), 'tm-live-terminal-')))
  root = join(temp, 'root'); mkdirSync(root)
  await startServer()
  workspace = (await rpc('open', ['.', 'open-fixture'])).id
  session = (await rpc('terminal', [workspace, 'terminal-fixture'])).id
  const uiData = join(temp, 'client'); mkdirSync(uiData)
  seedState(uiData, [{ id: 'task', name: 'Local', paneId: 'shell', cwd: root }])
  app = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: uiData } })
  win = await firstWindow(app); await waitLoaded(win)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('app:command', 'remote-workspace'))
  await connect()
})
test.afterEach(async () => {
  await app?.close(); app = undefined
  if (server?.exitCode === null && session) await rpc('stop', [workspace, session])
  await stopServer()
  await stopRemoteTerminalHost(join(temp,'server'))
  rmSync(temp, { recursive: true, force: true, maxRetries: 5 })
})
async function connect() {
  await win.getByRole('textbox', { name: '원격 서버 주소', exact: true }).fill(url)
  await win.getByLabel('원격 서버 토큰', { exact: true }).fill(token)
  await win.getByRole('button', { name: '연결', exact: true }).click()
  await win.getByRole('combobox', { name: '서버 작업 공간', exact: true }).selectOption(workspace)
  await win.getByRole('button', { name: '터미널', exact: true }).click()
  await win.getByRole('combobox', { name: '서버 셸 세션', exact: true }).selectOption(session)
  await expect(win.getByTestId('remote-terminal-size')).toContainText('×')
}
const screen = () => win.getByTestId('remote-xterm').locator('.xterm-accessibility-tree')
async function type(data: string) {
  await win.getByLabel('원격 터미널 키보드 입력', { exact: true }).focus()
  await win.keyboard.type(data)
}
async function command(data: string) { await type(data); await win.keyboard.press('Enter') }

test('native remote xterm interprets ANSI, sends characters and resize, and reconnects to the server PTY', async () => {
  await app!.evaluate(({ipcMain})=>{
    const handlers=Reflect.get(ipcMain,'_invokeHandlers') as Map<string,(...args:any[])=>Promise<unknown>>
    const original=handlers.get('remote-workspace:request')!
    Reflect.set(globalThis,'streamOffsets',[])
    ipcMain.removeHandler('remote-workspace:request')
    ipcMain.handle('remote-workspace:request',async(event,method,...args)=>{
      if(method==='stream')(Reflect.get(globalThis,'streamOffsets') as number[]).push(args[0][3])
      return original(event,method,...args)
    })
  })
  // Disable shell echo, then erase/replace an ANSI-coloured line. A plain <pre> cannot pass this.
  await command('stty -echo')
  await command("printf '\\033[2J\\033[H\\033[31mERASED-TEXT\\033[0m\\r\\033[2KANSI-READY\\n'")
  await expect(screen()).toContainText('ANSI-READY')
  await expect(screen()).not.toContainText('ERASED-TEXT')
  // Noncanonical single-character input must arrive before Enter is pressed.
  await command("stty -icanon min 1 time 0; printf 'RAW-%s\\n' READY; dd bs=1 count=1 of=character.txt 2>/dev/null; stty icanon; printf 'CHAR-DONE\\n'")
  await expect(screen()).toContainText('RAW-READY')
  await type('q')
  await expect.poll(() => { try { return readFileSync(join(root, 'character.txt'), 'utf8') } catch { return '' } }).toBe('q')
  await expect(screen()).toContainText('CHAR-DONE')
  const previous = await win.getByTestId('remote-terminal-size').textContent()
  await win.getByTestId('remote-xterm').evaluate((element) => { (element as HTMLElement).style.height = '220px' })
  await expect(win.getByTestId('remote-terminal-size')).not.toHaveText(previous!)
  const size = (await win.getByTestId('remote-terminal-size').textContent())!.split(' × ').map(Number)
  await command("stty size > size.txt; printf 'SIZE-DONE\\n'")
  await expect.poll(() => { try { return readFileSync(join(root, 'size.txt'), 'utf8').trim() } catch { return '' } }).toBe(`${size[1]} ${size[0]}`)
  await command("printf 'DETACH-%s\\n' START; sleep 0.5; printf 'DETACHED-CHAR\\n' >> detached.txt; printf 'RECONNECT-OUTPUT\\n'")
  await expect(screen()).toContainText('DETACH-START')
  await win.getByRole('button', { name: '연결 해제', exact: true }).click()
  await expect.poll(() => { try { return readFileSync(join(root, 'detached.txt'), 'utf8') } catch { return '' } }).toBe('DETACHED-CHAR\n')
  await connect()
  await expect(screen()).toContainText('RECONNECT-OUTPUT')
  expect((await rpc('workspaces', []))[0].sessions[0].id).toBe(session)
  // Restart only the HTTP server: the guardian owns the same live PTY.
  const port = new URL(url).port
  await stopServer()
  await startServer(port)
  await expect(screen()).toContainText('RECONNECT-OUTPUT')
  await command("printf 'AFTER-SERVER-RESTART\\n'")
  await expect(screen()).toContainText('AFTER-SERVER-RESTART')
  expect((await rpc('workspaces', []))[0].sessions[0].id).toBe(session)
  // A subsequent poll must not duplicate already consumed chunks.
  await command("printf 'ONLY-%s-MARK\\n' ONCE")
  await expect(screen()).toContainText('ONLY-ONCE-MARK')
  await win.waitForTimeout(450)
  expect((await screen().textContent())!.match(/ONLY-ONCE-MARK/g)).toHaveLength(1)
  const offsets=await app!.evaluate(()=>Reflect.get(globalThis,'streamOffsets') as number[])
  expect(offsets.at(-1)).toBeGreaterThan(0)
  await win.getByTestId('remote-xterm').screenshot({ path: 'test-results/remote-terminal-depth.png' })
})

test('uncertain character write pauses input and retries with the same request ID', async () => {
  await command('stty -echo')
  await command("stty -icanon min 1 time 0; printf 'TWO-CHARS-%s\\n' READY; dd bs=1 count=2 of=once.txt 2>/dev/null; stty icanon; printf 'TWO-CHARS-DONE\\n'")
  await expect(screen()).toContainText('TWO-CHARS-READY')
  await app!.evaluate(({ ipcMain }) => {
    const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>
    const original = handlers.get('remote-workspace:request')!
    let lost = false
    ipcMain.removeHandler('remote-workspace:request')
    ipcMain.handle('remote-workspace:request', async (event, method, ...args) => {
      const result = await original(event, method, ...args)
      if (method === 'write' && !lost) { lost = true; throw Error('fixture lost accepted character response') }
      return result
    })
  })
  await type('a')
  await expect(win.getByRole('alert')).toContainText('추가 입력을 멈췄습니다')
  await type('x')
  await win.getByRole('button', { name: '같은 요청 번호로 입력 확인·재시도', exact: true }).click()
  await expect(win.getByRole('button', { name: '같은 요청 번호로 입력 확인·재시도', exact: true })).toHaveCount(0)
  await type('b')
  await expect.poll(() => { try { return readFileSync(join(root, 'once.txt'), 'utf8') } catch { return '' } }).toBe('ab')
  await expect(screen()).toContainText('TWO-CHARS-DONE')
})
