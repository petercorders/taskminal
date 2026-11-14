import { app, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { IPC } from '../shared/ipc'
import type { AppState } from '../shared/types'
import type { UiReply, UiRequest } from '../shared/cli'
import { Issues } from './issues'
interface Dependencies {
  state(): AppState | null
  saved(): AppState | null
  ask(request: UiRequest): Promise<UiReply>
}
export function installIssuesIpc(trusted: (event: IpcMainInvokeEvent) => boolean, d: Dependencies) {
  const exists = (id: string) => !!d.state()?.tasks.some(task => task.id === id && !task.host && task.archivedAt === undefined) && !!d.saved()?.tasks.some(task => task.id === id && !task.host && task.archivedAt === undefined)
  const service = new Issues(join(app.getPath('userData'), 'issues'), {
    exists,
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
  return service
}
