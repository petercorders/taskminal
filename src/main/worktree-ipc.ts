import { app, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { join, resolve, relative, isAbsolute, sep } from 'node:path'
import { homedir } from 'node:os'
import { realpath } from 'node:fs/promises'
import { IPC } from '../shared/ipc'
import type { AppState } from '../shared/types'
import { validWorktreeJournal, type WorktreeJournalState } from '../shared/worktree-management'
import { AtomicJournal } from './atomic-journal'
import { WorktreeManagement } from './worktree-management'
interface Dependencies { state():AppState|null; revision():number; pendingPaths():string[]; liveCwds():Promise<string[]> }
const expand=(value:string)=>resolve(value==='~'?homedir():value.startsWith('~/')?join(homedir(),value.slice(2)):value)
const inside=(parent:string,child:string)=>{const path=relative(parent,child);return path===''||(!isAbsolute(path)&&path!=='..'&&!path.startsWith('..'+sep))}
export function installWorktreeIpc(trusted:(event:IpcMainInvokeEvent)=>boolean,d:Dependencies){
  const taskPaths=()=>d.state()?.tasks.filter(t=>!t.host).flatMap(t=>[t.cwd,...Object.values(t.panes).map(p=>p.cwd)]).map(expand)??[]
  const used=async()=>{const live=await d.liveCwds();return [...taskPaths(),...d.pendingPaths().map(expand),...live]}
  const service=new WorktreeManagement({journal:new AtomicJournal<WorktreeJournalState>(join(app.getPath('userData'),'worktrees','journal.json'),validWorktreeJournal),freshUsedCwds:used,usedRevision:d.revision})
  const root=(event:IpcMainInvokeEvent,value:unknown)=>{
    if(!trusted(event))throw new Error('알 수 없는 프레임')
    if(typeof value!=='string'||value.length>4096||value.includes('\0')||!d.state()?.tasks.some(t=>!t.host&&t.archivedAt===undefined&&[t.cwd,...Object.values(t.panes).map(p=>p.cwd)].some(p=>expand(p)===expand(value))))throw new Error('현재 로컬 일감 폴더를 확인해 주세요')
    return expand(value)
  }
  ipcMain.handle(IPC.worktreesList,async(event,dir)=>{
    const authorized=root(event,dir)
    let paths:string[]=taskPaths(),warning=''
    try{paths=await used()}catch{warning='실행 중인 셸의 폴더를 확인하지 못했어요. 상태를 확인하기 전에는 정리하지 않아요.'}
    const result=await service.list(authorized,paths)
    const tasks=await Promise.all((d.state()?.tasks.filter(t=>!t.host)??[]).map(async task=>({id:task.id,name:task.name,paths:await Promise.all([task.cwd,...Object.values(task.panes).map(p=>p.cwd)].map(p=>realpath(expand(p)).catch(()=>expand(p))))})))
    return {...result,entries:result.entries.map(entry=>({...entry,tasks:tasks.filter(t=>t.paths.some(path=>inside(entry.path,path))).map(({id,name})=>({id,name})),...(warning?{removable:false,reasons:[...entry.reasons,warning]}:{})}))}
  })
  ipcMain.handle(IPC.worktreesCreate,(event,dir,input)=>service.create(root(event,dir),input))
  ipcMain.handle(IPC.worktreesOpen,async(event,dir,target)=>{
    const result=await service.open(root(event,dir),target)
    for(const t of d.state()?.tasks??[])if(!t.host&&t.archivedAt===undefined&&(await realpath(expand(t.cwd)).catch(()=>''))===result.path){const current=d.state()?.tasks.find(item=>item.id===t.id&&!item.host&&item.archivedAt===undefined);if(current?.cwd===t.cwd)return {...result,taskId:t.id,cwd:t.cwd}}
    return result
  })
  ipcMain.handle(IPC.worktreesRemove,(event,dir,target)=>service.remove(root(event,dir),target))
  return service
}
