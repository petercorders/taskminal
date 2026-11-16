import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AtomicJournal } from '../../src/main/atomic-journal'
import { WorkflowRunner, type WorkflowDeps } from '../../src/main/workflow-runner'
import { validWorkflow, validWorkflowView, type Workflow, type WorkflowView } from '../../src/shared/workflows'
let dir:string
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'tm-workflows-'))})
afterEach(()=>rmSync(dir,{recursive:true,force:true}))
const workflow:Workflow={id:'wf',name:'검토',steps:[{id:'s1',name:'구현',agent:'claude',prompt:'implement',after:[]},{id:'s2',name:'리뷰',agent:'codex',prompt:'review',after:['s1']}]}
function fixture(overrides:Partial<WorkflowDeps>={}){
 let seq=0
 const prepared=new Set<string>(),closed:string[]=[],sent:Array<{pane:string;text:string}>=[],pins:Array<{pane:string;previous?:string}>=[]
 const store=new AtomicJournal<WorkflowView>(join(dir,'flows.json'),validWorkflowView)
 const deps:WorkflowDeps={id:()=>`id-${++seq}`,now:()=>10,validTask:()=>true,validPane:(_t,p)=>prepared.has(p),pin:(_r,s,previous)=>{pins.push({pane:s.paneId,previous})},prepare:async(_r,s)=>{prepared.add(s.paneId)},send:async(_r,s,text)=>{sent.push({pane:s.paneId,text});return 'ok'},close:p=>{closed.push(p)},redact:text=>text.replaceAll('PRIVATE','가림'),...overrides}
 const runner=new WorkflowRunner(store,deps);runner.save(workflow)
 return {runner,store,deps,closed,sent,pins,prepared}
}
const start=(runner:WorkflowRunner)=>runner.start({requestId:'request',taskId:'task',workflowId:'wf'})
test('validates DAG and rejects duplicate/missing dependencies, cycles and too many steps',()=>{
 expect(validWorkflow(workflow)).toBe(true)
 expect(validWorkflow({...workflow,steps:[{...workflow.steps[0]!,after:['s2']},workflow.steps[1]!]})).toBe(false)
 expect(validWorkflow({...workflow,steps:[{...workflow.steps[0]!,after:['missing']}]})).toBe(false)
 expect(validWorkflow({...workflow,steps:Array.from({length:11},(_,i)=>({...workflow.steps[0]!,id:`s${i}`}))})).toBe(false)
})
test('pins all accounts once, executes dependency steps sequentially and deduplicates requests',async()=>{
 const {runner,sent,pins}=fixture();const id=start(runner);expect(start(runner)).toBe(id)
 await runner.idle();expect(sent).toHaveLength(1);expect(pins).toHaveLength(2)
 const first=runner.view().runs[0]!.steps[0]!.paneId
 runner.event(first,{t:'text',text:'PRIVATE result'});runner.event(first,{t:'turn_end',ok:true,ms:1,reason:'done'})
 await runner.idle();expect(sent).toHaveLength(2);expect(sent[1]!.text).toContain('가림 result');expect(sent[1]!.text).toContain('비신뢰')
 const second=runner.view().runs[0]!.steps[1]!.paneId
 runner.event(second,{t:'turn_end',ok:true,ms:1,reason:'done'});await runner.idle()
 expect(runner.view().runs[0]!.status).toBe('done')
 expect(readFileSync(join(dir,'flows.json'),'utf8')).not.toContain('PRIVATE')
 expect(statSync(join(dir,'flows.json')).mode&0o777).toBe(0o600)
})
test('permission waits do not advance until actual successful turn completion',async()=>{
 const {runner,sent}=fixture();start(runner);await runner.idle();const pane=sent[0]!.pane
 runner.event(pane,{t:'permission',id:'p',tool:'Bash',summary:'check',why:'ask',danger:false});await runner.idle()
 expect(runner.view().runs[0]!.status).toBe('waiting');expect(sent).toHaveLength(1)
 runner.event(pane,{t:'answered',id:'p',how:'allow'});await runner.idle();expect(runner.view().runs[0]!.status).toBe('running');expect(sent).toHaveLength(1)
})
test('retry uses a new pane and old account binding; completed steps never rerun and old events cannot settle retry',async()=>{
 const {runner,sent,pins}=fixture();const id=start(runner);await runner.idle();const first=sent[0]!.pane
 runner.event(first,{t:'turn_end',ok:true,ms:1,reason:'done'});await runner.idle();const failed=sent[1]!.pane
 runner.event(failed,{t:'error',kind:'other',message:'fail'});await runner.idle();runner.retry(id);await runner.idle()
 expect(sent).toHaveLength(3);expect(sent[2]!.pane).not.toBe(failed);expect(pins.at(-1)?.previous).toBe(failed)
 runner.event(failed,{t:'turn_end',ok:true,ms:1,reason:'late'});await runner.idle();expect(runner.view().runs[0]!.status).toBe('running')
 expect(runner.view().runs[0]!.steps[0]!.attempt).toBe(1)
})
test('stop during preparation never sends and closes only owned pane',async()=>{
 let finish:(()=>void)|undefined
 const {runner,sent,closed}=fixture({validPane:()=>true,prepare:async()=>new Promise<void>(r=>{finish=r})})
 const id=start(runner);await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));runner.stop(id);finish!();await runner.idle()
 expect(sent).toEqual([]);expect(closed).toHaveLength(1);expect(runner.view().runs[0]!.status).toBe('stopped')
})
test('synchronous missing-command event is not overwritten by send return; deleted pane stops the run',async()=>{
 let runner:WorkflowRunner
 const f=fixture({send:async(_r,s)=>{runner.event(s.paneId,{t:'error',kind:'missing',message:'missing'});return 'missing'}});runner=f.runner
 start(runner);await runner.idle();expect(runner.view().runs[0]!.status).toBe('failed')
})
test('restart interrupts active or not-yet-started journal without resending',async()=>{
 const {runner,store,deps}=fixture();start(runner);await runner.idle()
 const send=vi.fn(async()=> 'ok')
 const next=new WorkflowRunner(store,{...deps,send});expect(next.view().runs[0]!.status).toBe('unknown');await next.idle();expect(send).not.toHaveBeenCalled()
 const snapshot=next.view();snapshot.runs[0]!.status='preparing';for(const step of snapshot.runs[0]!.steps)step.status='pending';store.save(snapshot)
 const queued=new WorkflowRunner(store,{...deps,send});queued.retry(snapshot.runs[0]!.id);await queued.idle();expect(send).toHaveBeenCalledTimes(1)
})
test('corrupt journal preserves bytes and blocks writes instead of replacing with empty state',()=>{
 const file=join(dir,'bad.json');writeFileSync(file,'broken')
 const store=new AtomicJournal<WorkflowView>(file,validWorkflowView),runner=new WorkflowRunner(store,fixture().deps)
 expect(()=>runner.view()).toThrow();expect(()=>runner.save(workflow)).toThrow();expect(readFileSync(file,'utf8')).toBe('broken')
})
test('journal write failure prevents later sends and target deletion closes current run',async()=>{
 const {runner,deps,closed}=fixture();start(runner);await runner.idle();deps.validTask=()=>false;runner.reconcile();expect(closed).toHaveLength(1);expect(runner.view().runs[0]!.status).toBe('stopped')
 const badStore={load:()=>({templates:[workflow],runs:[]}),save:()=>{throw new Error('disk full')}}
 const send=vi.fn(async()=> 'ok'),bad=new WorkflowRunner(badStore,{...deps,validTask:()=>true,send})
 expect(()=>start(bad)).toThrow('disk full');await bad.idle();expect(send).not.toHaveBeenCalled()
})
test('current redaction applies to old persisted templates and split result chunks before forwarding',async()=>{
 const {runner,deps,sent}=fixture();runner.save({...workflow,name:'later-secret',steps:workflow.steps.map(s=>({...s,prompt:'later-secret'}))})
 deps.redact=t=>t.replaceAll('later-secret','masked')
 expect(runner.view().templates[0]!.name).toBe('masked')
 start(runner);await runner.idle();runner.event(sent[0]!.pane,{t:'text',text:'later-'});runner.event(sent[0]!.pane,{t:'text',text:'secret'});runner.event(sent[0]!.pane,{t:'turn_end',ok:true,ms:1,reason:'done'});await runner.idle()
 expect(sent[1]!.text).not.toContain('later-secret');expect(readFileSync(join(dir,'flows.json'),'utf8')).not.toContain('later-secret')
})
test('provider acceptance timeout records unknown and never advances or automatically retries',async()=>{
 const {runner,sent}=fixture();start(runner);await runner.idle()
 runner.event(sent[0]!.pane,{t:'error',kind:'other',message:'uncertain',uncertain:true});await runner.idle()
 expect(runner.view().runs[0]!.status).toBe('unknown');expect(runner.view().runs[0]!.steps[0]!.status).toBe('unknown');expect(sent).toHaveLength(1)
})

test('parallel isolated DAG starts independent workers and joins only after both finish',async()=>{
 const {runner,sent}=fixture()
 runner.save({...workflow,maxParallel:2,isolate:true,steps:[{...workflow.steps[0]!,id:'a',after:[]},{...workflow.steps[0]!,id:'b',after:[]},{...workflow.steps[1]!,id:'join',after:['a','b']}]})
 start(runner);await runner.idle();expect(sent).toHaveLength(2)
 const first=runner.view().runs[0]!
 runner.event(first.steps[0]!.paneId,{t:'turn_end',ok:true,ms:1,reason:'done'});await runner.idle();expect(sent).toHaveLength(2)
 runner.event(first.steps[1]!.paneId,{t:'turn_end',ok:true,ms:1,reason:'done'});await runner.idle();expect(sent).toHaveLength(3)
 expect(runner.view().runs[0]!.steps[2]!.status).toBe('running')
})
test('parallel failure fences siblings and retry never reruns successful steps',async()=>{
 const {runner,sent,closed}=fixture()
 runner.save({...workflow,maxParallel:3,isolate:true,steps:['a','b','c'].map(id=>({...workflow.steps[0]!,id,after:[]}))})
 const id=start(runner);await runner.idle();expect(sent).toHaveLength(3)
 const run=runner.view().runs[0]!
 runner.event(run.steps[0]!.paneId,{t:'turn_end',ok:true,ms:1,reason:'done'});await runner.idle()
 runner.event(run.steps[1]!.paneId,{t:'error',kind:'other',message:'failure'});await runner.idle()
 expect(runner.view().runs[0]!.steps[2]!.status).toBe('stopped');expect(closed).toContain(run.steps[2]!.paneId)
 runner.retry(id);await runner.idle();expect(sent).toHaveLength(5)
 expect(runner.view().runs[0]!.steps[0]!.attempt).toBe(1)
})
test('parallel shared cwd is rejected and old templates keep sequential behavior',()=>{
 expect(validWorkflow({...workflow,maxParallel:2})).toBe(false)
 expect(validWorkflow({...workflow,maxParallel:5,isolate:true})).toBe(false)
 expect(validWorkflow(workflow)).toBe(true)
})

test('late preparation of a stopped attempt cannot claim retry panes or dispatch reserved sibling attempts',async()=>{
 let release:(()=>void)|undefined;let prepares=0
 const f=fixture({validPane:()=>true,prepare:async(_run,_step,current)=>{prepares++;if(prepares===1){await new Promise<void>(r=>{release=r});expect(current?.()).toBe(false)}}})
 f.runner.save({...workflow,maxParallel:2,isolate:true,steps:workflow.steps.map(s=>({...s,after:[]}))})
 const id=start(f.runner);await vi.waitFor(()=>expect(release).toBeTypeOf('function'))
 f.runner.stop(id);f.runner.retry(id);release!();await f.runner.idle()
 expect(prepares).toBe(3);expect(f.sent).toHaveLength(2)
 expect(new Set(f.sent.map(s=>s.pane)).size).toBe(2)
 expect(f.runner.view().runs[0]!.steps.map(s=>s.attempt)).toEqual([2,2])
})
