import { useEffect, useRef, useState } from 'react'
import type { EnvironmentPlan, ExtensionPreview, InstalledExtension, Preparation } from '../shared/development-tools'
import './DevelopmentPanel.css'

const states:Record<Preparation['state'],string>={running:'실행 중',done:'완료',failed:'실패',unknown:'결과 확인 필요',stopped:'중단'}
export function DevelopmentPanel({root}:{root:string}) {
 const [target,setTarget]=useState(''),[manifestPath,setManifestPath]=useState('')
 const [plan,setPlan]=useState<EnvironmentPlan|null>(null),[extension,setExtension]=useState<ExtensionPreview|null>(null)
 const [records,setRecords]=useState<Preparation[]>([]),[extensions,setExtensions]=useState<InstalledExtension[]>([])
 const [pending,setPending]=useState<{plan:EnvironmentPlan;id:string}|null>(null)
 const [busy,setBusy]=useState(false),[error,setError]=useState('')
 const current=useRef({root,generation:0}),mounted=useRef(false),lock=useRef(false)
 const reading=useRef<{generation:number;promise:Promise<void>}|null>(null)
 if(current.current.root!==root)current.current={root,generation:current.current.generation+1}
 const generation=current.current.generation
 const alive=(snapshot:string)=>mounted.current&&current.current.root===snapshot&&current.current.generation===generation
 const api=window.taskminal.development
 useEffect(()=>{
  mounted.current=true;lock.current=false;setBusy(false);setTarget('');setManifestPath('');setPlan(null);setExtension(null);setPending(null);setRecords([]);setExtensions([]);setError('')
  let stopped=false,timer:ReturnType<typeof setTimeout>|undefined
  const load=async()=>{
   if(stopped)return
   if(!document.hidden){try{await refresh(root)}catch{if(!stopped&&alive(root))setError('작업 기록을 읽지 못했어요. 잠시 뒤 다시 확인합니다.')}}
   if(!stopped)timer=setTimeout(()=>void load(),1000)
  }
  void load()
  return()=>{stopped=true;mounted.current=false;if(timer)clearTimeout(timer)}
 },[root,api])
 async function action(run:(snapshot:string)=>Promise<void>){
  if(lock.current)return
  const snapshot=root;lock.current=true;setBusy(true);setError('')
  try{await run(snapshot)}catch{if(alive(snapshot))setError('요청을 완료하지 못했어요. 경로·권한과 최신 파일을 확인해 주세요. 실행 중인 준비는 기록에서 결과를 확인하세요.')}
  finally{if(alive(snapshot)){lock.current=false;setBusy(false)}}
 }
 async function refresh(snapshot:string){
  if(reading.current?.generation===generation)return reading.current.promise
  const promise=(async()=>{const [r,e]=await Promise.all([api.preparations(snapshot),api.extensions(snapshot)]);if(alive(snapshot)){setRecords(r);setExtensions(e)}})()
  reading.current={generation,promise}
  try{await promise}finally{if(reading.current?.promise===promise)reading.current=null}
 }
 function prepare(request:{plan:EnvironmentPlan;id:string}){
  void action(async(snapshot)=>{
   if(!alive(snapshot))return
   setPending(request);setPlan(null)
   try{await api.prepare(snapshot,request.plan,request.id);if(alive(snapshot))setPending(null)}
   catch{if(alive(snapshot))setError('준비 결과를 확인하지 못했어요. 같은 요청 번호로 확인하거나 실행 기록을 다시 읽어 주세요.')}
   // Reading is safe even after a lost reply. Never issue a new request ID here.
   await refresh(snapshot)
  })
 }
 return <section className="development-panel" aria-label="환경·확장" data-testid="development-panel">
  <h3>환경 준비</h3>
  <p className="dim small">저장소의 <code>.taskminal/environment.json</code>을 직접 작성하세요. <code>copies: string[]</code>, <code>commands: {'{file, args[]}[]'}</code> 형식이며 같은 저장소의 별도 worktree에 준비합니다. 복사 원본은 Git에서 무시되고 추적되지 않는 파일이어야 합니다. 파일 내용은 미리보기에 표시하지 않습니다.</p>
  <label>준비할 worktree 경로<input aria-label="준비할 worktree 경로" value={target} onChange={e=>{setTarget(e.target.value);setPlan(null)}} placeholder="/절대/경로/worktree" disabled={busy}/></label>
  <button className="button" disabled={busy||!target.trim()} onClick={()=>void action(async(snapshot)=>{const next=await api.preview(snapshot,target);if(alive(snapshot))setPlan(next)})}>환경 준비 미리보기</button>
  {plan&&<div className="development-preview" data-testid="environment-preview">
   <strong>{plan.target}</strong>
   <ul>{plan.copies.map(copy=><li key={copy.path}>{copy.path} · {copy.size} bytes · {copy.exists?'기존 파일 보존':'독립 복사'}</li>)}</ul>
   <p className="development-trust">로컬 명령은 이 컴퓨터의 권한으로 실행됩니다. 저장소와 아래 명령을 신뢰하는 경우에만 확인하세요. 의존성은 대상 worktree에서 따로 설치하며 node_modules를 공유하지 않습니다.</p>
   {plan.commands.length?plan.commands.map((command,index)=><pre key={index}>{JSON.stringify({file:command.file,args:command.args},null,2)}</pre>):<p>실행할 초기화 명령 없음</p>}
   <div className="work-tools-row"><button className="button primary" disabled={busy} onClick={()=>prepare({plan,id:crypto.randomUUID()})}>확인하고 환경 준비</button><button className="button" disabled={busy} onClick={()=>setPlan(null)}>미리보기 취소</button></div>
  </div>}
  {pending&&<div className="development-preview"><p>환경 준비 요청 번호: <code>{pending.id}</code>. 결과를 확인하는 동안 새 요청을 보내지 마세요.</p><button className="button" disabled={busy} onClick={()=>prepare(pending)}>같은 요청 번호로 결과 확인</button></div>}
  <p className="dim small">패널을 닫아도 준비는 계속됩니다. 실패·중단 후 새로 실행하려면 설정을 확인하고 다시 미리 보세요.</p>
  <button className="button" disabled={busy} onClick={()=>void action(refresh)}>작업 기록 다시 확인</button>
  <div className="development-records">{[...records].reverse().map(record=><article className="development-preview" data-testid="preparation-record" key={record.id}>
   <strong>{states[record.state]}</strong><p>{record.target}</p><p className="dim small">요청 번호: {record.id}</p><pre aria-label="환경 준비 출력">{record.log||'아직 출력 없음'}</pre>
   {record.state==='unknown'&&<p>앱이 재시작되어 실행 결과를 확정할 수 없어요. 대상 파일·출력을 확인하고 새 미리보기로 다시 준비하세요.</p>}
   {record.state==='running'&&<button className="button" onClick={()=>void api.cancel(root,record.id).catch(()=>{if(alive(root))setError('중단 요청을 확인하지 못했어요. 기록을 다시 확인하세요.')})}>환경 준비 중단</button>}
  </article>)}</div>
  <h3>선언형 확장</h3>
  <p className="dim small">작업 폴더 안의 JSON manifest를 검사한 뒤 설치합니다. 일반 텍스트 패널과 HTTPS 링크 명령만 지원하며 JavaScript·Node 코드는 실행하지 않습니다. 버전을 바꾸려면 manifest를 다시 검사하고 설치를 확인하세요.</p>
  <label>확장 manifest 상대 경로<input aria-label="확장 manifest 상대 경로" value={manifestPath} onChange={e=>{setManifestPath(e.target.value);setExtension(null)}} placeholder="extensions/example.json" disabled={busy}/></label>
  <button className="button" disabled={busy||!manifestPath.trim()} onClick={()=>void action(async(snapshot)=>{const next=await api.inspect(snapshot,manifestPath);if(alive(snapshot))setExtension(next)})}>확장 검사</button>
  {extension&&<div className="development-preview" data-testid="extension-preview">
   <strong>{extension.manifest.name} · {extension.manifest.version}</strong><p>{extension.path}</p>
   {extension.manifest.panels.map(panel=><div key={panel.id}><h4>{panel.title}</h4><pre>{panel.body}</pre></div>)}
   {extension.manifest.commands.map(command=><p key={command.id}>{command.title} · {command.url}</p>)}
   <div className="work-tools-row"><button className="button primary" disabled={busy} onClick={()=>void action(async(snapshot)=>{const preview=extension;await api.install(snapshot,preview);if(alive(snapshot))setExtension(null);await refresh(snapshot)})}>확인하고 확장 설치</button><button className="button" disabled={busy} onClick={()=>setExtension(null)}>확장 설치 취소</button></div>
  </div>}
  {extensions.map(entry=><article key={entry.manifest.id} className="development-preview">
   <strong>{entry.manifest.name} · {entry.manifest.version} · {entry.enabled?'활성':'비활성'}</strong>
   <div className="work-tools-row"><button className="button" aria-label={`${entry.enabled?'비활성화':'활성화'} ${entry.manifest.name}`} disabled={busy} onClick={()=>void action(async(snapshot)=>{await api.enable(snapshot,entry.manifest.id,!entry.enabled);await refresh(snapshot)})}>{entry.enabled?'비활성화':'활성화'}</button><button className="button" aria-label={`제거 ${entry.manifest.name}`} disabled={busy} onClick={()=>void action(async(snapshot)=>{await api.uninstall(snapshot,entry.manifest.id);await refresh(snapshot)})}>제거</button></div>
   {entry.enabled&&<>{entry.manifest.panels.map(panel=><section key={panel.id} data-testid="extension-panel"><h4>{panel.title}</h4><pre>{panel.body}</pre></section>)}{entry.manifest.commands.map(command=><button className="button" key={command.id} title={command.url} onClick={()=>{try{const url=new URL(command.url);if(url.protocol!=='https:'||url.username||url.password)throw Error();window.taskminal.openLink(url.href)}catch{setError('허용되지 않은 확장 링크예요.')}}}>{command.title} ↗</button>)}</>}
  </article>)}
  {error&&<p role="alert">{error}</p>}
 </section>
}
