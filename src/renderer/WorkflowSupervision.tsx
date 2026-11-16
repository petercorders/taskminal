import { useEffect, useRef, useState } from 'react'
import type { WorkflowMessage, WorkflowRun, WorkflowStep } from '../shared/workflows'
import { ConfirmDialog } from './ConfirmDialog'
import './WorkflowSupervision.css'

export function WorkflowSupervision({run,onChanged}:{run:WorkflowRun;onChanged():void|Promise<void>}) {
 const [name,setName]=useState(''),[agent,setAgent]=useState<'claude'|'codex'>('claude'),[prompt,setPrompt]=useState(''),[after,setAfter]=useState<string[]>([])
 const [model,setModel]=useState(''),[effort,setEffort]=useState<''|'low'|'medium'|'high'>('')
 const [confirm,setConfirm]=useState<WorkflowStep|null>(null),[worker,setWorker]=useState(''),[kind,setKind]=useState<'status'|'question'>('status'),[text,setText]=useState('')
 const [answers,setAnswers]=useState<Record<string,string>>({}),[busy,setBusy]=useState(false),[error,setError]=useState('')
 const appendId=useRef(crypto.randomUUID()),messageId=useRef(crypto.randomUUID()),lock=useRef(false),mounted=useRef(false)
 const scope=JSON.stringify([run.id,run.taskId,run.root]),current=useRef({scope,generation:0}),latest=useRef(run)
 if(current.current.scope!==scope)current.current={scope,generation:current.current.generation+1}
 const generation=current.current.generation
 latest.current=run
 const alive=()=>mounted.current&&current.current.scope===scope&&current.current.generation===generation
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[])
 useEffect(()=>{setConfirm(null);setName('');setPrompt('');setModel('');setEffort('');setAfter([]);setWorker('');setText('');setAnswers({});setError('');setBusy(false);lock.current=false;appendId.current=crypto.randomUUID();messageId.current=crypto.randomUUID()},[scope])
 const active=run.steps.filter(step=>['running','waiting'].includes(step.status))
 const selected=worker?active.find(step=>`${step.paneId}:${step.attempt}`===worker):undefined
 async function write(operation:(fresh:WorkflowRun)=>Promise<void>,done?:()=>void){
  if(lock.current)return
  lock.current=true;setBusy(true);setError('')
  try{
   const fresh=(await window.taskminal.workflows.view()).runs.find(item=>item.id===run.id&&item.taskId===run.taskId&&item.root===run.root)
   if(!alive()||!fresh)throw Error('실행 대상이 바뀌었어요. 최신 기록을 확인해 주세요.')
   await operation(fresh)
   if(alive()){done?.();await onChanged()}
  }catch(reason){if(alive())setError(reason instanceof Error?reason.message:'요청 결과를 확인하지 못했어요. 기록을 다시 확인해 주세요.')}
  finally{if(alive()){lock.current=false;setBusy(false)}}
 }
 const append=()=>{
  const snapshot=confirm;setConfirm(null)
  if(!snapshot)return
  void write(async fresh=>{
   if(!['preparing','running','waiting','done'].includes(fresh.status)||snapshot.after.some(id=>!fresh.steps.some(step=>step.id===id)))throw Error('실행 상태나 선행 단계가 바뀌었어요. 추가 내용을 다시 확인하세요.')
   await window.taskminal.workflows.append(fresh.id,snapshot)
  },()=>{appendId.current=crypto.randomUUID();setName('');setPrompt('');setModel('');setEffort('');setAfter([])})
 }
 return <section className="workflow-supervision" aria-label="실행 감독" data-testid="workflow-supervision">
  <h4>실행 감독</h4>
  <p className="workflow-meta">질문은 답변을 기록할 때까지 단계 완료와 후속 단계 시작을 보류합니다. 진행 중인 에이전트는 계속 실행합니다. 메시지와 답변은 이 실행의 worker·시도에 연결된 기록으로 남습니다.</p>
  {['preparing','running','waiting','done'].includes(run.status)&&<form aria-label="실행에 단계 추가" onSubmit={event=>{event.preventDefault();setConfirm({id:appendId.current,name:name.trim(),agent,prompt:prompt.trim(),after:[...after],...(model.trim()?{model:model.trim(),...(effort?{effort}:{})}:{})})}}>
   <fieldset disabled={busy||run.steps.length>=10}><legend>실행에 단계 추가 ({run.steps.length}/10)</legend>
    <label className="field"><span>추가 단계 이름</span><input required maxLength={100} value={name} onChange={e=>{setName(e.target.value);appendId.current=crypto.randomUUID()}}/></label>
    <label className="field"><span>추가 단계 에이전트</span><select value={agent} onChange={e=>{setAgent(e.target.value==='codex'?'codex':'claude');appendId.current=crypto.randomUUID()}}><option value="claude">Claude</option><option value="codex">Codex</option></select></label>
    <details><summary>모델 설정 (선택)</summary><label className="field"><span>추가 단계 모델</span><input maxLength={128} value={model} placeholder="공급자 CLI가 지원하는 모델 이름" onChange={e=>{setModel(e.target.value);if(!e.target.value.trim())setEffort('');appendId.current=crypto.randomUUID()}}/></label>
     <label className="field"><span>추가 단계 effort</span><select disabled={!model.trim()} value={effort} onChange={e=>{setEffort(e.target.value as typeof effort);appendId.current=crypto.randomUUID()}}><option value="">공급자 기본값</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option></select></label></details>
    <label className="field"><span>추가 단계 지시</span><textarea required maxLength={12000} rows={3} value={prompt} onChange={e=>{setPrompt(e.target.value);appendId.current=crypto.randomUUID()}}/></label>
    <fieldset><legend>선행 단계</legend>{run.workflow.steps.map(step=><label className="workflow-supervision-dependency" key={step.id}><input type="checkbox" checked={after.includes(step.id)} onChange={e=>{setAfter(e.target.checked?[...after,step.id]:after.filter(id=>id!==step.id));appendId.current=crypto.randomUUID()}}/>{step.name}</label>)}</fieldset>
    <button className="button" type="submit">추가 내용 확인</button>
   </fieldset>
  </form>}
  {!!active.length&&<form aria-label="worker 메시지 기록" onSubmit={event=>{
   event.preventDefault();if(!selected)return
   const message:WorkflowMessage={id:messageId.current,stepId:selected.id,paneId:selected.paneId,attempt:selected.attempt,kind,text:text.trim()}
   void write(async fresh=>{
    if(!fresh.steps.some(step=>step.id===message.stepId&&step.paneId===message.paneId&&step.attempt===message.attempt&&['running','waiting'].includes(step.status)))throw Error('worker 시도가 바뀌었어요. 대상을 다시 선택하세요.')
    await window.taskminal.workflows.message(fresh.id,message)
   },()=>{messageId.current=crypto.randomUUID();setText('')})
  }}><fieldset disabled={busy}><legend>worker 메시지 기록</legend>
   <label className="field"><span>메시지 대상 worker</span><select required value={selected?`${selected.paneId}:${selected.attempt}`:''} onChange={e=>{setWorker(e.target.value);messageId.current=crypto.randomUUID()}}><option value="">worker와 시도를 선택하세요</option>{active.map(step=><option key={step.paneId} value={`${step.paneId}:${step.attempt}`}>{run.workflow.steps.find(item=>item.id===step.id)?.name} · 시도 {step.attempt}</option>)}</select></label>
   <label className="field"><span>기록 종류</span><select value={kind} onChange={e=>{setKind(e.target.value==='question'?'question':'status');messageId.current=crypto.randomUUID()}}><option value="status">상태 메시지</option><option value="question">답변이 필요한 질문</option></select></label>
   <label className="field"><span>기록할 메시지</span><textarea required maxLength={12000} rows={2} value={text} onChange={e=>{setText(e.target.value);messageId.current=crypto.randomUUID()}}/></label>
   <button className="button" type="submit">메시지 기록</button>
  </fieldset></form>}
  {(run.messages??[]).map(message=>{
   const live=run.steps.some(step=>step.id===message.stepId&&step.paneId===message.paneId&&step.attempt===message.attempt&&step.status==='waiting')
   return <article className="workflow-supervision-message" data-testid="supervision-message" key={message.id}>
    <strong>{message.kind==='question'?'질문':'상태'} · {run.workflow.steps.find(step=>step.id===message.stepId)?.name} · 시도 {message.attempt}</strong><pre>{message.text}</pre>
    {message.answer!==undefined?<p>답변: {message.answer}</p>:message.kind==='question'&&<>{live?<form onSubmit={event=>{
     event.preventDefault();const answer=answers[message.id]?.trim()??'',snapshot={...message}
     void write(async fresh=>{
      const question=fresh.messages?.find(item=>item.id===snapshot.id&&item.stepId===snapshot.stepId&&item.paneId===snapshot.paneId&&item.attempt===snapshot.attempt)
      if(!question||!fresh.steps.some(step=>step.id===snapshot.stepId&&step.paneId===snapshot.paneId&&step.attempt===snapshot.attempt&&step.status==='waiting'))throw Error('질문 대상의 시도가 바뀌었어요. 최신 기록을 확인하세요.')
      await window.taskminal.workflows.answerMessage(fresh.id,snapshot.id,answer)
     },()=>setAnswers(old=>({...old,[snapshot.id]:''})))
    }}><label className="field"><span>질문 답변</span><textarea disabled={busy} required maxLength={12000} value={answers[message.id]??''} onChange={e=>setAnswers(old=>({...old,[message.id]:e.target.value}))}/></label><button className="button" disabled={busy} type="submit">답변 기록</button></form>:<p className="workflow-meta">이전 시도의 질문입니다. 현재 worker에 답변을 보내려면 새 질문을 기록하세요.</p>}</>}
   </article>
  })}
  {run.steps.some(step=>step.completedBehindGate)&&<p role="status">에이전트 실행은 끝났습니다. 질문 답변을 기다리는 동안 완료와 후속 단계를 보류합니다.</p>}
  {error&&<p role="alert">{error}</p>}
  {confirm&&<ConfirmDialog title="실행에 단계 추가" message={`${confirm.name} (${confirm.agent}${confirm.model?' · '+confirm.model:''}${confirm.effort?' · '+confirm.effort:''}) — ${confirm.prompt}\n선행 단계: ${confirm.after.map(id=>latest.current.workflow.steps.find(step=>step.id===id)?.name??id).join(', ')||'없음'}. 선행 단계 완료와 실행 한도에 따라 시작합니다.`} confirmLabel="단계 추가 실행" onConfirm={append} onCancel={()=>setConfirm(null)}/>}
 </section>
}
