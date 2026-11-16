import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureWindow, firstWindow, seedState, waitLoaded } from './helpers'
let base:string,repo:string,target:string,data:string,app:ElectronApplication,win:Page
const git=(cwd:string,...args:string[])=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()
test.beforeEach(async()=>{
 base=realpathSync(mkdtempSync(join(tmpdir(),'tm-worktree-ui-')));repo=join(base,'repo');target=join(base,'checkout');data=join(base,'app');mkdirSync(data);mkdirSync(repo);git(repo,'init','-b','main');git(repo,'config','user.name','Test');git(repo,'config','user.email','test@example.invalid');writeFileSync(join(repo,'.gitignore'),'*.cache\n');git(repo,'add','.gitignore');git(repo,'commit','-m','initial');git(repo,'worktree','add','-b','spare',target,'HEAD');seedState(data,[{id:'source',name:'원본',paneId:'shell',cwd:repo}])
 app=await electron.launch({args:['.'],env:{...process.env,TASKMINAL_USER_DATA:data}});win=await firstWindow(app);await waitLoaded(win)
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]!.webContents.send('app:command','worktrees'))
})
test.afterEach(async()=>{try{await win?.evaluate(()=>{window.taskminal.pty.kill('orphan-shell');window.taskminal.pty.kill('ambiguous-shell')})}catch{}await app?.close();rmSync(base,{recursive:true,force:true,maxRetries:5})})
const panel=()=>win.getByRole('region',{name:'워크트리 관리',exact:true})
const row=()=>panel().getByRole('article').filter({hasText:target})
test('명시한 기준으로 checkout을 만들고 같은 요청을 재전송해도 하나이며 일감으로 연다',async()=>{
 const destination=join(base,'new-checkout')
 await panel().getByRole('textbox',{name:'브랜치 이름',exact:true}).fill('feature/ui')
 await panel().getByRole('textbox',{name:'기준 커밋 또는 ref',exact:true}).fill('HEAD')
 await panel().getByRole('textbox',{name:'새 워크트리 폴더의 절대 경로',exact:true}).fill(destination)
 await panel().getByRole('button',{name:'워크트리 만들기',exact:true}).click()
 const created=panel().getByRole('article').filter({hasText:destination});await expect(created).toBeVisible()
 const journal=await app.evaluate(({app})=>app.getPath('userData'))
 const {readFileSync}=await import('node:fs');const receipt=JSON.parse(readFileSync(join(journal,'worktrees/journal.json'),'utf8')).creates[0]
 const duplicate=await win.evaluate(async({root,input})=>window.taskminal.worktrees.create(root,input),{root:repo,input:{requestId:receipt.requestId,base:receipt.base,branch:receipt.branch,path:receipt.path}});expect(duplicate.existing).toBe(true);expect(duplicate.state).toBe('created')
 expect(git(repo,'worktree','list','--porcelain').match(/branch refs\/heads\/feature\/ui/g)).toHaveLength(1)
 await win.screenshot({path:'test-results/worktrees-created.png'})
 await created.getByRole('button',{name:'일감으로 열기'}).click();await expect(panel()).toHaveCount(0)
 await expect(win.getByTestId('task-view').filter({visible:true})).toHaveAttribute('data-task-name','new-checkout')
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]!.webContents.send('app:command','worktrees'))
 const current=panel().getByRole('article').filter({hasText:destination});await expect(current.getByRole('button',{name:'정리…'})).toBeDisabled();await expect(current).toContainText('new-checkout')
})
test('clean checkout만 확인 후 정리하며 확인 뒤 HEAD가 바뀌면 보존한다',async()=>{
 await expect(row().getByRole('button',{name:'정리…'})).toBeEnabled();await row().getByRole('button',{name:'정리…'}).click()
 const confirm=win.getByRole('alertdialog',{name:'워크트리를 정리할까요?'});await expect(confirm).toContainText(target);await win.keyboard.press('Meta+t');await expect(win.locator('[role=tablist] [role=tab]')).toHaveCount(1);await win.keyboard.press('Meta+w');await expect(confirm).toBeVisible();await expect(win.locator('[role=tablist] [role=tab]')).toHaveCount(1);git(target,'commit','--allow-empty','-m','changed')
 await confirm.getByRole('button',{name:'이 워크트리 정리'}).click();await expect(panel().getByRole('alert')).toContainText('바뀌었어요');expect(existsSync(target)).toBe(true)
 await panel().getByRole('button',{name:'목록 새로 읽기'}).click();await expect(row().getByRole('button',{name:'정리…'})).toBeEnabled();await row().getByRole('button',{name:'정리…'}).click();await win.getByRole('alertdialog').getByRole('button',{name:'이 워크트리 정리'}).click()
 await expect(row()).toHaveCount(0);expect(existsSync(target)).toBe(false);expect(git(repo,'branch','--list','spare')).toContain('spare')
})
test('ignored 파일·기본 checkout을 보호하며 작은 창 확대에서 형식 입력과 취소를 유지한다',async()=>{
 writeFileSync(join(target,'keep.cache'),'keep');await panel().getByRole('button',{name:'목록 새로 읽기'}).click();await expect(row()).toContainText('무시하는 파일');await expect(row().getByRole('button',{name:'정리…'})).toBeDisabled()
 const view=await win.evaluate(root=>window.taskminal.worktrees.list(root),repo);const selected=view.entries.find(e=>e.path===target)!
 expect(await win.evaluate(async({root,target})=>{try{await window.taskminal.worktrees.remove(root,target);return false}catch{return true}},{root:repo,target:selected})).toBe(true)
 expect(existsSync(join(target,'keep.cache'))).toBe(true)
 expect(await win.evaluate(async()=>{try{await window.taskminal.worktrees.list('/tmp');return false}catch{return true}})).toBe(true)
 await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0]!;w.setSize(640,400);w.webContents.setZoomFactor(2)});await win.evaluate(()=>document.documentElement.dataset.theme='light')
 const input=panel().getByRole('textbox',{name:'브랜치 이름',exact:true});await input.fill('작은-창');await input.evaluate(e=>e.scrollIntoView({block:'center'}));await expect.poll(()=>input.evaluate(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})).toBe(true);await captureWindow(app,'test-results/worktrees-small-light.png')
 await win.getByRole('button',{name:'작업 보조 화면 닫기'}).click();await expect(panel()).toHaveCount(0)
})
test('일감 목록에 없는 실제 셸도 checkout 사용 중으로 보호한다',async()=>{
 await win.evaluate(cwd=>window.taskminal.pty.spawn('orphan-shell',{cwd,cols:80,rows:24,shell:null,integration:false}),target)
 await expect.poll(()=>win.evaluate(async()=> (await window.taskminal.host.sessions()).some(s=>s.paneId==='orphan-shell'&&!s.exited))).toBe(true)
 await expect.poll(()=>win.evaluate(async root=>(await window.taskminal.worktrees.list(root)).entries.find(e=>e.branch==='refs/heads/spare')?.used,repo)).toBe(true)
 const snapshot=(await win.evaluate(root=>window.taskminal.worktrees.list(root),repo)).entries.find(e=>e.path===target)!
 expect(await win.evaluate(async({root,target})=>{try{await window.taskminal.worktrees.remove(root,target);return false}catch{return true}},{root:repo,target:snapshot})).toBe(true)
 expect(existsSync(target)).toBe(true)
 await win.evaluate(()=>window.taskminal.pty.kill('orphan-shell'))
})
for(const suffix of ['line\npart','slash\\part'])test(`실제 셸 cwd가 모호한 ${JSON.stringify(suffix)}이면 정리를 차단한다`,async()=>{
 const moved=join(base,suffix);git(repo,'worktree','move',target,moved);target=moved
 await win.evaluate(cwd=>window.taskminal.pty.spawn('ambiguous-shell',{cwd,cols:80,rows:24,shell:null,integration:false}),target)
 await expect.poll(()=>win.evaluate(async()=> (await window.taskminal.host.sessions()).some(s=>s.paneId==='ambiguous-shell'&&!s.exited))).toBe(true)
 const snapshot=(await win.evaluate(root=>window.taskminal.worktrees.list(root),repo)).entries.find(e=>e.path===target)!
 expect(snapshot.removable).toBe(false)
 expect(await win.evaluate(async({root,target})=>{try{await window.taskminal.worktrees.remove(root,target);return false}catch{return true}},{root:repo,target:snapshot})).toBe(true)
 expect(existsSync(target)).toBe(true);await win.evaluate(()=>window.taskminal.pty.kill('ambiguous-shell'))
})

// 56단계: 만든 워크트리에서 바로 환경 준비로 — 절대 경로를 다시 치지 않고, 형식 설명 · 명령은 읽을 꼴로
test('워크트리 카드의 환경 준비… 는 그 워크트리를 고른 채 환경 준비 패널을 열고, 명령은 한 줄로 보인다',async()=>{
 mkdirSync(join(repo,'.taskminal'));writeFileSync(join(repo,'.taskminal/environment.json'),JSON.stringify({copies:[],commands:[{file:'echo',args:['hello world',"it's"]}]}))
 await expect(row().getByRole('button',{name:'환경 준비…'})).toBeEnabled()
 // 기본 워크트리(저장소 자신)에는 없다
 await expect(panel().getByRole('article').filter({hasText:'기본'}).getByRole('button',{name:'환경 준비…'})).toHaveCount(0)
 await row().getByRole('button',{name:'환경 준비…'}).click()
 const dev=win.getByTestId('development-panel');await expect(dev).toBeVisible()
 const pick=dev.getByRole('combobox',{name:'준비할 워크트리'})
 await expect(pick).toHaveValue(target)
 await expect(pick.locator(`option[value="${repo}"]`)).toHaveCount(0)
 await expect(dev.locator('details.development-format')).not.toHaveAttribute('open',/.*/)
 await dev.getByRole('button',{name:'환경 준비 미리보기',exact:true}).click()
 const preview=dev.getByTestId('environment-preview')
 await expect(preview.locator('pre')).toHaveText(`echo 'hello world' 'it'\\''s'`)
 await expect(preview).not.toContainText('"file"')
})
// 만드는 중 · 읽는 중(busy)에는 환경 준비로 넘어가지 않는다 — 목록 읽기를 붙잡아 둔 사이 꺼져 있다
test('목록을 읽는 동안 환경 준비… 는 꺼져 있다',async()=>{
 await expect(row().getByRole('button',{name:'환경 준비…'})).toBeEnabled()
 await app.evaluate(({ipcMain})=>{
  const handlers=(ipcMain as unknown as {_invokeHandlers:Map<string,(...args:unknown[])=>Promise<unknown>>})._invokeHandlers
  const original=handlers.get('worktrees:list')!
  ipcMain.removeHandler('worktrees:list');ipcMain.handle('worktrees:list',async(...args)=>{await new Promise(r=>(globalThis as unknown as {releaseList:()=>void}).releaseList=r as ()=>void);return original(...args)})
 })
 await panel().getByRole('button',{name:'목록 새로 읽기'}).click()
 await expect(row().getByRole('button',{name:'환경 준비…'})).toBeDisabled()
 await app.evaluate(()=>(globalThis as unknown as {releaseList:()=>void}).releaseList())
 await expect(row().getByRole('button',{name:'환경 준비…'})).toBeEnabled()
})
