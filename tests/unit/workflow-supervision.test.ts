import { expect,test } from 'vitest'
import { WorkflowRunner,type WorkflowDeps } from '../../src/main/workflow-runner'
import type { WorkflowView } from '../../src/shared/workflows'
function fixture(){let i=0;let state:WorkflowView={templates:[],runs:[]};const runner=new WorkflowRunner({load:()=>state,save:s=>{state=structuredClone(s)}},{id:()=>`id-${++i}`,now:()=>1,validTask:()=>true,validPane:()=>true,pin(){},prepare:async()=>{},send:async()=> 'ok',close(){},redact:s=>s.replaceAll('SECRET','MASK')} satisfies WorkflowDeps);runner.save({id:'flow',name:'flow',steps:[{id:'first',name:'first',agent:'claude',prompt:'run',after:[]}]});const id=runner.start({requestId:'start',taskId:'task',workflowId:'flow'});return {runner,id}}
test('adds an idempotent dependency task to a live run, and resumes after a fenced question answer',async()=>{
 const {runner,id}=fixture();await runner.idle();const first=runner.view().runs[0]!.steps[0]!
 const extra={id:'extra',name:'SECRET review',agent:'codex' as const,prompt:'review',after:['first']}
 runner.append(id,extra);runner.append(id,{after:['first'],prompt:'review',agent:'codex',name:'SECRET review',id:'extra'});expect(runner.view().runs[0]!.steps).toHaveLength(2)
 runner.message(id,{id:'question',stepId:first.id,paneId:first.paneId,attempt:first.attempt,kind:'question',text:'SECRET question'})
 runner.message(id,{text:'SECRET question',kind:'question',attempt:first.attempt,paneId:first.paneId,stepId:first.id,id:'question'})
 expect(runner.view().runs[0]!.messages).toHaveLength(1)
 expect(runner.view().runs[0]!.messages?.[0]?.text).toBe('MASK question')
 runner.event(first.paneId,{t:'turn_end',ok:true,ms:1,reason:'done'});await runner.idle()
 expect(runner.view().runs[0]!.steps[0]!.status).toBe('waiting')
 runner.answerMessage(id,'question','continue')
 await runner.idle();expect(runner.view().runs[0]!.steps[0]!.status).toBe('done')
 expect(runner.view().runs[0]!.steps[1]!.status).toBe('running')
 runner.answerMessage(id,'question','continue')
 expect(()=>runner.answerMessage(id,'question','changed')).toThrow()
 runner.dispose()
})
test('rejects old attempt identity, changed task retries, missing dependencies and late answers',async()=>{
 const {runner,id}=fixture();await runner.idle();const s=runner.view().runs[0]!.steps[0]!
 expect(()=>runner.message(id,{id:'old',stepId:s.id,paneId:s.paneId,attempt:0,kind:'question',text:'late'})).toThrow()
 expect(()=>runner.append(id,{id:'bad',name:'bad',agent:'claude',prompt:'bad',after:['missing']})).toThrow()
 runner.message(id,{id:'q',stepId:s.id,paneId:s.paneId,attempt:1,kind:'question',text:'question'})
 runner.stop(id);runner.retry(id);await runner.idle()
 expect(()=>runner.answerMessage(id,'q','late')).toThrow()
 runner.dispose()
})

test('task model preferences are bounded values and cannot inject CLI flags',async()=>{
 const {runner,id}=fixture();await runner.idle()
 expect(()=>runner.append(id,{id:'bad-model',name:'bad',agent:'claude',prompt:'bad',after:[],model:'--permission-mode=auto'})).toThrow()
 expect(()=>runner.append(id,{id:'bad-effort',name:'bad',agent:'codex',prompt:'bad',after:[],effort:'high'})).toThrow()
 runner.append(id,{id:'model',name:'model',agent:'codex',prompt:'run',after:['first'],model:'custom-model',effort:'high'})
 expect(runner.view().runs[0]!.workflow.steps[1]).toMatchObject({model:'custom-model',effort:'high'})
 runner.dispose()
})
test('completed run cannot reopen while another run owns the same task',async()=>{
 const {runner,id}=fixture();await runner.idle();const step=runner.view().runs[0]!.steps[0]!
 runner.event(step.paneId,{t:'turn_end',ok:true,ms:1,reason:'done'});await runner.idle()
 expect(runner.view().runs[0]!.status).toBe('done')
 runner.start({requestId:'second',taskId:'task',workflowId:'flow'});await runner.idle()
 expect(()=>runner.append(id,{id:'late',name:'late',agent:'claude',prompt:'late',after:[]})).toThrow('앞 실행')
 expect(runner.view().runs.find(r=>r.id===id)?.status).toBe('done');runner.dispose()
})
