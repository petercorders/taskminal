import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { execFile } from 'node:child_process'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'
import { IPC } from '../shared/ipc'
import type { AppState } from '../shared/types'
import { WorkspaceFiles } from './workspace-files'
import { WorkspaceBrowser } from './workspace-browser'
import { GitWorkflowService } from './git-workflow'
import { validGitTarget, validWorkflowOptions } from '../shared/git-workflow'
import { Accounts } from './accounts'
import { ConversationSearch } from './conversation-search'

export function installWorkspaceIpc(trusted: (e: IpcMainInvokeEvent) => boolean, state: () => AppState | null) {
  const secretOptions = () => {
    const settings = state()?.settings
    return { custom: settings?.secretCustom ?? [], allow: new Set(settings?.secretAllow.map((a) => a.hash) ?? []) }
  }
  const conversations = new ConversationSearch(join(app.getPath('userData'),'chat'),state,secretOptions)
  const files = new WorkspaceFiles(secretOptions),
    browser = new WorkspaceBrowser(secretOptions),
    git = new GitWorkflowService(undefined, join(app.getPath('userData'), 'git-workflow-pending.json')),
    accounts = new Accounts(join(app.getPath('userData'), 'accounts'))
  const win = (event: IpcMainInvokeEvent) => {
    if (!trusted(event)) throw new Error('알 수 없는 프레임')
    const w = BrowserWindow.fromWebContents(event.sender)
    if (!w) throw new Error('닫힌 창')
    return w
  }
  const expand = (s: string) => resolve(s === '~' ? homedir() : s.startsWith('~/') ? resolve(homedir(), s.slice(2)) : s)
  const root = (event: IpcMainInvokeEvent, dir: unknown): string => {
    win(event)
    if (
      typeof dir !== 'string' ||
      dir.length > 4096 ||
      !state()?.tasks.some(
        (t) => !t.host && t.archivedAt === undefined && (expand(t.cwd) === expand(dir) || Object.values(t.panes).some((p) => expand(p.cwd) === expand(dir))),
      )
    )
      throw new Error('일감 폴더가 아니에요')
    return expand(dir)
  }
  const task = (event: IpcMainInvokeEvent, id: unknown): string => {
    win(event)
    if (typeof id !== 'string' || !state()?.tasks.some((t) => t.id === id && t.archivedAt === undefined)) throw new Error('일감을 찾지 못했어요')
    return id
  }
  const path = (p: unknown): string => {
    if (typeof p !== 'string' || p.length > 4096) throw new Error('잘못된 경로')
    return p
  }
  const accountId = (e: IpcMainInvokeEvent, id: unknown) => {
    win(e)
    if (typeof id !== 'string' || id.length > 100) throw new Error('잘못된 계정')
    return id
  }
  ipcMain.handle(IPC.conversationsSearch,(e,q)=>{win(e);return conversations.search(q)})
  ipcMain.handle(IPC.conversationsVerify,(e,hit)=>{win(e);return conversations.verify(hit)})
  ipcMain.handle(IPC.accountsList, (e) => {
    win(e)
    return accounts.list()
  })
  ipcMain.handle(IPC.accountsTui, (e, id) => {
    win(e)
    if (typeof id !== 'string') throw new Error('잘못된 대화')
    const p = state()
      ?.tasks.flatMap((t) => Object.values(t.panes))
      .find((p) => p.id === id && p.kind === 'chat')
    if (!p?.chat) throw new Error('대화가 닫혔어요')
    const bin = p.chat.agent === 'codex' ? process.env['TASKMINAL_CODEX_TUI'] || 'codex' : process.env['TASKMINAL_CLAUDE_TUI'] || 'claude'
    return accounts.tuiCommand(id, p.chat.agent, !!p.chat.sessionId, bin)
  })
  ipcMain.handle(IPC.accountsAdd, (e, agent, name) => {
    win(e)
    if (!['claude', 'codex'].includes(agent) || typeof name !== 'string' || !name.trim() || name.length > 80) throw new Error('계정 이름을 확인해 주세요')
    accounts.add(agent, name)
  })
  ipcMain.handle(IPC.accountsSelect, (e, id) => accounts.select(accountId(e, id)))
  ipcMain.handle(IPC.accountsStatus, (e, id) => accounts.status(accountId(e, id)))
  ipcMain.handle(IPC.accountsLogin, (e, id) => accounts.login(accountId(e, id)))
  ipcMain.handle(IPC.accountsCancel, (e, id) => accounts.cancel(accountId(e, id)))
  ipcMain.handle(IPC.workspaceList, (e, dir, p) => files.list(root(e, dir), path(p)))
  ipcMain.handle(IPC.workspaceRead, (e, dir, p) => files.read(root(e, dir), path(p)))
  ipcMain.handle(IPC.workspaceExternal, async (e, dir, p) => {
    const full = await files.path(root(e, dir), path(p))
    // TextEdit/registered editor only: shell.openPath could execute a .command file.
    await new Promise<void>((ok, fail) =>
      execFile('/usr/bin/open', ['-t', full], { timeout: 5000 }, (err) => (err ? fail(new Error('편집기를 열지 못했어요')) : ok())),
    )
  })
  ipcMain.handle(IPC.browserShow, (e, id, b) => {
    task(e, id)
    if (
      b !== null &&
      (!b || typeof b !== 'object' || !['x', 'y', 'width', 'height'].every((k) => typeof b[k] === 'number' && Number.isFinite(b[k]) && Math.abs(b[k]) < 20000))
    )
      throw new Error('잘못된 화면 크기')
    browser.show(win(e), id, b)
  })
  ipcMain.handle(IPC.browserNavigate, (e, id, url) => browser.navigate(win(e), task(e, id), path(url)))
  ipcMain.handle(IPC.browserState, (e, id) => browser.state(win(e), task(e, id)))
  ipcMain.handle(IPC.browserAction, (e, id, a) => {
    if (!['back', 'forward', 'reload', 'stop', 'close', 'zoomIn', 'zoomOut', 'focus'].includes(a)) throw new Error('잘못된 동작')
    browser.action(win(e), task(e, id), a)
  })
  ipcMain.handle(IPC.browserCapture, (e, id, element) => {
    if (typeof element !== 'boolean') throw new Error('잘못된 캡처')
    return browser.capture(win(e), task(e, id), element)
  })
  ipcMain.handle(IPC.gitWorkflowView, (e, dir, options) => {
    if (options !== undefined && !validWorkflowOptions(options)) throw new Error('잘못된 원격 설정')
    return git.view(root(e, dir), options)
  })
  ipcMain.handle(IPC.gitWorkflowPush, (e, dir, target) => {
    if (!validGitTarget(target)) throw new Error('잘못된 브랜치')
    return git.push(root(e, dir), target)
  })
  ipcMain.handle(IPC.gitWorkflowCreate, (e, dir, input) => {
    if (
      !input ||
      !validGitTarget(input.target) ||
      typeof input.title !== 'string' ||
      typeof input.body !== 'string' ||
      input.title.length > 256 ||
      input.body.length > 60000
    )
      throw new Error('잘못된 PR')
    return git.create(root(e, dir), input)
  })
  ipcMain.handle(IPC.gitWorkflowMerge, (e, dir, input) => {
    if (
      !input ||
      !validGitTarget(input.target) ||
      !Number.isSafeInteger(input.number) ||
      input.number < 1 ||
      typeof input.head !== 'string' ||
      !/^[a-f0-9]{40,64}$/.test(input.head)
    )
      throw new Error('잘못된 PR')
    return git.merge(root(e, dir), input)
  })
  app.on('will-quit', () => {
    browser.dispose()
    accounts.dispose()
  })
  return accounts
}
