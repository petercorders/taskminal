import { app, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { join, resolve, relative, isAbsolute, sep } from 'node:path'
import { homedir } from 'node:os'
import { expandHome } from '../shared/cwd'
import { realpath } from 'node:fs/promises'
import { IPC } from '../shared/ipc'
import type { AppState } from '../shared/types'
import { validWorktreeJournal, type WorktreeJournalState } from '../shared/worktree-management'
import { usedTaskPaths } from '../shared/worktree-cleanup'
import { AtomicJournal } from './atomic-journal'
import { WorktreeManagement } from './worktree-management'
import { configured } from './development-tools'
interface Dependencies { state():AppState|null; revision():number; pendingPaths():string[]; liveCwds():Promise<string[]> }
const expand=(value:string)=>resolve(expandHome(value,homedir()))
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
    const tasks=await Promise.all((d.state()?.tasks.filter(t=>!t.host)??[]).map(async task=>({id:task.id,name:task.name,archived:task.archivedAt!==undefined,paths:await Promise.all([task.cwd,...Object.values(task.panes).map(p=>p.cwd)].map(p=>realpath(expand(p)).catch(()=>expand(p))))})))
    // 67단계: own = 일감 폴더(paths[0])가 이 worktree 안 — pane 만 둔 다른 폴더 일감은 정리와 함께 보관하지 않는다
    return {...result,entries:result.entries.map(entry=>({...entry,tasks:tasks.filter(t=>t.paths.some(path=>inside(entry.path,path))).map(({id,name,archived,paths})=>({id,name,own:inside(entry.path,paths[0]!),archived})),...(warning?{removable:false,cleanable:false,reasons:[...entry.reasons,warning]}:{})}))}
  })
  // 62단계: 만든 것이 확인됐고 그 일감 폴더에 환경 설정이 있으면 답에 실어, 패널이 환경 준비 미리보기로 잇는다
  ipcMain.handle(IPC.worktreesCreate,async(event,dir,input)=>{const authorized=root(event,dir),result=await service.create(authorized,input);return result.state==='created'&&await configured(authorized)?{...result,environment:true}:result})
  ipcMain.handle(IPC.worktreesTargets,(event,dir)=>service.targets(root(event,dir)))
  ipcMain.handle(IPC.worktreesOpen,async(event,dir,target)=>{
    const result=await service.open(root(event,dir),target)
    for(const t of d.state()?.tasks??[])if(!t.host&&t.archivedAt===undefined&&(await realpath(expand(t.cwd)).catch(()=>''))===result.path){const current=d.state()?.tasks.find(item=>item.id===t.id&&!item.host&&item.archivedAt===undefined);if(current?.cwd===t.cwd)return {...result,taskId:t.id,cwd:t.cwd}}
    return result
  })
  ipcMain.handle(IPC.worktreesRemove,(event,dir,target)=>service.remove(root(event,dir),target))
  // 67단계: 병합된 것 정리 — renderer 가 연결 일감을 보관하고 상태를 먼저 보낸 뒤 부른다. 보관 상태인 그 일감들의 폴더만 사용 경로에서 빼고,
  // 실제 셸 cwd · 열리는 중 · 다른 일감(보관 일감 포함)은 39 그대로 막는다
  ipcMain.handle(IPC.worktreesClean,(event,dir,items)=>{
    const authorized=root(event,dir)
    return service.clean(authorized,items,async exclude=>{const live=await d.liveCwds();return [...usedTaskPaths(d.state()?.tasks??[],exclude).map(expand),...d.pendingPaths().map(expand),...live]})
  })
  return service
}
