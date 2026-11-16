import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstWindow, seedState, waitLoaded } from './helpers'

let app: ElectronApplication | undefined
let win: Page
let data: string
let server: Server
let url: string

test.beforeEach(async () => {
  data = mkdtempSync(join(tmpdir(), 'tm-browser-lifecycle-'))
  seedState(data, [
    { id: 't', name: '브라우저 보관 대상', paneId: 'shell', cwd: data },
    { id: 'other', name: '다른 일감', paneId: 'other-shell', cwd: data },
  ])
  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<title>Archived browser fixture</title><h1>local fixture only</h1>')
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/page`
  app = await electron.launch({ args: ['.'], env: { ...process.env, TASKMINAL_USER_DATA: data } })
  win = await firstWindow(app)
  await waitLoaded(win)
})

test.afterEach(async () => {
  await app?.close()
  server.closeAllConnections()
  await new Promise<void>(resolve => { server.close(() => resolve()) })
  rmSync(data, { recursive: true, force: true, maxRetries: 5 })
})

async function showFixture(): Promise<string> {
  return win.evaluate(async url => {
    const tabs = await window.taskminal.workspace.browserTabs('t')
    await window.taskminal.workspace.browserNavigate('t', url, tabs.selectedTabId)
    await window.taskminal.workspace.browserRemember('t', true)
    await window.taskminal.workspace.browserShow('t', { x: 200, y: 100, width: 300, height: 200 }, tabs.selectedTabId)
    return tabs.selectedTabId
  }, url)
}

test('보관한 일감의 native 페이지를 닫고 기록은 유지하며 늦은 숨기기를 허용한다', async () => {
  const tabId = await showFixture()
  await expect.poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children.filter(view => view.getVisible()).length)).toBe(1)
  // Send authoritative state before cleanup, as can happen across lifecycle/IPC boundaries.
  await win.evaluate(async () => {
    const loaded = await window.taskminal.state.load()
    loaded.state.tasks.find(task => task.id === 't')!.archivedAt = Date.now()
    loaded.state.activeTaskId = 'other'
    window.taskminal.state.save(loaded.state)
    await window.taskminal.workspace.browserTabs('other') // IPC ordering barrier.
  })
  await expect.poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children.filter(view => view.getVisible()).length)).toBe(0)
  expect(await app!.evaluate(({ webContents }, url) => webContents.getAllWebContents().some(contents => contents.getURL() === url), url)).toBe(false)
  await win.evaluate(async tabId => {
    await window.taskminal.workspace.browserShow('t', null, tabId)
    await window.taskminal.workspace.browserShow('t', null) // Legacy unmount cleanup.
    await window.taskminal.workspace.browserShow('retired-task', null, tabId)
  }, tabId)
  const saved = JSON.parse(readFileSync(join(data, 'browser-tabs', 'journal.json'), 'utf8')) as { tasks: Array<{ taskId: string; tabs: Array<{ id: string; url?: string }> }> }
  expect(saved.tasks.find(task => task.taskId === 't')!.tabs).toContainEqual({ id: tabId, url, title: 'Archived browser fixture' })
  expect(saved.tasks.some(task => task.taskId === 'retired-task')).toBe(false)
  expect(await win.evaluate(async tabId => {
    try { await window.taskminal.workspace.browserCapture('t', false, tabId); return false }
    catch { return true }
  }, tabId)).toBe(true)
  expect(await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children.length)).toBe(0)
})
