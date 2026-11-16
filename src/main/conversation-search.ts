import { open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { isChatEvent, type ChatEvent } from '../shared/chat'
import { paneIds } from '../shared/layout'
import { redact, type SecretOptions } from '../shared/redact'
import type { AppState } from '../shared/types'
import { conversationMessage } from '../shared/conversation-search'
import type { ConversationQuery, ConversationResult, ConversationHit } from '../shared/conversation-search'

const MAX_BYTES=2*1024*1024
const fingerprint=(e:Extract<ChatEvent,{t:'user'}>)=>createHash('sha256').update(conversationMessage(e)).digest('hex')
export class ConversationSearch {
 private latest=0
 private queue:Promise<unknown>=Promise.resolve()
 constructor(private readonly dir:string,private readonly state:()=>AppState|null,private readonly options:()=>SecretOptions=()=>({})){}
 private async read(id:string):Promise<ChatEvent[]> {
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(id))throw new Error('잘못된 대화')
  let handle
  try {
   handle=await open(join(this.dir,`${id}.jsonl`),constants.O_RDONLY|constants.O_NOFOLLOW)
   const info=await handle.stat()
   if(!info.isFile()||info.size>MAX_BYTES)throw new Error('대화 크기 제한')
   const bytes=Buffer.alloc(MAX_BYTES+1)
   let size=0
   while(size<bytes.length){const r=await handle.read(bytes,size,bytes.length-size,null);if(!r.bytesRead)break;size+=r.bytesRead}
   if(size>MAX_BYTES)throw new Error('대화 크기 제한')
   const events:ChatEvent[]=[]
   for(const line of bytes.subarray(0,size).toString('utf8').split('\n')){
    if(!line.trim())continue
    const e:unknown=JSON.parse(line)
    if(!isChatEvent(e))throw new Error('손상된 대화')
    events.push(e)
   }
   return events
  }catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e}
  finally{await handle?.close()}
 }
 async search(q:ConversationQuery):Promise<ConversationResult>{
  const request=++this.latest
  const result=this.queue.catch(()=>{}).then(()=>this.perform(q,request))
  this.queue=result
  return result
 }
 private async perform(q:ConversationQuery,request:number):Promise<ConversationResult>{
  if(!q||typeof q.text!=='string'||q.text.length>500||(q.taskId!==undefined&&typeof q.taskId!=='string')||(q.agent!==undefined&&!['claude','codex'].includes(q.agent))||(q.archived!==undefined&&typeof q.archived!=='boolean'))throw new Error('검색 조건을 확인해 주세요')
  const result:ConversationResult={hits:[],more:false,errors:[]},needle=q.text.trim().toLowerCase()
  if(!needle)return result
  let checked=0
  for(const task of this.state()?.tasks??[]){
   if((q.taskId&&task.id!==q.taskId)||(!q.archived&&task.archivedAt!==undefined))continue
   const attached=new Set(task.tabs.flatMap(t=>paneIds(t.layout)))
   for(const pane of Object.values(task.panes)){
    if(request!==this.latest)return result
    if(!attached.has(pane.id)||pane.kind!=='chat'||!pane.chat||(q.agent&&q.agent!==pane.chat.agent))continue
    if(++checked>64){result.more=true;return result}
    let events:ChatEvent[]
    try{events=await this.read(pane.id)}catch{result.errors.push(`${task.name}: 대화 기록을 읽지 못했어요`);continue}
    let turn=-1,at=0,hash=''
    for(let i=0;i<events.length;i++){
     const event=events[i]!
     if(event.t==='user'){turn=i;at=Number.isFinite(event.at)?event.at:0;hash=fingerprint(event)}
     if(turn<0||(event.t!=='user'&&event.t!=='text'))continue
     const text=redact(event.text,this.options()),index=text.toLowerCase().indexOf(needle)
     if(index<0)continue
     if(result.hits.length>=200){result.more=true;return result}
     result.hits.push({taskId:task.id,taskName:task.name,paneId:pane.id,agent:pane.chat.agent,archived:task.archivedAt!==undefined,turn,at,role:event.t==='user'?'user':'assistant',snippet:text.slice(Math.max(0,index-60),index+260),fingerprint:hash})
    }
   }
  }
  return result
 }
 async verify(hit:ConversationHit):Promise<boolean>{
  if(!hit||typeof hit.taskId!=='string'||typeof hit.paneId!=='string'||!Number.isSafeInteger(hit.turn)||hit.turn<0||typeof hit.fingerprint!=='string')return false
  const task=this.state()?.tasks.find(t=>t.id===hit.taskId),pane=task?.panes[hit.paneId]
  if(!task||pane?.kind!=='chat'||!task.tabs.some(t=>paneIds(t.layout).includes(hit.paneId)))return false
  try{const event=(await this.read(hit.paneId))[hit.turn];return !!event&&event.t==='user'&&fingerprint(event)===hit.fingerprint}catch{return false}
 }
}
