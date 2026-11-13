import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { firstWindow, seedState, waitLoaded, captureWindow } from './helpers'
let data:string,app:ElectronApplication,win:Page,server:Server,url:string
let requests:Map<string,number>
async function launch(){app=await electron.launch({args:['.'],env:{...process.env,TASKMINAL_USER_DATA:data,TASKMINAL_CLAUDE_BIN:resolve('tests/fixtures/fake-claude.mjs')}});win=await firstWindow(app);await waitLoaded(win)}
async function open(){await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]!.webContents.send('app:command','workspace-browser'));await expect(win.getByTestId('workspace-browser').getByRole('tab')).toHaveCount(1)}
async function go(path:string){await win.getByRole('textbox',{name:'브라우저 주소'}).fill(url+path);await win.getByRole('button',{name:'열기',exact:true}).click();await expect.poll(()=>win.evaluate(()=>window.taskminal.workspace.browserState('t'))).toMatchObject({loading:false,title:path.startsWith('/a')?'Alpha':path.startsWith('/large')?'Large':'Beta'})}
async function web<T>(path:string,script:string):Promise<T>{return app.evaluate(async({webContents},{url,path,script})=>{const wc=webContents.getAllWebContents().find(w=>w.getURL().startsWith(url+path));if(!wc)throw new Error('missing test page');return wc.executeJavaScript(script)},{url,path,script})}
async function loaded(path:string){await expect.poll(()=>app.evaluate(async({webContents},{url,path})=>{const wc=webContents.getAllWebContents().find(w=>w.getURL().startsWith(url+path));if(!wc||wc.isLoading())return false;try{return await wc.executeJavaScript('!!document.querySelector("#field")')}catch{return false}},{url,path})).toBe(true)}
test.beforeEach(async()=>{
 data=mkdtempSync(join(tmpdir(),'tm-browser-tabs-'));requests=new Map()
 server=createServer((req,res)=>{
  const path=new URL(req.url??'/', 'http://local').pathname;requests.set(path,(requests.get(path)??0)+1)
  const title=path==='/a'?'Alpha':path==='/large'?'Large':'Beta'
  const text=path==='/large'?'x'.repeat(7955)+'ghp_'+'a'.repeat(36):title+' 자료 INTERNAL-ABCDEF'
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(`<html><head><title>${title}</title></head><body><h1>${title}</h1><input id="field" value="original"><div class="target" id="target">${text}<input value="private-secret"></div></body></html>`)
 });await new Promise<void>(r=>server.listen(0,'127.0.0.1',()=>r()));url=`http://127.0.0.1:${(server.address() as {port:number}).port}`
 seedState(data,[{id:'t',name:'브라우저 일감',paneId:'shell',cwd:data}],[],{secretCustom:[{name:'내부',pattern:'INTERNAL-[A-Z]{6}'}]})
})
test.afterEach(async()=>{await app?.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));rmSync(data,{recursive:true,force:true,maxRetries:5})})
test('두 탭의 폼 상태를 보존하고 키보드로 전환하며 마지막 닫기 후 과거 탭을 되살리지 않는다',async()=>{
 await launch();await open();await go('/a?token=private#anchor');await web('/a','document.querySelector("#field").value="A typed"')
 const first=(await win.evaluate(()=>window.taskminal.workspace.browserTabs('t'))).selectedTabId
 await win.getByRole('button',{name:'새 브라우저 탭'}).click();await go('/b');await web('/b','document.querySelector("#field").value="B typed"')
 await win.getByRole('tab',{name:'Alpha',exact:true}).click();expect(await web('/a','document.querySelector("#field").value')).toBe('A typed')
 await expect(win.getByRole('textbox',{name:'브라우저 주소'})).toHaveValue(url+'/a?token=private#anchor')
 await win.getByRole('tab',{name:'Alpha',exact:true}).press('ArrowRight');await expect(win.getByRole('tab',{name:'Beta',exact:true})).toBeFocused();expect(await web('/b','document.querySelector("#field").value')).toBe('B typed')
 const disk=readFileSync(join(data,'browser-tabs/journal.json'),'utf8');expect(disk).not.toContain(url);expect(disk).not.toContain('A typed');expect(disk).not.toContain('private')
 await win.getByRole('button',{name:'Beta 브라우저 탭 닫기'}).click();await win.getByRole('button',{name:'Alpha 브라우저 탭 닫기'}).click()
 const blank=await win.evaluate(()=>window.taskminal.workspace.browserTabs('t'));expect(blank.tabs).toHaveLength(1);expect(blank.selectedTabId).not.toBe(first)
 await win.evaluate(id=>window.taskminal.workspace.browserShow('t',{x:0,y:0,width:100,height:100},id),first)
 expect(await win.evaluate(id=>window.taskminal.workspace.browserState('t',id),first)).toMatchObject({url:''})
 expect(await win.evaluate(async({id,url})=>{try{await window.taskminal.workspace.browserNavigate('t',url,id);return false}catch{return true}},{id:first,url:url+'/a'})).toBe(true)
 expect((await win.evaluate(()=>window.taskminal.workspace.browserTabs('t'))).selectedTabId).toBe(blank.selectedTabId)
 for(let i=1;i<6;i++)await win.getByRole('button',{name:'새 브라우저 탭'}).click()
 await expect(win.getByRole('button',{name:'새 브라우저 탭'})).toBeDisabled()
 expect(await win.evaluate(async()=>{try{await window.taskminal.workspace.browserCreateTab('t');return false}catch{return true}})).toBe(true)
 await win.screenshot({path:'test-results/browser-tabs-six.png'})
})
test('주소 기억은 선택한 탭만 지연 복원하고 검색어·폼 입력을 저장하지 않으며 끄면 URL을 지운다',async()=>{
 await launch();await open();await go('/a?token=private');await web('/a','document.querySelector("#field").value="not-restored"')
 await win.getByRole('button',{name:'새 브라우저 탭'}).click();await go('/b?token=private#fragment');await win.getByRole('checkbox',{name:'이 일감의 탭 주소 기억하기'}).check();await expect.poll(()=>win.evaluate(async()=>(await window.taskminal.workspace.browserTabs('t')).remember)).toBe(true)
 const disk=readFileSync(join(data,'browser-tabs/journal.json'),'utf8');expect(disk).not.toContain('token=');expect(disk).not.toContain('not-restored');expect(disk).not.toContain('fragment')
 await app.close();requests.clear();await launch()
 expect(await app.evaluate(({webContents})=>webContents.getAllWebContents().filter(w=>/^https?:/.test(w.getURL())).length)).toBe(0)
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]!.webContents.send('app:command','workspace-browser'))
 await expect.poll(()=>win.evaluate(()=>window.taskminal.workspace.browserState('t'))).toMatchObject({title:'Beta',loading:false})
 await loaded('/b');expect(requests.get('/a')??0).toBe(0);expect(requests.get('/b')).toBe(1)
 expect(await web('/b','document.querySelector("#field").value')).toBe('original')
 await win.getByRole('tab',{name:'Alpha',exact:true}).click();await expect.poll(()=>win.evaluate(()=>window.taskminal.workspace.browserState('t'))).toMatchObject({title:'Alpha',loading:false});await loaded('/a');expect(requests.get('/a')).toBe(1);expect(await web('/a','document.querySelector("#field").value')).toBe('original')
 await win.getByRole('checkbox',{name:'이 일감의 탭 주소 기억하기'}).uncheck();await expect.poll(()=>win.evaluate(async()=>(await window.taskminal.workspace.browserTabs('t')).remember)).toBe(false);expect(readFileSync(join(data,'browser-tabs/journal.json'),'utf8')).not.toContain(url)
 await app.close();requests.clear();await launch();await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]!.webContents.send('app:command','workspace-browser'));await expect(win.getByRole('tablist',{name:'브라우저 탭'}).getByRole('tab')).toHaveCount(2)
 expect((await win.evaluate(()=>window.taskminal.workspace.browserState('t'))).url).toBe('');expect(requests.get('/a')??0).toBe(0);expect(requests.get('/b')??0).toBe(0)
})
test('캡처는 정확한 탭에 묶고 페이지가 바뀌면 첨부를 취소하며 큰 요소에서 비밀값을 잘라 내보내지 않는다',async()=>{
 await launch();await open();await go('/a')
 await win.getByRole('button',{name:'요소 선택',exact:true}).click()
 await expect.poll(async()=>{await web('/a','document.querySelector("#target").click()');return win.locator('.work-capture').count()}).toBe(1)
 await expect(win.locator('.work-capture')).toContainText('가림');await expect(win.locator('.work-capture')).not.toContainText('INTERNAL-ABCDEF');await expect(win.locator('.work-capture')).not.toContainText('private-secret')
 await web('/a',`location.href=${JSON.stringify(url+'/b')}`);await expect.poll(()=>win.evaluate(()=>window.taskminal.workspace.browserState('t'))).toMatchObject({title:'Beta',loading:false});await expect(win.locator('.work-capture')).toHaveCount(0);await expect(win.getByTestId('chat-pane')).toHaveCount(0)
 await go('/large');await win.getByRole('button',{name:'요소 선택',exact:true}).click()
 await expect.poll(async()=>{await web('/large','document.querySelector("#target").click()');return win.getByRole('alert').count()}).toBeGreaterThan(0)
 await expect(win.getByRole('alert')).toContainText('너무 커요');await expect(win.locator('.work-capture')).toHaveCount(0);await expect(win.locator('body')).not.toContainText('ghp_')
 await go('/a');await win.getByRole('button',{name:'요소 선택',exact:true}).click();await expect(win.getByRole('status')).toContainText('요소')
 await win.getByRole('button',{name:'새 브라우저 탭'}).click();await win.getByRole('tab',{name:'Alpha',exact:true}).click()
 await expect.poll(()=>web('/a','Reflect.ownKeys(globalThis).filter(k=>typeof k==="symbol"&&String(k).includes("taskminal-element-pick-")).length')).toBe(0)
 const count=await web('/a','globalThis.clicked=0;document.querySelector("#target").addEventListener("click",()=>globalThis.clicked++);document.querySelector("#target").click();globalThis.clicked');expect(count).toBe(1)
})
test('손상된 탭 기록을 보존하고 앱의 다른 화면을 계속 사용할 수 있다',async()=>{
 mkdirSync(join(data,'browser-tabs'));writeFileSync(join(data,'browser-tabs/journal.json'),'broken')
 await launch();await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]!.webContents.send('app:command','workspace-browser'));await expect(win.getByRole('alert')).toContainText('기록');expect(readFileSync(join(data,'browser-tabs/journal.json'),'utf8')).toBe('broken')
 await win.getByRole('button',{name:'작업 보조 화면 닫기'}).click();await expect(win.getByTestId('task-view').filter({visible:true})).toBeVisible();expect(existsSync(join(data,'state.json'))).toBe(true)
 await captureWindow(app,'test-results/browser-tabs-journal-error.png')
})
