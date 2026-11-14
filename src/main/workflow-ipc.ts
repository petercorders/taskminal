import { app, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { paneIds } from '../shared/layout'
import { IPC } from '../shared/ipc'
import { validWorkflowView, type WorkflowView } from '../shared/workflows'
import type { AppState } from '../shared/types'
import type { UiReply, UiRequest } from '../shared/cli'
import type { ChatManager, Sink } from './chat/chat-manager'
import type { Accounts } from './accounts'
import { AtomicJournal } from './atomic-journal'
import { WorkflowRunner } from './workflow-runner'
import { WorkflowWorkspaces } from './workflow-workspaces'
import { activeRun } from '../shared/workflows'
interface Dependencies {
 state():AppState|null;saved():AppState|null;ask(req:UiRequest):Promise<UiReply>;sink():Sink|null;manager:ChatManager;accounts:Accounts;redact(text:string):string
}
export function installWorkflowIpc(trusted:(event:IpcMainInvokeEvent)=>boolean,d:Dependencies):WorkflowRunner{
 const task=(id:string)=>d.state()?.tasks.find(t=>t.id===id&&!t.host&&t.archivedAt===undefined)
 const workspaces=new WorkflowWorkspaces(join(app.getPath('userData'),'workers'))
 const runner=new WorkflowRunner(new AtomicJournal<WorkflowView>(join(app.getPath('userData'),'workflows','journal.json'),validWorkflowView),{
  id:randomUUID,now:Date.now,redact:d.redact,
  validTask:id=>!!task(id),
  validPane:(id,pane)=>{const t=task(id);return !!t?.panes[pane]?.workflowRunId&&t.tabs.some(tab=>paneIds(tab.layout).includes(pane))},
  pin:(run,step,previous)=>{
   const spec=run.workflow.steps.find(s=>s.id===step.id)!
   if(previous)d.accounts.copyBinding(previous,step.paneId,spec.agent,true)
   else d.accounts.bind(step.paneId,spec.agent,false)
  },
  prepare:async(run,step,current)=>{
   const paneId=step.paneId
   const spec=run.workflow.steps.find(s=>s.id===step.id)!
   const owner=task(run.taskId)
   if(!owner)throw new Error('일감이 닫혔어요')
   const cwd=await workspaces.prepare(owner.cwd,run,step)
   if(!activeRun(run.status)||current?.()===false||task(run.taskId)?.cwd!==owner.cwd)throw new Error('실행 대상이 바뀌었어요')
   d.manager.claim(paneId)
   const reply=await d.ask({op:'workflow.prepare',taskId:run.taskId,paneId:paneId,tabId:'workflow-'+paneId,agent:spec.agent,runId:run.id,label:spec.name,cwd})
   if(!reply.ok)throw new Error('대화 준비 실패')
   const persisted=d.saved()?.tasks.find(t=>t.id===run.taskId),pane=persisted?.panes[paneId]
   if(persisted?.archivedAt!==undefined||pane?.workflowRunId!==run.id||pane.chat?.agent!==spec.agent||pane.cwd!==cwd)throw new Error('대화 저장 실패')
  },
  send:async(run,step,text)=>{
   const t=task(run.taskId),pane=t?.panes[step.paneId],sink=d.sink(),spec=run.workflow.steps.find(s=>s.id===step.id)!
   if(!t||pane?.workflowRunId!==run.id||pane.chat?.agent!==spec.agent||!sink||sink.isDestroyed())return 'no-window'
   return d.manager.send(sink,step.paneId,text,pane.cwd,pane.chat,[],true)
  },
  close:pane=>d.manager.close(pane),
 })
 const off=d.manager.onEvent((pane,event)=>runner.event(pane,event))
 const check=(event:IpcMainInvokeEvent)=>{if(!trusted(event))throw new Error('알 수 없는 프레임')}
 const id=(value:unknown):string=>{if(typeof value!=='string'||!/^[\w-]{1,100}$/.test(value))throw new Error('실행 대상을 확인해 주세요');return value}
 ipcMain.handle(IPC.workflowsView,e=>{check(e);return runner.view()})
 ipcMain.handle(IPC.workflowsSave,(e,w)=>{check(e);runner.save(w)})
 ipcMain.handle(IPC.workflowsRemove,(e,value)=>{check(e);runner.remove(id(value))})
 ipcMain.handle(IPC.workflowsStart,(e,input)=>{check(e);return runner.start(input)})
 ipcMain.handle(IPC.workflowsStop,(e,value)=>{check(e);runner.stop(id(value))})
 ipcMain.handle(IPC.workflowsRetry,(e,value)=>{check(e);runner.retry(id(value))})
 app.on('will-quit',()=>{runner.dispose();off()})
 return runner
}
