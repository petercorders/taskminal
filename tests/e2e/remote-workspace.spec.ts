import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { RemoteClients } from '../../src/main/remote/client'
import { seedState, firstWindow, waitLoaded, captureWindow } from './helpers'
const require = createRequire(resolve('package.json'))
const electronBin = require('electron') as string
let temp: string, root: string, data: string, url: string, token: string, server: ChildProcess, app: ElectronApplication | undefined
test.beforeEach(async () => {
  temp = realpathSync(mkdtempSync(join(tmpdir(),'tm-remote-'))); root = join(temp,'root'); data = join(temp,'server'); mkdirSync(root)
  writeFileSync(join(root,'note.txt'),'initial\n'); writeFileSync(join(root,'.env'),'PRIVATE_TOKEN=never\n')
  execFileSync('git',['init','-q','-b','test'],{cwd:root}); execFileSync('git',['config','user.name','test'],{cwd:root}); execFileSync('git',['config','user.email','test@example.invalid'],{cwd:root}); execFileSync('git',['-c','commit.gpgsign=false','add','note.txt'],{cwd:root}); execFileSync('git',['-c','commit.gpgsign=false','commit','-qm','initial'],{cwd:root})
  server = spawn(process.platform==='win32'?electronBin:resolve('resources/bin/taskminal-server'),[...(process.platform==='win32'?[resolve('out/main/server.js')]:[]),'--root',root,'--data',data,'--port','0'],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1',TASKMINAL_CLAUDE_BIN:resolve('tests/fixtures/fake-claude.mjs'),TASKMINAL_CODEX_BIN:resolve('tests/fixtures/fake-codex.mjs'),FAKE_CLAUDE_LOG:join(temp,'claude.log')}})
  const info = await new Promise<{url:string;tokenFile:string}>((resolve,reject) => { let buffer=''; let errors=''; const timeout=setTimeout(()=>reject(Error('server timeout '+errors)),15000); server.stderr?.on('data',d=>errors+=d); server.once('exit',code=>{clearTimeout(timeout);reject(Error('server exited '+code+' '+errors))}); server.stdout?.on('data',d=>{buffer+=d;const line=buffer.split('\n')[0];if(line){try{const info=JSON.parse(line);clearTimeout(timeout);resolve(info)}catch{}}}) })
  url=info.url; token=readFileSync(info.tokenFile,'utf8'); expect(token).toMatch(/^[a-f0-9]{64}$/); expect(statSync(info.tokenFile).mode&0o777).toBe(0o600)
})
test.afterEach(async()=> { await app?.close(); app=undefined; if(server?.exitCode===null){ const done=new Promise<void>(r=>server.once('exit',()=>r())); server.kill('SIGTERM'); await done } rmSync(temp,{recursive:true,force:true,maxRetries:5}) })
const rpc=async(method:string,args:unknown[],secret=token,origin?:string)=>{ const response=await fetch(url+'/rpc',{method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json',...(origin?{Origin:origin}:{})},body:JSON.stringify({method,args})});return {status:response.status,...await response.json()} }
test('server owns terminal/chat across client disconnect with auth, paths, CAS and request fences',async()=>{
  expect((await rpc('workspaces',[],'wrong')).status).toBe(403)
  expect((await rpc('workspaces',[],'é'.repeat(64))).status).toBe(403)
  expect((await rpc('workspaces',[],token,'http://evil.invalid')).status).toBe(403)
  const clients=new RemoteClients(), c=await clients.connect(url,token)
  const w=await clients.call(c.id,'open',['.', 'open-1']) as {id:string}
  expect(await clients.call(c.id,'open',['.','open-1'])).toMatchObject(w)
  expect((await rpc('open',['..','escape'])).status).toBe(400)
  expect((await rpc('read',[w.id,'.env'])).status).toBe(400)
  writeFileSync(join(temp,'outside.txt'),'outside');symlinkSync(join(temp,'outside.txt'),join(root,'escape.txt'))
  expect((await rpc('read',[w.id,'escape.txt'])).status).toBe(400)
  const initial=(await rpc('read',[w.id,'note.txt'])).data
  writeFileSync(join(root,'note.txt'),'external\n')
  expect((await rpc('save',[w.id,'note.txt',{signature:initial.signature,text:'overwrite'},'save-conflict'])).data).toMatchObject({ok:false,current:{text:'external\n'}})
  const current=(await rpc('read',[w.id,'note.txt'])).data
  const saveArgs=[w.id,'note.txt',{signature:current.signature,text:'saved\n'},'save-ok']
  expect((await rpc('save',saveArgs)).data).toMatchObject({ok:true,file:{text:'saved\n'}})
  expect((await rpc('save',saveArgs)).data).toMatchObject({ok:true,file:{text:'saved\n'}})
  const terminal=await clients.call(c.id,'terminal',[w.id,'terminal-1']) as {id:string}
  const before=readFileSync(join(data,'workspaces.json'),'utf8')
  for (const port of ['0',new URL(url).port]) {
    const duplicate=spawn(electronBin,[resolve('out/main/server.js'),'--root',root,'--data',data,'--port',port],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}})
    let error='';duplicate.stderr?.on('data',d=>error+=d)
    expect(await new Promise<number|null>(r=>duplicate.once('exit',r))).toBe(1);expect(error).toContain('잠금')
    expect(readFileSync(join(data,'workspaces.json'),'utf8')).toBe(before)
  }
  expect(await clients.call(c.id,'terminal',[w.id,'terminal-1'])).toMatchObject(terminal)
  await clients.call(c.id,'write',[w.id,terminal.id,{requestId:'write-1',data:"sleep 0.2; printf 'DETACHED-MARK\\n' >> once.txt; printf 'RESUMED-MARK\\n'\r"}])
  clients.disconnect(c.id)
  const c2=await clients.connect(url,token)
  await expect.poll(()=> { try { return readFileSync(join(root,'once.txt'),'utf8') } catch { return '' } }).toBe('DETACHED-MARK\n')
  expect((await clients.call(c2.id,'tail',[w.id,terminal.id]) as {data:string}).data).toContain('RESUMED-MARK')
  await clients.call(c2.id,'write',[w.id,terminal.id,{requestId:'write-1',data:"sleep 0.2; printf 'DETACHED-MARK\\n' >> once.txt; printf 'RESUMED-MARK\\n'\r"}])
  expect(readFileSync(join(root,'once.txt'),'utf8')).toBe('DETACHED-MARK\n')
  expect((await rpc('write',[w.id,terminal.id,{requestId:'write-1',data:'different\r'}])).status).toBe(400)
  const git=(await rpc('git',[w.id])).data; expect(git.status).toContain('note.txt');expect(git.diff).toContain('+saved')
  const chat=(await rpc('chat',[w.id,'claude','chat-1'])).data
  expect((await rpc('send',[w.id,chat.id,'hello remote','send-1'])).status).toBe(200)
  await expect.poll(async()=>JSON.stringify((await rpc('history',[w.id,chat.id])).data.events)).toContain('hello remote')
  clients.disconnect(c2.id)
  await expect.poll(async()=> (await rpc('history',[w.id,chat.id])).data.events.some((e:{t:string})=>e.t==='turn_end')).toBe(true)
  const c3=await clients.connect(url,token)
  expect(await clients.call(c3.id,'workspaces',[])).toMatchObject([{id:w.id,sessions:[{id:terminal.id}],chats:[{id:chat.id}]}])
  expect(readFileSync(join(data,'workspaces.json'),'utf8')).not.toContain('saved\\n')
  expect(readFileSync(join(data,'workspaces.json'),'utf8')).not.toContain(token)
  clients.clear()
})
test('native panel edits with conflict recovery and reconnects to the same server sessions after app restart',async()=>{
  const uiData=join(temp,'client');mkdirSync(uiData);seedState(uiData,[{id:'task',name:'Local',paneId:'shell',cwd:root}])
  const launch=async()=>{app=await electron.launch({args:['.'],env:{...process.env,TASKMINAL_USER_DATA:uiData}});const win=await firstWindow(app);await waitLoaded(win);await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]!.webContents.send('app:command','remote-workspace'));return win}
  let win=await launch()
  const connect=async()=>{await win.getByRole('textbox',{name:'원격 서버 주소',exact:true}).fill(url);await win.getByLabel('원격 서버 토큰',{exact:true}).fill(token);await win.getByRole('button',{name:'연결',exact:true}).click();await expect(win.getByRole('button',{name:'연결 해제',exact:true})).toBeVisible()}
  await connect();await win.getByRole('button',{name:'작업 공간 열기',exact:true}).click()
  await win.getByRole('button',{name:'note.txt',exact:true}).click()
  const editor=win.getByRole('textbox',{name:'원격 파일 편집 내용',exact:true})
  await expect(editor).toHaveValue('initial\n');await editor.fill('my draft\n')
  writeFileSync(join(root,'note.txt'),'external change\n')
  await win.getByRole('button',{name:'원격 파일 저장',exact:true}).click()
  await expect(win.getByRole('textbox',{name:'원격 디스크 최신 내용',exact:true})).toHaveValue('external change\n');await expect(editor).toHaveValue('my draft\n')
  await win.getByRole('button',{name:'초안 유지하고 최신 기준으로 준비',exact:true}).click();await win.getByRole('button',{name:'원격 파일 저장',exact:true}).click()
  await expect.poll(()=>readFileSync(join(root,'note.txt'),'utf8')).toBe('my draft\n')
  await win.getByRole('button',{name:'터미널',exact:true}).click();await win.getByRole('button',{name:'새 서버 셸',exact:true}).click()
  const terminal=win.getByRole('combobox',{name:'서버 셸 세션',exact:true});await expect(terminal).not.toHaveValue('');const session=await terminal.inputValue()
  await app!.evaluate(({ipcMain})=>{
    const handlers=Reflect.get(ipcMain,'_invokeHandlers') as Map<string,(event:unknown,...args:unknown[])=>Promise<unknown>>
    const original=handlers.get('remote-workspace:request')!;let dropped=false
    ipcMain.removeHandler('remote-workspace:request')
    ipcMain.handle('remote-workspace:request',async(event,method,...args)=>{const result=await original(event,method,...args);if(method==='write'&&!dropped){dropped=true;throw Error('fixture lost reply after accepted write')}return result})
  })
  await win.getByRole('textbox',{name:'원격 셸 입력',exact:true}).fill("sleep 0.3; printf 'PANEL-DETACHED\\n' >> panel.txt")
  await win.getByRole('button',{name:'입력 보내기 ↵',exact:true}).click()
  await expect(win.getByRole('alert')).toContainText('결과를 확인하지 못했어요')
  await win.getByRole('button',{name:'결과 확인 후 새 요청 번호로 준비…',exact:true}).click()
  await win.getByRole('alertdialog',{name:'새 요청 번호로 준비',exact:true}).getByRole('button',{name:'취소',exact:true}).click()
  // The same input retains its request ID; the lost response cannot duplicate the shell command.
  await win.getByRole('button',{name:'입력 보내기 ↵',exact:true}).click()
  const ws=(await rpc('workspaces',[])).data[0] as {id:string}
  await app!.close();app=undefined
  await expect.poll(()=>{try{return readFileSync(join(root,'panel.txt'),'utf8')}catch{return ''}}).toBe('PANEL-DETACHED\n')
  win=await launch();await connect()
  await win.getByRole('combobox',{name:'서버 작업 공간',exact:true}).selectOption(ws.id)
  await win.getByRole('button',{name:'터미널',exact:true}).click();await win.getByRole('combobox',{name:'서버 셸 세션',exact:true}).selectOption(session)
  await expect(win.getByLabel('원격 셸 출력',{exact:true})).toContainText('panel.txt')
  await win.getByRole('button',{name:'대화',exact:true}).click();await win.getByRole('button',{name:'새 Claude 대화',exact:true}).click()
  const prompt=win.getByRole('textbox',{name:'원격 대화 지시',exact:true})
  await prompt.fill('perm remote');await win.getByRole('button',{name:'지시 보내기',exact:true}).click()
  await win.getByRole('button',{name:'이번만 허락',exact:true}).click()
  await expect(win.getByLabel('원격 대화 기록',{exact:true})).toContainText('대화 완료')
  await captureWindow(app!,'/tmp/taskminal-48-remote-wide.png')
  await prompt.fill('ask remote');await win.getByRole('button',{name:'지시 보내기',exact:true}).click()
  await win.getByRole('radio',{name:/빨강/}).check();await win.getByRole('button',{name:'질문에 답하기',exact:true}).click()
  await expect(win.getByLabel('원격 대화 기록',{exact:true})).toContainText('고른 색: 빨강')
  await win.getByRole('button',{name:'새 Codex 대화',exact:true}).click()
  await expect(win.getByRole('combobox',{name:'서버 에이전트 대화',exact:true}).locator('option:checked')).toContainText('codex')
  await prompt.fill('hello remote');await win.getByRole('button',{name:'지시 보내기',exact:true}).click()
  await expect(win.getByLabel('원격 대화 기록',{exact:true})).toContainText('대화 완료')
  await app!.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0]!;w.setBounds({width:640,height:480});w.webContents.setZoomFactor(2)})
  await win.evaluate(()=>document.documentElement.dataset.theme='light')
  await prompt.scrollIntoViewIfNeeded();await captureWindow(app!,'/tmp/taskminal-48-remote-small.png')
  const geometry=await win.evaluate(()=>({fits:document.documentElement.scrollWidth<=document.documentElement.clientWidth,width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,outside:Array.from(document.querySelectorAll('*')).filter(e=>e.getBoundingClientRect().right>document.documentElement.clientWidth+1).slice(0,20).map(e=>[e.tagName,e.className,e.getBoundingClientRect().right])}))
  expect(geometry.fits,JSON.stringify(geometry)).toBe(true)
  await win.getByRole('button',{name:'지시 보내기',exact:true}).scrollIntoViewIfNeeded()
  await expect(win.getByRole('button',{name:'지시 보내기',exact:true})).toBeVisible()
  await captureWindow(app!,'/tmp/taskminal-48-remote-small-actions.png')
  await win.getByRole('button',{name:'연결 해제',exact:true}).click()
  expect((await rpc('workspaces',[])).data[0].sessions[0].id).toBe(session)
  expect(readFileSync(join(uiData,'state.json'),'utf8')).not.toContain(token)
})
