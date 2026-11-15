import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdirSync } from 'node:fs'
import { HostClient } from '../ptyhost/client'
import { socketPath, PTYHOST_PROTOCOL, type SessionInfo } from '../../shared/ptyhost'
import { defaultShell, shellArgs } from '../../shared/platform'
import { shellEnv } from '../../shared/pty'
/** A private guardian per server data directory; HTTP server restarts only detach it. */
export class RemoteTerminalHost {
 private host: HostClient
 private pending=new Map<string,string[]>()
 private ids=new Set<string>()
 private live=new Set<string>()
 private data: (id:string,data:string)=>void=()=>{}
 private exit: (id:string,code:number)=>void=()=>{}
 constructor(dir:string,hostScript:string){
  const userData=join(dir,'terminal-host');mkdirSync(userData,{recursive:true,mode:0o700})
  const recover=()=>{this.live.clear();void this.restore(true).catch(()=>{for(const id of this.ids)this.exit(id,-1)})}
  this.host=new HostClient({userData,hostScript,execPath:process.execPath,env:process.env,
   sockPath:socketPath(userData,PTYHOST_PROTOCOL,tmpdir(),s=>createHash('sha1').update(s).digest('hex'),process.platform),
   onData:(id,data)=>{const pending=this.pending.get(id);if(pending)pending.push(data);else this.data(id,data)},
   onExit:(id,e)=>{this.live.delete(id);this.exit(id,e.exitCode)},onStatus:()=>{},
   onReconnected:recover,onHostLost:recover,
  })
 }
 private async restore(clear:boolean){
  const listed=await this.host.request({op:'list'}),sessions=listed['sessions'] as SessionInfo[]
  for(const id of this.ids){
   const session=sessions?.find(s=>s.paneId===id)
   if(!session){this.exit(id,-1);continue}
   this.pending.set(id,[])
   try{
    const reply=await this.host.request({op:'attach',paneId:id})
    if(typeof reply['screen']==='string')this.data(id,(clear?'\x1bc':'')+reply['screen'])
    const buffered=this.pending.get(id)!;this.pending.delete(id);for(const chunk of buffered)this.data(id,chunk)
    if(session.exited)this.exit(id,session.exited.exitCode);else this.live.add(id)
   }finally{this.pending.delete(id)}
  }
 }
 async start(ids:string[],data:(id:string,data:string)=>void,exit:(id:string,code:number)=>void){
  this.ids=new Set(ids);this.data=data;this.exit=exit;await this.host.start()
  if(!this.host.connected)throw Error('원격 셸 지킴이에 연결하지 못했어요')
  await this.restore(false)
 }
 async create(id:string,cwd:string){
  this.ids.add(id)
  await this.host.request({op:'spawn',paneId:id,file:defaultShell(process.platform,process.env),args:shellArgs(process.platform),cwd,env:shellEnv(process.env),cols:100,rows:30})
  this.live.add(id)
 }
 private send(id:string,request:Parameters<HostClient['send']>[0]){if(!this.live.has(id)||!this.host.send(request))throw Error('원격 셸 연결을 확인해 주세요')}
 async write(id:string,data:string){this.send(id,{op:'write',paneId:id,data})}
 async resize(id:string,cols:number,rows:number){this.send(id,{op:'resize',paneId:id,cols,rows})}
 async kill(id:string){if(this.live.has(id))this.send(id,{op:'kill',paneId:id})}
 dispose(){this.data=()=>{};this.exit=()=>{};this.host.dispose()}
}
