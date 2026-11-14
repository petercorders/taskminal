import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, realpathSync, rmSync, existsSync, readFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { firstWindow, waitLoaded, seedState, runCli } from './helpers'
let dir:string,app:ElectronApplication,server:Server,url:string
const privacyPage = `<!doctype html><html><head><title>Privacy fixture</title><style>
body {font:16px sans-serif;display:grid;grid-template-columns:repeat(3,130px);gap:8px} h1 {grid-column:1/-1;font-size:20px;margin:4px 0 8px} button {height:50px} [contenteditable] {overflow:hidden} input,textarea,[contenteditable] {width:110px;height:22px} iframe {width:130px;height:45px} #open,#closed {display:inline-block;vertical-align:top;width:130px;height:26px} * {animation:none!important;transition:none!important;caret-color:transparent!important}
</style></head><body><h1>Privacy fixture</h1>
<input id="plain" value="FIRST-PRIVATE" style="visibility:visible!important;opacity:1!important">
<input id="password" type="password" value="FIRST-PASSWORD">
<label>Notes<textarea id="notes" style="visibility:visible!important">FIRST-DRAFT</textarea></label>
<button>Inspect<span contenteditable="true" style="display:block;visibility:visible!important">FIRST-EDIT</span></button>
<iframe id="frame" style="visibility:visible!important" srcdoc="<input value='FIRST-FRAME'><textarea>FIRST-FRAME-DRAFT</textarea>"></iframe>
<div id="open" style="visibility:visible!important;opacity:1!important"></div>
<div id="closed" style="visibility:visible!important;opacity:1!important"></div>
<script>
const openRoot=document.querySelector('#open').attachShadow({mode:'open'});
const closedRoot=document.querySelector('#closed').attachShadow({mode:'closed'});
openRoot.innerHTML='<input value="FIRST-OPEN" style="width:110px;visibility:visible!important;opacity:1!important">';
closedRoot.innerHTML='<input value="FIRST-CLOSED" style="width:110px;visibility:visible!important;opacity:1!important"><dialog><input value="FIRST-TOP-LAYER" style="visibility:visible!important;opacity:1!important"></dialog>';
closedRoot.querySelector('dialog').showModal();
window.privacyRoots=[openRoot,closedRoot];
</script></body></html>`
async function web<T>(script:string):Promise<T>{
 return app.evaluate(async({webContents},{url,script})=>{
  const wc=webContents.getAllWebContents().find(w=>w.getURL()===url+'/privacy');if(!wc)throw Error('privacy page missing');return wc.executeJavaScript(script)
 },{url,script})
}
const cli=(...args:string[])=>runCli(dir,'browser',...args,'--json')
test.beforeEach(async()=>{
 dir=realpathSync(mkdtempSync(join(tmpdir(),'tm-browser-cli-')))
 seedState(dir,[{id:'task',name:'Browser',paneId:'shell',cwd:dir},{id:'other',name:'Other',paneId:'other-shell',cwd:dir}])
 server=createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(req.url==='/privacy'?privacyPage:req.url==='/next'?'<h1>Next page</h1><button>Other</button>':'<h1>Test page</h1><label>Name<input aria-label="Name" value="PRIVATE-INPUT"></label><input type="password" value="PASSWORD-SECRET"><textarea>TEXTAREA-SECRET</textarea><button onclick="document.querySelector(\'h1\').textContent=document.querySelector(\'input\').value">Apply</button><a href="/next">Next</a>')})
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));url=`http://127.0.0.1:${(server.address() as {port:number}).port}`
 app=await electron.launch({args:['.'],env:{...process.env,TASKMINAL_USER_DATA:dir}})
 const win=await firstWindow(app);await waitLoaded(win)
})
test.afterEach(async()=>{await app?.close();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(dir,{recursive:true,force:true})})
test('real CLI snapshots fill/click/capture and fences old references after navigation',async()=>{
 const tabs=await cli('tabs','task');expect(tabs.code).toBe(0)
 const tab=JSON.parse(tabs.out).selectedTabId as string
 const nav=await cli('navigate','task','--tab',tab,'--url',url);expect(nav.code,nav.err).toBe(0)
 const first=await cli('snapshot','task','--tab',tab);expect(first.code,first.err).toBe(0)
 const snapshot=JSON.parse(first.out) as {text:string;elements:Array<{ref:string;label:string}>}
 expect(JSON.stringify(snapshot)).not.toContain('PRIVATE-INPUT');expect(JSON.stringify(snapshot)).not.toContain('PASSWORD-SECRET');expect(JSON.stringify(snapshot)).not.toContain('TEXTAREA-SECRET')
 const input=snapshot.elements.find(e=>e.label==='Name')!,button=snapshot.elements.find(e=>e.label==='Apply')!,next=snapshot.elements.find(e=>e.label==='Next')!
 const fill=await cli('fill','task','--tab',tab,'--ref',input.ref,'--value','hello');expect(fill.code,fill.err).toBe(0)
 const wrong=await cli('click','task','--tab',tab,'--ref',button.ref,'--expect-url',url+'/wrong');expect(wrong.code).toBe(1)
 expect((await cli('click','task','--tab',tab,'--ref',button.ref)).code).toBe(0)
 expect((await cli('snapshot','task','--tab',tab)).out).toContain('hello')
 const picture=await cli('screenshot','task','--tab',tab);expect(picture.code,picture.err).toBe(0);expect(existsSync(JSON.parse(picture.out).path)).toBe(true)
 // A new snapshot invalidates the previous references even before a navigation.
 expect((await cli('click','task','--tab',tab,'--ref',next.ref)).code).toBe(1)
 const current=JSON.parse((await cli('snapshot','task','--tab',tab)).out)
 const currentNext=current.elements.find((e:{label:string})=>e.label==='Next').ref
 await cli('navigate','task','--tab',tab,'--url',url+'/next')
 expect((await cli('click','task','--tab',tab,'--ref',currentNext)).code).toBe(1)
 expect((await cli('snapshot','task','--tab','missing-tab')).code).toBe(1)
 const win=await app.firstWindow();await win.screenshot({path:'/tmp/taskminal-46-browser-cli.png'})
})


test('snapshot scrubs nested labels and screenshot masks inline important, frames and open/closed shadow inputs',async()=>{
 const tab=JSON.parse((await cli('tabs','task')).out).selectedTabId as string
 expect((await cli('navigate','task','--tab',tab,'--url',url+'/privacy')).code).toBe(0)
 await expect.poll(()=>web<boolean>('!!window.privacyRoots?.[1]?.querySelector("input") && !!document.querySelector("iframe").contentDocument?.querySelector("input")')).toBe(true)
 expect(await web(`window.privacyRoots.every(root=>{const rect=root.querySelector('input').getBoundingClientRect();return rect.top>=0&&rect.bottom<=innerHeight&&rect.left>=0&&rect.right<=innerWidth})`)).toBe(true)
 const snapshot=await cli('snapshot','task','--tab',tab)
 expect(snapshot.code,snapshot.err).toBe(0)
 for(const secret of ['FIRST-PRIVATE','FIRST-PASSWORD','FIRST-DRAFT','FIRST-EDIT','FIRST-FRAME','FIRST-OPEN','FIRST-CLOSED','FIRST-TOP-LAYER'])expect(snapshot.out).not.toContain(secret)
 const first=await cli('screenshot','task','--tab',tab)
 expect(first.code,first.err).toBe(0)
 const firstBytes=readFileSync(JSON.parse(first.out).path)
 expect(await web('getComputedStyle(document.querySelector("#plain")).visibility')).toBe('visible')
 expect(await web('document.querySelector("#plain").getAttribute("style")')).toBe('visibility:visible!important;opacity:1!important')
 await web(`(() => {
  for(const node of document.querySelectorAll('input,textarea'))node.value='SECOND-PRIVATE-MUCH-LONGER';
  document.querySelector('[contenteditable]').textContent='SECOND-EDIT-LONGER';
  for(const root of window.privacyRoots)for(const node of root.querySelectorAll('input'))node.value='SECOND-SHADOW-LONGER';
  for(const node of document.querySelector('iframe').contentDocument.querySelectorAll('input,textarea'))node.value='SECOND-FRAME-LONGER';
 })()`)
 const second=await cli('screenshot','task','--tab',tab)
 expect(second.code,second.err).toBe(0)
 copyFileSync(JSON.parse(first.out).path,'/tmp/taskminal-46-privacy-first.png')
 copyFileSync(JSON.parse(second.out).path,'/tmp/taskminal-46-privacy-second.png')
 expect(readFileSync(JSON.parse(second.out).path).equals(firstBytes)).toBe(true)
 expect(await web('document.querySelector("#plain").value')).toBe('SECOND-PRIVATE-MUCH-LONGER')
 expect(await web('getComputedStyle(document.querySelector("#closed")).opacity')).toBe('1')
 await web('window.restoredAfterCapture=false;setTimeout(()=>window.restoredAfterCapture=true,0)')
 await expect.poll(()=>web('window.restoredAfterCapture')).toBe(true)
 expect(await app.evaluate(({webContents},address)=>webContents.getAllWebContents().find(w=>w.getURL()===address+'/privacy')!.debugger.isAttached(),url)).toBe(false)
})

test('screenshot refuses an occupied debugger without taking over its connection',async()=>{
 const tab=JSON.parse((await cli('tabs','task')).out).selectedTabId as string
 await cli('navigate','task','--tab',tab,'--url',url+'/privacy')
 await app.evaluate(({webContents},address)=>webContents.getAllWebContents().find(w=>w.getURL()===address+'/privacy')!.debugger.attach('1.3'),url)
 try{
  const picture=await cli('screenshot','task','--tab',tab)
  expect(picture.code).toBe(1);expect(picture.err).toContain('다른 검사 도구')
  expect(await app.evaluate(({webContents},address)=>webContents.getAllWebContents().find(w=>w.getURL()===address+'/privacy')!.debugger.isAttached(),url)).toBe(true)
 }finally{await app.evaluate(({webContents},address)=>webContents.getAllWebContents().find(w=>w.getURL()===address+'/privacy')!.debugger.detach(),url)}
})

test('references reject another actual task/tab and a tab closed after snapshot',async()=>{
 const firstTab=JSON.parse((await cli('tabs','task')).out).selectedTabId as string
 await cli('navigate','task','--tab',firstTab,'--url',url)
 const original=JSON.parse((await cli('snapshot','task','--tab',firstTab)).out)
 const ref=original.elements.find((e:{label:string})=>e.label==='Apply').ref
 const otherTab=JSON.parse((await cli('tabs','other')).out).selectedTabId as string
 await cli('navigate','other','--tab',otherTab,'--url',url)
 expect((await cli('click','other','--tab',otherTab,'--ref',ref)).code).toBe(1)
 expect((await cli('click','other','--tab',firstTab,'--ref',ref)).code).toBe(1)
 const win=await app.firstWindow()
 const secondTab=await win.evaluate(async()=> (await window.taskminal.workspace.browserCreateTab('task')).selectedTabId)
 await cli('navigate','task','--tab',secondTab,'--url',url)
 expect((await cli('click','task','--tab',secondTab,'--ref',ref)).code).toBe(1)
 expect((await cli('click','task','--tab',firstTab,'--ref',ref)).code).toBe(1)
 await win.evaluate(tab=>window.taskminal.workspace.browserCloseTab('task',tab),firstTab)
 expect((await cli('click','task','--tab',firstTab,'--ref',ref)).code).toBe(1)
})


test('navigate returns failure for an unreachable page and succeeds on retry', async () => {
 const tab = JSON.parse((await cli('tabs', 'task')).out).selectedTabId as string
 const closed = createServer()
 await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', resolve))
 const port = (closed.address() as {port: number}).port
 await new Promise<void>(resolve => closed.close(() => resolve()))
 const failed = await cli('navigate', 'task', '--tab', tab, '--url', `http://127.0.0.1:${port}/`)
 expect(failed.code, failed.out).toBe(1)
 expect(failed.err).toBeTruthy()
 const retry = await cli('navigate', 'task', '--tab', tab, '--url', url)
 expect(retry.code, retry.err).toBe(0)
 expect(JSON.parse(retry.out).error).toBeFalsy()
 expect((await cli('snapshot', 'task', '--tab', tab)).out).toContain('Test page')
})
