import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { captureWindow, firstWindow, seedState, waitLoaded } from './helpers'
let data:string,app:ElectronApplication,win:Page
const workflow={id:'wf',name:'점검 흐름',steps:[{id:'one',name:'점검',agent:'claude',prompt:'slow',after:[]}]}
test.beforeEach(async()=>{
 data=mkdtempSync(join(tmpdir(),'tm-schedules-'));seedState(data,[{id:'task',name:'예약 일감',paneId:'shell',cwd:data}]);mkdirSync(join(data,'workflows'));writeFileSync(join(data,'workflows/journal.json'),JSON.stringify({templates:[workflow],runs:[]}))
})
test.afterEach(async()=>{await app?.close();rmSync(data,{recursive:true,force:true,maxRetries:5})})
async function launch(){app=await electron.launch({args:['.'],env:{...process.env,TASKMINAL_USER_DATA:data,TASKMINAL_CLAUDE_BIN:resolve('tests/fixtures/fake-claude.mjs'),FAKE_CLAUDE_LOG:join(data,'claude.log')}});win=await firstWindow(app);await waitLoaded(win)}
test('기본 일시정지로 저장하고 지금 실행·중복 방지·결과 열기·중단 이력을 확인한다',async()=>{
 await launch();await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]!.webContents.send('app:command','schedules'))
 const panel=win.getByRole('region',{name:'예약과 결과함'})
 await panel.getByRole('button',{name:'새 예약',exact:true}).click();await panel.getByRole('textbox',{name:'예약 이름'}).fill('내 점검');await panel.getByRole('button',{name:'저장',exact:true}).click()
 await expect(panel.getByRole('article',{name:'내 점검'})).toContainText('일시정지')
 expect((await win.evaluate(()=>window.taskminal.schedules.view())).schedules[0]!.enabled).toBe(false);expect(existsSync(join(data,'claude.log'))).toBe(false)
 const id=(await win.evaluate(()=>window.taskminal.schedules.view())).schedules[0]!.id
 const first=await win.evaluate(id=>window.taskminal.schedules.runNow(id,'manual'),id);const second=await win.evaluate(id=>window.taskminal.schedules.runNow(id,'manual'),id);expect(second.id).toBe(first.id)
 await expect.poll(()=>existsSync(join(data,'claude.log'))).toBe(true)
 await win.evaluate(id=>window.taskminal.workflows.stop(id),first.runId!)
 await expect.poll(()=>win.evaluate(async()=> (await window.taskminal.schedules.view()).schedules[0]?.history[0]?.status)).toBe('stopped')
 await panel.getByText('실행 이력 (1)',{exact:true}).click();await panel.getByRole('button',{name:'실행 결과 열기'}).click();await expect(win.getByRole('region',{name:'작업 흐름',exact:true})).toContainText('중지됨')
 expect(readFileSync(join(data,'claude.log'),'utf8').split('\n').filter(l=>l.includes('"argv"'))).toHaveLength(1)
 await expect(win.locator('#workflow-run-'+first.runId)).toBeFocused()
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]!.webContents.send('app:command','schedules'))
 await panel.getByText('실행 이력 (1)',{exact:true}).click()
 const snapshot=await win.evaluate(()=>window.taskminal.workflows.view())
 await app.evaluate(({ipcMain})=>{
  const g=globalThis as unknown as {pendingWorkflowReads?: Array<(value:unknown)=>void>};g.pendingWorkflowReads=[]
  ipcMain.removeHandler('workflows:view');ipcMain.handle('workflows:view',()=>new Promise(resolve=>g.pendingWorkflowReads!.push(resolve)))
 })
 await panel.getByRole('button',{name:'실행 결과 열기'}).click()
 await expect.poll(()=>app.evaluate(()=>(globalThis as unknown as {pendingWorkflowReads:unknown[]}).pendingWorkflowReads.length)).toBeGreaterThan(0)
 await win.getByRole('button',{name:'작업 보조 화면 닫기'}).click()
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]!.webContents.send('app:command','schedules'))
 await expect(panel).toBeVisible()
 await app.evaluate((_e,value)=>{for(const resolve of (globalThis as unknown as {pendingWorkflowReads:Array<(value:unknown)=>void>}).pendingWorkflowReads)resolve(value)},snapshot)
 await win.waitForTimeout(150)
 await expect(panel).toBeVisible();await expect(win.getByRole('region',{name:'작업 흐름',exact:true})).toHaveCount(0)

})
test('종료 동안 놓친 예약을 실행하지 않고 놓침 이력과 다음 미래 시각을 남긴다',async()=>{
 mkdirSync(join(data,'schedules'));writeFileSync(join(data,'schedules/journal.json'),JSON.stringify({schedules:[{id:'sched',name:'놓친 점검',taskId:'task',workflowId:'wf',enabled:true,timing:{kind:'interval',minutes:5},nextAt:Date.now()-600000,history:[]}],requests:[]}))
 await launch();const view=await win.evaluate(()=>window.taskminal.schedules.view());expect(view.schedules[0]?.history[0]?.status).toBe('missed');expect(view.schedules[0]!.nextAt).toBeGreaterThan(Date.now());expect(existsSync(join(data,'claude.log'))).toBe(false)
 await app.evaluate(({powerMonitor})=>powerMonitor.emit('resume'));expect((await win.evaluate(()=>window.taskminal.schedules.view())).schedules[0]!.history).toHaveLength(1)
 await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0]!;w.setSize(640,400);w.webContents.setZoomFactor(2);w.webContents.send('app:command','schedules')});await win.evaluate(()=>document.documentElement.dataset.theme='light')
 const panel=win.getByRole('region',{name:'예약과 결과함'});await panel.getByRole('button',{name:'일시정지',exact:true}).click();await expect(panel).toContainText('예약 없음')
 await panel.getByRole('button',{name:'삭제…',exact:true}).click();const confirm=win.getByRole('alertdialog',{name:'예약 삭제'});await expect(confirm.getByRole('button',{name:'취소'})).toBeFocused();await confirm.getByRole('button',{name:'취소'}).click()
 await panel.getByRole('button',{name:'새 예약',exact:true}).evaluate(e=>e.scrollIntoView({block:'start'}));await expect.poll(()=>panel.evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);await captureWindow(app,'test-results/schedules-small-light.png')
})
