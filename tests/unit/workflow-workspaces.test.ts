import { afterEach, expect, test } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { WorkflowWorkspaces } from '../../src/main/workflow-workspaces'
import type { WorkflowRun } from '../../src/shared/workflows'
const dirs:string[]=[]
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true})})
test('real worker checkouts are distinct, retries reuse edits, source stays untouched',async()=>{
 const root=mkdtempSync(join(tmpdir(),'tm-workers-'));dirs.push(root)
 const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8'})
 git('init','-q');git('config','user.name','test');git('config','user.email','test@example.invalid');git('config','commit.gpgsign','false')
 writeFileSync(join(root,'code'),'original');git('add','.');git('commit','-qm','base')
 const run:WorkflowRun={id:'run',requestId:'request',taskId:'task',createdAt:1,status:'preparing',workflow:{id:'wf',name:'workers',isolate:true,maxParallel:2,steps:[]},steps:['a'.repeat(100),'b'].map(id=>({id,paneId:id,attempt:1,status:'preparing',result:''}))}
 const workers=new WorkflowWorkspaces(join(root,'data'))
 const a=await workers.prepare(root,run,run.steps[0]!),b=await workers.prepare(root,run,run.steps[1]!)
 expect(a).not.toBe(b);expect(run.baseOid).toMatch(/^[a-f0-9]{40}$/)
 writeFileSync(join(a,'code'),'worker edits')
 expect(await workers.prepare(root,run,run.steps[0]!)).toBe(a)
 expect(readFileSync(join(a,'code'),'utf8')).toBe('worker edits')
 expect(readFileSync(join(b,'code'),'utf8')).toBe('original')
 expect(readFileSync(join(root,'code'),'utf8')).toBe('original')
 expect(git('worktree','list','--porcelain').match(/worktree /g)).toHaveLength(3)
})
