import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { firstWindow, seedState, waitLoaded, captureWindow } from './helpers'
let data:string,app:ElectronApplication,win:Page
const workflow={id:'wf',name:'저장된 흐름',steps:[{id:'one',name:'점검',agent:'claude',prompt:'hello',after:[]}]}
async function command(cmd:string){await app.evaluate(({BrowserWindow},cmd)=>BrowserWindow.getAllWindows()[0]!.webContents.send('app:command',cmd),cmd)}
test.beforeEach(async()=>{
 data=mkdtempSync(join(tmpdir(),'tm-panel-ux-'));seedState(data,[{id:'task',name:'첫 일감',paneId:'shell',cwd:data},{id:'other',name:'둘째 일감',paneId:'other-shell',cwd:data}]);mkdirSync(join(data,'workflows'));writeFileSync(join(data,'workflows/journal.json'),JSON.stringify({templates:[workflow],runs:[]}))
 app=await electron.launch({args:['.'],env:{...process.env,TASKMINAL_USER_DATA:data,TASKMINAL_CLAUDE_BIN:resolve('tests/fixtures/fake-claude.mjs')}});win=await firstWindow(app);await waitLoaded(win)
})
test.afterEach(async()=>{await app?.close();rmSync(data,{recursive:true,force:true,maxRetries:5})})
test('작업 흐름·예약 초안은 패널과 일감 전환에서 보존하고 명시적으로만 버린다',async()=>{
 await command('workflows');const flow=win.getByRole('region',{name:'작업 흐름',exact:true})
 await flow.getByRole('button',{name:'새로 만들기',exact:true}).click();await flow.getByRole('textbox',{name:'흐름 이름',exact:true}).fill('미저장 흐름');await flow.getByRole('textbox',{name:'보낼 지시',exact:true}).fill('미저장 지시')
 await win.getByRole('button',{name:'작업 보조 화면 닫기'}).click();await command('workflows');await expect(flow.getByRole('textbox',{name:'흐름 이름',exact:true})).toHaveValue('미저장 흐름');await expect(flow.getByRole('textbox',{name:'보낼 지시',exact:true})).toHaveValue('미저장 지시')
 await flow.getByRole('button',{name:'새로 만들기',exact:true}).click();const confirm=win.getByRole('alertdialog',{name:'작성 중인 초안 버리기'});await confirm.getByRole('button',{name:'취소',exact:true}).click();await expect(flow.getByRole('textbox',{name:'흐름 이름',exact:true})).toHaveValue('미저장 흐름')
 await win.getByTestId('task-row').filter({has:win.getByText('둘째 일감',{exact:true})}).click();await command('workflows');await expect(flow.getByRole('textbox',{name:'흐름 이름',exact:true})).toHaveCount(0)
 await win.getByTestId('task-row').filter({has:win.getByText('첫 일감',{exact:true})}).click();await command('workflows');await expect(flow.getByRole('textbox',{name:'흐름 이름',exact:true})).toHaveValue('미저장 흐름')
 await command('schedules');const schedule=win.getByRole('region',{name:'예약과 결과함',exact:true});await schedule.getByRole('button',{name:'새 예약',exact:true}).click();await schedule.getByRole('textbox',{name:'예약 이름',exact:true}).fill('미저장 예약');await win.getByRole('button',{name:'작업 보조 화면 닫기'}).click();await command('schedules');await expect(schedule.getByRole('textbox',{name:'예약 이름',exact:true})).toHaveValue('미저장 예약')
 await schedule.getByRole('button',{name:'새 예약',exact:true}).click();await confirm.getByRole('button',{name:'초안 버리기',exact:true}).click();await expect(schedule.getByRole('textbox',{name:'예약 이름',exact:true})).toHaveValue('')
 expect(readFileSync(join(data,'workflows/journal.json'),'utf8')).not.toContain('미저장');expect((await win.evaluate(()=>window.taskminal.schedules.view())).schedules).toHaveLength(0)
 await captureWindow(app,'test-results/panel-ux-drafts.png')
})
test('저장 완료 뒤 늦은 작업 흐름 읽기를 버리고 건너뛴 조회를 바로 이어간다',async()=>{
 await command('workflows');const flow=win.getByRole('region',{name:'작업 흐름',exact:true});await flow.getByRole('combobox',{name:'저장된 작업 흐름'}).selectOption('wf')
 await app.evaluate(({ipcMain},old)=>{const g=globalThis as unknown as {held?:()=>void;reads:number};g.reads=0;ipcMain.removeHandler('workflows:view');ipcMain.handle('workflows:view',()=>{g.reads++;if(g.reads===1)return new Promise(resolve=>{g.held=()=>resolve(old)});return {templates:[],runs:[]}})},{templates:[workflow],runs:[]})
 await expect.poll(()=>app.evaluate(()=>(globalThis as unknown as {reads:number}).reads)).toBe(1)
 await flow.getByRole('button',{name:'삭제',exact:true}).click();await win.getByRole('alertdialog',{name:'작업 흐름 삭제'}).getByRole('button',{name:'삭제',exact:true}).click();await expect(flow.getByRole('button',{name:'새로 만들기',exact:true})).toBeEnabled()
 await app.evaluate(()=>(globalThis as unknown as {held:()=>void}).held())
 await expect.poll(()=>app.evaluate(()=>(globalThis as unknown as {reads:number}).reads),{timeout:1500}).toBeGreaterThanOrEqual(2)
 await expect(flow.getByRole('combobox',{name:'저장된 작업 흐름'}).locator('option[value="wf"]')).toHaveCount(0)
})
test('주요 화면은 대표·넓은·확대 창에서 과업과 닫기를 유지한다',async()=>{
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]!.setSize(1440,900));await command('chat-new');const chat=win.getByTestId('chat-pane');await chat.getByTestId('chat-input').fill('hello');await chat.getByTestId('chat-send').click();await expect(chat.getByTestId('chat-status')).toContainText('끝남');await captureWindow(app,'test-results/uiux-final-chat-wide.png')
 await command('overview');await expect(win.getByRole('heading',{name:'전체 보기',exact:true})).toBeVisible();await captureWindow(app,'test-results/uiux-final-overview-wide.png')
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]!.setSize(900,600));await command('workflows');await win.getByRole('region',{name:'작업 흐름',exact:true}).getByRole('button',{name:'새로 만들기',exact:true}).click();await captureWindow(app,'test-results/uiux-final-workflow-medium.png')
 await win.getByRole('button',{name:'작업 보조 화면 닫기'}).click();await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0]!;w.setSize(640,400);w.webContents.setZoomFactor(2)});await win.evaluate(()=>document.documentElement.dataset.theme='light');await command('schedules');const schedule=win.getByRole('region',{name:'예약과 결과함',exact:true});await schedule.getByRole('button',{name:'새 예약',exact:true}).click();await schedule.getByRole('textbox',{name:'예약 이름',exact:true}).fill('확대 화면 예약 초안');await captureWindow(app,'test-results/uiux-final-schedule-small-light.png')
 await win.getByRole('button',{name:'작업 보조 화면 닫기'}).click();await command('settings');await expect(win.getByTestId('settings')).toBeVisible();await captureWindow(app,'test-results/uiux-final-settings-small-light.png')
})
