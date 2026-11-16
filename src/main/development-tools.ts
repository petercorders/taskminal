import { constants } from 'node:fs'
import { open,lstat,realpath,mkdir } from 'node:fs/promises'
import { join,isAbsolute,dirname } from 'node:path'
import { execFile,spawn,type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { AtomicJournal } from './atomic-journal'
import { redact } from '../shared/redact'
import type { EnvironmentPlan,Preparation,ExtensionManifest,ExtensionPreview,InstalledExtension } from '../shared/development-tools'
const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex')
const key=(v:unknown):v is string=>typeof v==='string'&&/^[\w-]{1,100}$/.test(v)
const string=(v:unknown,max:number):v is string=>typeof v==='string'&&v.length<=max&&!v.includes('\0')
interface Config {copies:string[];commands:Array<{file:string;args:string[]}>}
interface Journal {preparations:Preparation[];extensions:Array<InstalledExtension&{root:string}>}
/** Reject symlinks at every component, including an existing destination. */
async function path(root:string,relative:string,missing=false){
 if(!string(relative,4096)||!relative||isAbsolute(relative)||relative.includes('\\')||relative.split('/').some(p=>!p||p==='.'||p==='..'||p==='.git'))throw Error('허용되지 않은 상대 경로예요')
 const canonical=await realpath(root);if(canonical!==root)throw Error('작업 폴더 경계가 바뀌었어요')
 let current=root
 for(const part of relative.split('/')){current=join(current,part);try{if((await lstat(current)).isSymbolicLink())throw Error('심볼릭 링크는 준비할 수 없어요')}catch(e){if(!missing||(e as NodeJS.ErrnoException).code!=='ENOENT')throw e}}
 return current
}
async function read(root:string,relative:string,max=65536){
 const p=await path(root,relative),fd=await open(p,constants.O_RDONLY|constants.O_NOFOLLOW)
 try{const s=await fd.stat();if(!s.isFile()||s.size>max)throw Error('파일 형식 또는 크기 한도');const data=Buffer.alloc(max+1),n=(await fd.read(data,0,data.length,0)).bytesRead;const now=await lstat(await path(root,relative));if(n>max||s.dev!==now.dev||s.ino!==now.ino)throw Error('읽는 동안 파일이 바뀌었어요');return data.subarray(0,n)}finally{await fd.close()}
}
function git(root:string,args:string[]){return new Promise<{code:number;out:string}>((done)=>execFile('git',args,{cwd:root,encoding:'utf8',timeout:15000,maxBuffer:2_000_000,env:Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('GIT_')))},(e,out)=>done({code:e?1:0,out:out??''})))}
function config(v:unknown):v is Config {if(!v||typeof v!=='object')return false;const c=v as Config;return Object.keys(c).every(k=>['copies','commands'].includes(k))&&Array.isArray(c.copies)&&c.copies.length<=30&&new Set(c.copies).size===c.copies.length&&c.copies.every(p=>string(p,4096))&&Array.isArray(c.commands)&&c.commands.length<=10&&c.commands.every(c=>c&&string(c.file,4096)&&!!c.file&&Array.isArray(c.args)&&c.args.length<=50&&c.args.every(a=>string(a,4096)))}
function manifest(v:unknown):v is ExtensionManifest{
 if(!v||typeof v!=='object')return false;const m=v as ExtensionManifest
 return Object.keys(m).every(k=>['id','name','version','panels','commands'].includes(k))&&key(m.id)&&string(m.name,100)&&!!m.name&&string(m.version,100)&&!!m.version&&Array.isArray(m.panels)&&m.panels.length<=10&&Array.isArray(m.commands)&&m.commands.length<=20&&new Set([...m.panels,...m.commands].map(x=>x.id)).size===m.panels.length+m.commands.length&&m.panels.every(p=>p&&Object.keys(p).every(k=>['id','title','body'].includes(k))&&key(p.id)&&string(p.title,100)&&string(p.body,20000))&&m.commands.every(c=>{if(!c||!Object.keys(c).every(k=>['id','title','url'].includes(k))||!key(c.id)||!string(c.title,100)||!string(c.url,4096))return false;try{const u=new URL(c.url);return u.protocol==='https:'&&!u.username&&!u.password}catch{return false}})
}
const valid=(v:unknown):v is Journal=>{if(!v||typeof v!=='object')return false;const j=v as Journal;return Array.isArray(j.preparations)&&j.preparations.length<=100&&j.preparations.every(r=>r&&key(r.id)&&string(r.root,4096)&&string(r.target,4096)&&/^[a-f0-9]{64}$/.test(r.signature)&&['running','done','failed','unknown','stopped'].includes(r.state)&&string(r.log,20000))&&Array.isArray(j.extensions)&&j.extensions.length<=50&&j.extensions.every(e=>e&&string(e.root,4096)&&manifest(e.manifest)&&typeof e.enabled==='boolean'&&/^[a-f0-9]{64}$/.test(e.signature))}
export class DevelopmentTools {
 private journal:AtomicJournal<Journal>
 private data:Journal
 private jobs=new Map<string,Promise<Preparation>>()
 private children=new Map<string,ChildProcess>()
 private cancelled=new Set<string>()
 private busyTargets=new Set<string>()
 constructor(dir:string,private readonly authorized:(root:string)=>boolean=()=>true,private readonly mask:(text:string)=>string=redact){this.journal=new AtomicJournal(join(dir,'tools.json'),valid);this.data=this.journal.load({preparations:[],extensions:[]});for(const p of this.data.preparations)if(p.state==='running'){p.state='unknown';p.log=this.mask(p.log+'\n앱이 종료됐어요. 만들어진 파일과 실행 결과를 확인하고 새 요청으로 준비하세요.').slice(-20000)}this.persist()}
 private persist(){this.journal.save(this.data)}
 async preview(source:string,destination:string):Promise<EnvironmentPlan>{return (await this.snapshot(source,destination)).plan}
 private async snapshot(source:string,destination:string){
  const root=await realpath(source),target=await realpath(destination)
  const trees=await git(root,['worktree','list','--porcelain']);if(trees.code||!trees.out.split('\n').includes('worktree '+target)||root===target)throw Error('같은 저장소의 별도 worktree를 골라 주세요')
  const raw=await read(root,'.taskminal/environment.json');const c:unknown=JSON.parse(raw.toString('utf8'));if(!config(c))throw Error('환경 설정 형식을 확인해 주세요')
  const copies:EnvironmentPlan['copies']=[],signatures:string[]=[],contents=new Map<string,Buffer>()
  for(const relative of c.copies){
   const ignored=await git(root,['check-ignore','-q','--',relative]),tracked=await git(target,['ls-files','--error-unmatch','--',relative])
   if(ignored.code!==0||tracked.code===0)throw Error('gitignored이며 추적하지 않는 파일만 복사할 수 있어요')
   const bytes=await read(root,relative,2_000_000),dest=await path(target,relative,true);let exists=false
   try{const s=await lstat(dest);if(!s.isFile())throw Error('대상은 일반 파일이어야 해요');exists=true}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}
   copies.push({path:relative,size:bytes.length,exists});signatures.push(hash(bytes));contents.set(relative,bytes)
  }
  const signature=hash(JSON.stringify([root,target,raw.toString('utf8'),signatures,copies]))
  const plan:EnvironmentPlan={root,target,signature,copies,commands:c.commands.map(c=>({file:this.mask(c.file),args:c.args.map(a=>this.mask(a))}))}
  return {plan,config:c,contents}
 }
 preparations(root:string){return structuredClone(this.data.preparations.filter(p=>p.root===root))}
 async prepare(root:string,plan:EnvironmentPlan,id:string):Promise<Preparation>{
  if(!key(id)||!plan||plan.root!==await realpath(root))throw Error('환경 준비 요청 형식')
  const prior=this.data.preparations.find(p=>p.id===id)
  if(prior){if(prior.root!==plan.root||prior.target!==plan.target||prior.signature!==plan.signature)throw Error('다른 준비에 사용한 번호예요');return this.jobs.get(id)??structuredClone(prior)}
  if(!this.authorized(plan.root))throw Error('일감이 닫혔어요')
  const latest=await this.preview(root,plan.target);if(latest.signature!==plan.signature)throw Error('준비할 설정이나 파일이 바뀌었어요. 다시 미리 보세요')
  const duplicate=this.data.preparations.find(p=>p.id===id);if(duplicate){if(duplicate.signature!==plan.signature||duplicate.root!==plan.root||duplicate.target!==plan.target)throw Error('다른 준비에 사용한 번호예요');return this.jobs.get(id)??structuredClone(duplicate)}
  if(this.busyTargets.has(plan.target)||this.data.preparations.length>=100)throw Error('앞 준비가 끝난 뒤 다시 진행해 주세요')
  this.busyTargets.add(plan.target)
  const result:Preparation={id,root:latest.root,target:latest.target,signature:latest.signature,state:'running',log:''};this.data.preparations.push(result)
  try{this.persist()}catch(e){this.busyTargets.delete(plan.target);this.data.preparations.pop();throw e}
  const job=this.execute(latest,result).finally(()=>{this.busyTargets.delete(plan.target);this.jobs.delete(id);this.children.delete(id);this.cancelled.delete(id)})
  this.jobs.set(id,job);return job
 }
 private async execute(plan:EnvironmentPlan,r:Preparation){
  try{
   const snapshot=await this.snapshot(plan.root,plan.target),c=snapshot.config
   if(snapshot.plan.signature!==plan.signature)throw Error('준비할 설정이 바뀌었어요')
   for(const copy of plan.copies){if(!this.authorized(plan.root))throw Error('일감이 닫혔어요');if(this.cancelled.has(r.id))throw Error('준비를 중단했어요');if(copy.exists){r.log+=copy.path+' — 기존 파일 보존\n';continue}
    const bytes=snapshot.contents.get(copy.path)!,dest=await path(plan.target,copy.path,true)
    await mkdir(dirname(dest),{recursive:true,mode:0o700});await path(plan.target,copy.path,true)
    const f=await open(dest,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600)
    try{await f.writeFile(bytes);await f.sync()}finally{await f.close()}
    // Detect an ancestor replacement after the atomic open; never overwrite another file.
    if(await path(plan.target,copy.path)!==dest)throw Error('복사 대상 경계가 바뀌었어요')
    r.log+=copy.path+' — 복사 완료\n';this.persist()
   }
   for(const command of c.commands){if(!this.authorized(plan.root))throw Error('일감이 닫혔어요');if(this.cancelled.has(r.id))throw Error('준비를 중단했어요');if(await realpath(plan.target)!==plan.target)throw Error('준비 폴더가 바뀌었어요')
    await this.command(r,command);this.persist()
   }
   if(this.cancelled.has(r.id))throw Error('준비를 중단했어요')
   r.state='done'
  }catch(e){r.state=this.cancelled.has(r.id)?'stopped':'failed';r.log+='\n'+this.mask(e instanceof Error?e.message:'환경 준비 실패')}
  r.log=this.mask(r.log).slice(-20000);this.persist();return structuredClone(r)
 }
 private command(r:Preparation,c:{file:string;args:string[]}){return new Promise<void>((done,reject)=>{
  if(this.cancelled.has(r.id)||!this.authorized(r.root)){reject(Error('준비가 중단됐거나 일감이 닫혔어요'));return}
  const child=spawn(c.file,c.args,{cwd:r.target,env:process.env,shell:false,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});this.children.set(r.id,child)
  let raw=''
  const capture=(chunk:Buffer)=>{raw=(raw+chunk.toString()).slice(-40000)};child.stdout?.on('data',capture);child.stderr?.on('data',capture)
  const timer=setTimeout(()=>{this.kill(child);r.log=this.mask(r.log+raw).slice(-20000);reject(Error('초기화 명령 시간 제한을 넘었어요. 결과를 확인하세요'))},120000)
  child.once('error',e=>{clearTimeout(timer);r.log=this.mask(r.log+raw).slice(-20000);reject(e)});child.once('exit',code=>{clearTimeout(timer);r.log=this.mask(r.log+raw).slice(-20000);this.children.delete(r.id);code===0?done():reject(Error('초기화 명령 종료 코드 '+code))})}
 )}
 private kill(child:ChildProcess){try{if(process.platform==='win32'&&child.pid){const kill=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});kill.on('error',()=>child.kill())}else if(child.pid)process.kill(-child.pid,'SIGKILL')}catch{}}
 cancel(root:string,id:string){const r=this.data.preparations.find(r=>r.id===id&&r.root===root);if(!r||r.state!=='running')return;this.cancelled.add(id);const child=this.children.get(id);if(child)this.kill(child)}
 async inspect(root:string,relative:string):Promise<ExtensionPreview>{const canonical=await realpath(root),raw=await read(canonical,relative),m:unknown=JSON.parse(raw.toString('utf8'));if(!manifest(m))throw Error('선언형 확장 manifest 형식 또는 권한을 확인해 주세요');return {path:relative,signature:hash(raw),manifest:m}}
 async install(root:string,preview:ExtensionPreview){if(!preview||!string(preview.path,4096))throw Error('확장 미리보기 형식');const next=await this.inspect(root,preview.path);if(next.signature!==preview.signature)throw Error('확장 파일이 바뀌었어요. 권한을 다시 확인하세요');const canonical=await realpath(root);if(!this.authorized(canonical))throw Error('일감이 닫혔어요');const entry={root:canonical,manifest:next.manifest,signature:next.signature,enabled:true};const old=this.data.extensions;if(!old.some(e=>e.root===canonical&&e.manifest.id===entry.manifest.id)&&old.length>=50)throw Error('확장 한도');this.data.extensions=old.filter(e=>e.root!==canonical||e.manifest.id!==entry.manifest.id).concat(entry);try{this.persist()}catch(e){this.data.extensions=old;throw e}}
 extensions(root:string){return structuredClone(this.data.extensions.filter(e=>e.root===root))}
 enable(root:string,id:string,enabled:boolean){if(!key(id)||typeof enabled!=='boolean')throw Error('확장 설정 형식');const entry=this.data.extensions.find(e=>e.root===root&&e.manifest.id===id);if(!entry)throw Error('확장을 찾지 못했어요');const old=entry.enabled;entry.enabled=enabled;try{this.persist()}catch(e){entry.enabled=old;throw e}}
 uninstall(root:string,id:string){const old=this.data.extensions;this.data.extensions=old.filter(e=>e.root!==root||e.manifest.id!==id);try{this.persist()}catch(e){this.data.extensions=old;throw e}}
 dispose(){for(const [id,child] of this.children){this.cancelled.add(id);this.kill(child)}}
}
