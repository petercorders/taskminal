import { mkdir, realpath } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import type { WorkflowRun, RunStep } from '../shared/workflows'
import { validWorktreeJournal, type WorktreeJournalState } from '../shared/worktree-management'
import { AtomicJournal } from './atomic-journal'
import { WorktreeManagement, makeWorktreeGit } from './worktree-management'

/** Checkouts survive failure/stop. Only an explicit worktree cleanup removes them. */
export class WorkflowWorkspaces {
  private readonly service: WorktreeManagement
  constructor(private readonly data: string) {
    this.service = new WorktreeManagement({journal:new AtomicJournal<WorktreeJournalState>(join(data,'journal.json'),validWorktreeJournal)})
  }
  async prepare(root: string, run: WorkflowRun, step: RunStep): Promise<string> {
    const canonical = await realpath(root==='~'?homedir():root.startsWith('~/')?resolve(homedir(),root.slice(2)):root)
    if (run.root && run.root!==canonical) throw new Error('실행 도중 일감 폴더가 바뀌었어요')
    run.root=canonical
    if (!run.workflow.isolate) return canonical
    if (!run.baseOid) {
      const head=await makeWorktreeGit()(canonical,['rev-parse','--verify','HEAD^{commit}'])
      if(head.code!==0||!/^[a-f0-9]{40,64}$/.test(head.stdout.trim()))throw new Error('격리 실행에는 커밋이 있는 Git 저장소가 필요해요')
      run.baseOid=head.stdout.trim()
    }
    const suffix=createHash('sha256').update(run.id+':'+step.id).digest('hex').slice(0,40)
    const path=join(this.data,run.id,step.id),branch=`taskminal/worker-${suffix}`
    if(step.cwd&&step.cwd!==path)throw new Error('worker 작업 경로가 바뀌었어요')
    if(step.branch&&step.branch!==branch)throw new Error('worker 브랜치가 바뀌었어요')
    step.cwd=path;step.branch=branch
    const existing=(await this.service.list(canonical,[])).entries.find(e=>e.path===path)
    if(existing){
      if(existing.branch!==`refs/heads/${branch}`||existing.bare||existing.prunable||existing.locked)throw new Error('기존 worker worktree를 확인해 주세요')
      return path
    }
    await mkdir(dirname(path),{recursive:true,mode:0o700})
    const result=await this.service.create(canonical,{requestId:`worker-${suffix}`,branch,base:run.baseOid,path})
    if(result.state!=='created')throw new Error('worktree 생성 결과 확인 필요: '+result.message)
    return result.path
  }
}
