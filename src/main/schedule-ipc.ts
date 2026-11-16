import { app, ipcMain, powerMonitor, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { IPC } from '../shared/ipc'
import { validScheduleView, type ScheduleView } from '../shared/schedules'
import type { AppState } from '../shared/types'
import type { WorkflowRunner } from './workflow-runner'
import { AtomicJournal } from './atomic-journal'
import { ScheduleLoop, ScheduleRunner } from './schedule-runner'

export function installScheduleIpc(trusted:(event:IpcMainInvokeEvent)=>boolean,d:{state():AppState|null;available():boolean;workflow:WorkflowRunner;redact(text:string):string;report(error:unknown):void}):ScheduleRunner {
  const runner=new ScheduleRunner(new AtomicJournal<ScheduleView>(join(app.getPath('userData'),'schedules','journal.json'),validScheduleView),{
    id:randomUUID,now:Date.now,redact:d.redact,
    validTask:id=>!!d.state()?.tasks.some(t=>t.id===id&&!t.host&&t.archivedAt===undefined),
    workflowView:()=>d.workflow.view(),start:input=>d.workflow.start(input),
  })
  let warning=''
  const check=(event:IpcMainInvokeEvent)=>{if(!trusted(event))throw new Error('알 수 없는 프레임')}
  const id=(value:unknown):string=>{if(typeof value!=='string'||!/^[\w-]{1,100}$/.test(value))throw new Error('예약 대상을 확인해 주세요');return value}
  ipcMain.handle(IPC.schedulesView,event=>{check(event);runner.reconcile();return {...runner.view(),...(warning?{warning}:{})}})
  ipcMain.handle(IPC.schedulesSave,(event,value)=>{check(event);runner.save(value)})
  ipcMain.handle(IPC.schedulesRemove,(event,value)=>{check(event);runner.remove(id(value))})
  ipcMain.handle(IPC.schedulesRunNow,(event,value,request)=>{check(event);if(!d.available())throw new Error('저장 가능한 앱 화면을 연 뒤 실행해 주세요');return runner.runNow(id(value),id(request))})
  let failed=false
  const fail=(error:unknown)=>{if(!failed){failed=true;clearInterval(timer);warning='예약 실행을 멈췄어요. '+(error instanceof Error?error.message:'기록을 확인해 주세요.');d.report(error)}}
  const loop=new ScheduleLoop(runner,d.available,fail)
  const timer=setInterval(()=>{void loop.tick()},15000)
  const suspend=()=>loop.suspend(),resume=()=>loop.resume()
  powerMonitor.on('suspend',suspend);powerMonitor.on('resume',resume)
  app.on('will-quit',()=>{clearInterval(timer);powerMonitor.removeListener('suspend',suspend);powerMonitor.removeListener('resume',resume)})
  return runner
}
