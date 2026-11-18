import { app, ipcMain, safeStorage, type IpcMainInvokeEvent } from 'electron'
import { homedir } from 'node:os'
import { expandHome } from '../shared/cwd'
import { isAbsolute, join } from 'node:path'
import { IPC } from '../shared/ipc'
import type { AppState } from '../shared/types'
import type { UiReply, UiRequest } from '../shared/cli'
import { Issues } from './issues'
import { Jira, type Cipher } from './jira'
import { localGithubRepo, makeWorkflowRunner } from './git-workflow'
interface Dependencies {
  state(): AppState | null
  saved(): AppState | null
  ask(request: UiRequest): Promise<UiReply>
}
export function installIssuesIpc(trusted: (event: IpcMainInvokeEvent) => boolean, d: Dependencies) {
  const exists = (id: string) => !!d.state()?.tasks.some(task => task.id === id && !task.host && task.archivedAt === undefined) && !!d.saved()?.tasks.some(task => task.id === id && !task.host && task.archivedAt === undefined)
  // 55단계: 시험(TASKMINAL_USER_DATA)만 http://127.0.0.1 · 짧은 한도 · safeStorage 끄기(실제 키체인을 건드리지 않게)를 쓴다
  const testing = !!process.env['TASKMINAL_USER_DATA']
  const off: Cipher = { available: () => false, encrypt: () => { throw new Error('off') }, decrypt: () => { throw new Error('off') } }
  const timeoutMs = Number(process.env['TASKMINAL_JIRA_TIMEOUT_MS'])
  const jira = new Jira({
    dir: app.getPath('userData'),
    cipher: testing && process.env['TASKMINAL_JIRA_NO_SAFE_STORAGE'] ? off : { available: () => safeStorage.isEncryptionAvailable(), encrypt: text => safeStorage.encryptString(text), decrypt: data => safeStorage.decryptString(data) },
    env: process.env,
    allowLoopback: testing,
    ...(testing && timeoutMs > 0 ? { timeoutMs } : {}),
  })
  const service = new Issues(join(app.getPath('userData'), 'issues'), {
    exists,
    cwd: taskId => d.state()?.tasks.find(task => task.id === taskId)?.cwd,
    jira,
    prepare: async (taskId, root, issue) => {
      if (!d.state() || !d.saved()) throw new Error('일감 저장을 준비하지 못했어요')
      const reply = await d.ask({ op: 'issue.prepare', taskId, root, issue })
      if (!reply.ok) throw new Error('연결 일감을 준비하지 못했어요. 같은 요청 번호로 다시 확인해 주세요')
      const stored = d.saved()?.tasks.find(task => task.id === taskId && !task.host && task.archivedAt === undefined)
      if (!stored || stored.cwd !== root) throw new Error('연결 일감 저장 결과를 확인하지 못했어요. 같은 요청으로 다시 확인해 주세요')
    },
  })
  const check = (event: IpcMainInvokeEvent) => { if (!trusted(event)) throw new Error('알 수 없는 프레임') }
  const id = (value: unknown) => { if (typeof value !== 'string' || !/^[\w-]{1,100}$/.test(value)) throw new Error('연결한 일감 번호를 확인해 주세요'); return value }
  ipcMain.handle(IPC.issuesList, (event, provider, source, cursor) => { check(event); return service.list(provider, source, cursor) })
  ipcMain.handle(IPC.issuesConfigure, (event, token) => { check(event); service.configure(token) })
  ipcMain.handle(IPC.issuesLinks, event => { check(event); return service.links() })
  ipcMain.handle(IPC.issuesPrepare, (event, input) => { check(event); return service.prepare(input) })
  ipcMain.handle(IPC.issuesLinkPr, (event, taskId, url) => { check(event); if (typeof url !== 'string' || url.length > 4096) throw new Error('PR 주소를 확인해 주세요'); return service.linkPr(id(taskId), url) })
  ipcMain.handle(IPC.issuesClose, (event, taskId) => { check(event); return service.close(id(taskId)) })
  // 56단계: 저장소 칸 채우기 — 이 앱의 로컬 일감 폴더만(원격 · 보관 일감 · 모르는 경로는 null), 로컬 git remote 만 읽는다
  const gitRun = makeWorkflowRunner()
  ipcMain.handle(IPC.issuesRepo, async (event, root) => {
    check(event)
    if (typeof root !== 'string' || root.length > 4096 || root.includes('\0')) return null
    if (!d.state()?.tasks.some(task => !task.host && task.archivedAt === undefined && task.cwd === root)) return null
    const dir = expandHome(root, homedir())
    return isAbsolute(dir) ? localGithubRepo(gitRun, dir) : null
  })
  ipcMain.handle(IPC.jiraStatus, event => { check(event); return jira.status() })
  ipcMain.handle(IPC.jiraSave, (event, input) => { check(event); return jira.save(input) })
  ipcMain.handle(IPC.jiraClear, event => { check(event); return jira.clear() })
  ipcMain.handle(IPC.jiraAttach, (event, input) => {
    check(event)
    if (!input || typeof input !== 'object') throw new Error('연결할 이슈와 일감을 확인해 주세요')
    return service.attach({ requestId: input.requestId, provider: 'jira', id: input.id, source: '', taskId: id(input.taskId) })
  })
  // 64단계 Jira 쓰기 — 키 · 전환 id · 글 · 요청 번호의 모양은 Jira 가 검사한다(어긋나면 보내기 전에 거절)
  const fields = (input: unknown): Record<string, unknown> => { if (!input || typeof input !== 'object') throw new Error('[jira] 요청을 확인해 주세요'); return input as Record<string, unknown> }
  ipcMain.handle(IPC.jiraTransitions, (event, key) => { check(event); return jira.transitions(key) })
  ipcMain.handle(IPC.jiraTransition, (event, input) => { check(event); const i = fields(input); return jira.transition(i['key'] as string, i['transitionId'] as string, i['requestId'] as string) })
  ipcMain.handle(IPC.jiraComment, (event, input) => { check(event); const i = fields(input); return jira.comment(i['key'] as string, i['text'] as string, i['requestId'] as string) })
  ipcMain.handle(IPC.jiraWriteState, (event, requestId) => { check(event); return jira.writeState(requestId) })
  ipcMain.handle(IPC.jiraRefresh, (event, input) => { check(event); const i = fields(input); return service.refresh(id(i['taskId']), i['key'] as string) })
  return service
}
