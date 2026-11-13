import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { firstWindow, seedState, waitLoaded } from './helpers'
import type { Workflow } from '../../src/shared/workflows'
let data:string,app:ElectronApplication,win:Page
const workflow:Workflow={id:'wf',name:'구현 검토',steps:[{id:'first',name:'허락',agent:'claude',prompt:'perm',after:[]},{id:'second',name:'검토',agent:'codex',prompt:'review',after:['first']}]}
test.beforeEach(async()=>{
 data=mkdtempSync(join(tmpdir(),'tm-workflows-e2e-'));seedState(data,[{id:'task',name:'작업',paneId:'shell',cwd:data}])
 app=await electron.launch({args:['.'],env:{...process.env,TASKMINAL_USER_DATA:data,TASKMINAL_CLAUDE_BIN:resolve('tests/fixtures/fake-claude.mjs'),TASKMINAL_CODEX_BIN:resolve('tests/fixtures/fake-codex.mjs'),FAKE_CLAUDE_LOG:join(data,'claude.log')}})
 win=await firstWindow(app);await waitLoaded(win)
})
test.afterEach(async()=>{await app?.close();rmSync(data,{recursive:true,force:true,maxRetries:5})})
async function start(){return win.evaluate(async w=>{await window.taskminal.workflows.save(w);return window.taskminal.workflows.start({requestId:'request',taskId:'task',workflowId:w.id})},workflow)}
test('전용 대화를 저장하고 허락 뒤에만 다음 단계로 이동하며 중복 요청은 하나로 남긴다',async()=>{
 const id=await start();await expect.poll(()=>win.evaluate(async()=> (await window.taskminal.workflows.view()).runs[0]?.status)).toBe('waiting')
 expect(await start()).toBe(id)
 const state=JSON.parse(readFileSync(join(data,'state.json'),'utf8'));const pane=Object.values(state.tasks[0].panes).find((p:any)=>p.workflowRunId===id) as {id:string}
 expect(pane).toBeTruthy();expect(readFileSync(join(data,'claude.log'),'utf8')).not.toContain('bypassPermissions')
 expect(await win.evaluate(p=>window.taskminal.chat.send(p,'ordinary','/tmp',{agent:'claude'}),pane.id)).not.toBe('ok')
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]!.webContents.send('app:command','workflows'))
 await win.screenshot({path:'test-results/workflows-waiting.png'})
 await win.getByRole('button',{name:'대화 열기',exact:true}).first().click()
 await expect(win.getByText('작업 흐름의 전용 대화', {exact:false})).toBeVisible()
 await win.getByTestId('chat-pane').filter({visible:true}).getByRole('button',{name:'허락 ↩',exact:true}).click()
 await expect.poll(()=>win.evaluate(async()=> (await window.taskminal.workflows.view()).runs[0]?.status)).toBe('done')
 const result=await win.evaluate(()=>window.taskminal.workflows.view());expect(result.runs).toHaveLength(1);expect(result.runs[0]?.steps.map(s=>s.status)).toEqual(['done','done'])
})
test('중단은 실행 대화만 닫고 다시 시작하면 자동 재전송하지 않는다',async()=>{
 workflow.steps[0]!.prompt='slow'
 await start();await expect.poll(()=>win.evaluate(async()=> (await window.taskminal.workflows.view()).runs[0]?.status)).toBe('running')
 await app.close();app=await electron.launch({args:['.'],env:{...process.env,TASKMINAL_USER_DATA:data,TASKMINAL_CLAUDE_BIN:resolve('tests/fixtures/fake-claude.mjs'),FAKE_CLAUDE_LOG:join(data,'claude.log')}});win=await firstWindow(app);await waitLoaded(win)
 const run=(await win.evaluate(()=>window.taskminal.workflows.view())).runs[0]!
 expect(['stopped','unknown']).toContain(run.status)
 expect(readFileSync(join(data,'claude.log'),'utf8').split('\n').filter(l=>l.includes('"argv"'))).toHaveLength(1)
 workflow.steps[0]!.prompt='perm'
})

test('작업 흐름 편집과 작은 창 확대에서 저장·취소에 접근한다',async()=>{
 await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0]!;w.setSize(640,400);w.webContents.setZoomFactor(2);w.webContents.send('app:command','workflows')})
 await win.evaluate(()=>document.documentElement.dataset.theme='light')
 const panel=win.getByRole('region',{name:'작업 흐름',exact:true})
 await panel.getByRole('button',{name:'새로 만들기',exact:true}).click()
 await panel.getByRole('textbox',{name:'흐름 이름',exact:true}).fill('화면 점검')
 await panel.getByRole('textbox',{name:'단계 이름',exact:true}).fill('단계')
 await panel.getByRole('textbox',{name:'보낼 지시',exact:true}).fill('check')
 await panel.getByRole('button',{name:'저장',exact:true}).click()
 await expect(panel.getByRole('combobox',{name:'저장된 작업 흐름'})).not.toHaveValue('')
 await expect.poll(()=>panel.evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true)
 await panel.getByRole('button',{name:'새로 만들기',exact:true}).scrollIntoViewIfNeeded()
 await expect(panel.getByRole('button',{name:'새로 만들기',exact:true})).toBeInViewport()
 await win.screenshot({path:'test-results/workflows-small-light.png'})
 await panel.getByRole('button',{name:'삭제',exact:true}).click()
 await win.getByRole('alertdialog',{name:'작업 흐름 삭제'}).getByRole('button',{name:'취소'}).click()
 expect((await win.evaluate(()=>window.taskminal.workflows.view())).templates).toHaveLength(1)
})
for(const route of ['reload','crash','close-window'] as const)test(`실행 중 ${route} 후 자동 재전송 없이 중단하고 기존 셸을 남긴다`,async()=>{
 await win.evaluate(async()=>{await window.taskminal.workflows.save({id:'wf',name:'느린 흐름',steps:[{id:'first',name:'대기',agent:'claude',prompt:'slow',after:[]}]});await window.taskminal.workflows.start({requestId:'lifecycle',taskId:'task',workflowId:'wf'})})
 await expect.poll(()=>win.evaluate(async()=> (await window.taskminal.workflows.view()).runs[0]?.status)).toBe('running')
 await expect.poll(()=>existsSync(join(data,'claude.log'))).toBe(true)
 if(route==='close-window'){
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]!.close())
  await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length)).toBe(0)
  await app.evaluate(({app})=>app.emit('activate'));win=await firstWindow(app)
 }else if(route==='crash')await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]!.webContents.forcefullyCrashRenderer())
 else await win.reload()
 if(route==='crash'){
  await expect.poll(()=>app.evaluate(({BrowserWindow})=>{const wc=BrowserWindow.getAllWindows()[0]!.webContents;return wc.isCrashed()||wc.isLoading()?'loading':wc.executeJavaScript('window.taskminal.workflows.view().then(v=>v.runs[0]?.status)')}),{timeout:15000}).toBe('stopped')
 }else{await waitLoaded(win);await expect.poll(()=>win.evaluate(async()=> (await window.taskminal.workflows.view()).runs[0]?.status)).toBe('stopped')} 
 expect(JSON.parse(readFileSync(join(data,'state.json'),'utf8')).tasks[0].panes.shell).toBeTruthy()
 expect(readFileSync(join(data,'claude.log'),'utf8').split('\n').filter(l=>l.includes('"argv"'))).toHaveLength(1)
})
