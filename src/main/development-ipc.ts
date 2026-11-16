import { app,ipcMain,type IpcMainInvokeEvent } from 'electron'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join,resolve } from 'node:path'
import type { AppState } from '../shared/types'
import { IPC } from '../shared/ipc'
import { redact } from '../shared/redact'
import { DevelopmentTools } from './development-tools'
export function installDevelopmentIpc(trusted:(e:IpcMainInvokeEvent)=>boolean,state:()=>AppState|null){
 const expand=(p:string)=>resolve(p==='~'?homedir():p.startsWith('~/')?join(homedir(),p.slice(2)):p)
 const valid=(root:string)=>!!state()?.tasks.some(t=>!t.host&&t.archivedAt===undefined&&[t.cwd,...Object.values(t.panes).map(p=>p.cwd)].some(p=>{try{return realpathSync(expand(p))===root}catch{return false}}))
 let service:DevelopmentTools|undefined
 try{service=new DevelopmentTools(join(app.getPath('userData'),'development'),valid,text=>redact(text,{custom:state()?.settings.secretCustom??[],allow:new Set(state()?.settings.secretAllow.map(a=>a.hash)??[])}))}catch{/* Isolate corrupt records from app startup; every operation fails closed. */}
 ipcMain.handle(IPC.developmentRequest,(event,method:unknown,args:unknown)=>{
  if(!trusted(event)||!Array.isArray(args)||typeof args[0]!=='string'||args[0].length>4096)throw Error('개발 도구 요청 형식')
  const root=realpathSync(expand(args[0]));if(!valid(root))throw Error('현재 로컬 일감 폴더를 확인해 주세요')
  if(!service)throw Error('개발 도구 기록을 읽지 못했어요. 원본을 복구한 뒤 앱을 다시 시작해 주세요')
  switch(method){
   case 'preview':if(args.length===2&&typeof args[1]==='string')return service.preview(root,args[1]);break
   case 'prepare':if(args.length===3)return service.prepare(root,args[1],args[2]);break
   case 'preparations':if(args.length===1)return service.preparations(root);break
   case 'cancel':if(args.length===2)return service.cancel(root,args[1]);break
   case 'inspect':if(args.length===2)return service.inspect(root,args[1]);break
   case 'install':if(args.length===2)return service.install(root,args[1]);break
   case 'extensions':if(args.length===1)return service.extensions(root);break
   case 'enable':if(args.length===3)return service.enable(root,args[1],args[2]);break
   case 'uninstall':if(args.length===2)return service.uninstall(root,args[1]);break
  }
  throw Error('지원하지 않는 개발 도구 요청입니다')
 })
 app.on('will-quit',()=>service?.dispose())
}
