import type { ChatAgent } from './chat'
import { isAbsolutePath } from './platform'
export interface WorkflowMessage {id:string;stepId:string;paneId:string;attempt:number;kind:'status'|'question';text:string;answer?:string}
export const validWorkflowMessages=(v:unknown):v is WorkflowMessage[]=>Array.isArray(v)&&v.length<=500&&new Set(v.map(m=>m?.id)).size===v.length&&v.every(m=>m&&['id','stepId','paneId'].every(k=>typeof m[k]==='string'&&/^[\w-]{1,100}$/.test(m[k]))&&Number.isSafeInteger(m.attempt)&&m.attempt>0&&['status','question'].includes(m.kind)&&typeof m.text==='string'&&m.text.length<=12000&&(m.answer===undefined||typeof m.answer==='string'&&m.answer.length<=12000))
export interface WorkflowStep { id:string;name:string;agent:ChatAgent;prompt:string;after:string[];model?:string;effort?:'low'|'medium'|'high' }
export interface Workflow { id:string;name:string;steps:WorkflowStep[];maxParallel?:number;isolate?:boolean }
export type RunStatus='preparing'|'running'|'waiting'|'done'|'failed'|'stopped'|'unknown'
export interface RunStep { id:string;paneId:string;status:RunStatus|'pending';attempt:number;result:string;cwd?:string;branch?:string;completedBehindGate?:boolean }
export interface WorkflowRun {id:string;requestId:string;taskId:string;workflow:Workflow;status:RunStatus;createdAt:number;error?:string;root?:string;baseOid?:string;steps:RunStep[];messages?:WorkflowMessage[]}
export interface WorkflowView {templates:Workflow[];runs:WorkflowRun[]}
export interface WorkflowApi {view():Promise<WorkflowView>;save(workflow:Workflow):Promise<void>;remove(id:string):Promise<void>;start(input:{requestId:string;taskId:string;workflowId:string}):Promise<string>;stop(id:string):Promise<void>;retry(id:string):Promise<void>;append(id:string,step:WorkflowStep):Promise<void>;message(id:string,message:WorkflowMessage):Promise<void>;answerMessage(id:string,messageId:string,text:string):Promise<void>}
const id=(v:unknown):v is string=>typeof v==='string'&&/^[\w-]{1,100}$/.test(v)
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&v.trim().length>0&&v.length<=max
export function validWorkflow(v:unknown):v is Workflow {
 if(!v||typeof v!=='object')return false
 const w=v as Workflow
 if(!id(w.id)||!text(w.name,100)||!Array.isArray(w.steps)||!w.steps.length||w.steps.length>10)return false
 if(w.maxParallel!==undefined&&(!Number.isInteger(w.maxParallel)||w.maxParallel<1||w.maxParallel>4))return false
 if(w.isolate!==undefined&&typeof w.isolate!=='boolean')return false
 if((w.maxParallel??1)>1&&!w.isolate)return false
 const ids=new Set(w.steps.map(s=>s?.id))
 if(ids.size!==w.steps.length)return false
 if(!w.steps.every(s=>s&&(s.model===undefined||typeof s.model==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(s.model))&&(s.effort===undefined||!!s.model&&['low','medium','high'].includes(s.effort))&&id(s.id)&&text(s.name,100)&&['claude','codex'].includes(s.agent)&&text(s.prompt,12000)&&Array.isArray(s.after)&&s.after.length<=9&&new Set(s.after).size===s.after.length&&s.after.every(a=>ids.has(a)&&a!==s.id)))return false
 const done=new Set<string>()
 for(let i=0;i<w.steps.length;i++){const next=w.steps.find(s=>!done.has(s.id)&&s.after.every(a=>done.has(a)));if(!next)return false;done.add(next.id)}
 return true
}
export const activeRun=(status:RunStatus)=>['preparing','running','waiting'].includes(status)
export function validWorkflowView(v:unknown):v is WorkflowView{
 if(!v||typeof v!=='object')return false
 const d=v as WorkflowView,states=['pending','preparing','running','waiting','done','failed','stopped','unknown']
 return Array.isArray(d.templates)&&d.templates.length<=50&&d.templates.every(validWorkflow)&&new Set(d.templates.map(w=>w.id)).size===d.templates.length&&Array.isArray(d.runs)&&d.runs.length<=100&&new Set(d.runs.map(r=>r.id)).size===d.runs.length&&new Set(d.runs.map(r=>r.requestId)).size===d.runs.length&&d.runs.every(r=>r&&(r.messages===undefined||validWorkflowMessages(r.messages))&&id(r.id)&&id(r.requestId)&&id(r.taskId)&&validWorkflow(r.workflow)&&states.slice(1).includes(r.status)&&Number.isFinite(r.createdAt)&&(r.error===undefined||(typeof r.error==='string'&&r.error.length<=20000))&&Array.isArray(r.steps)&&new Set(r.steps.map(s=>s?.paneId)).size===r.steps.length&&r.steps.length===r.workflow.steps.length&&r.steps.every((s,i)=>s&&(s.completedBehindGate===undefined||typeof s.completedBehindGate==='boolean')&&s.id===r.workflow.steps[i]!.id&&id(s.paneId)&&states.includes(s.status)&&Number.isSafeInteger(s.attempt)&&s.attempt>0&&typeof s.result==='string'&&s.result.length<=20000&&(s.cwd===undefined||(typeof s.cwd==='string'&&s.cwd.length<=4096&&!s.cwd.includes('\0')&&isAbsolutePath(s.cwd)))&&(s.branch===undefined||(typeof s.branch==='string'&&s.branch.length<=100))))
}
