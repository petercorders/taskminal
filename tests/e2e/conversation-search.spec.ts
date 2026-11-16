import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstWindow, seedState, waitLoaded, captureWindow } from './helpers'
let data:string,app:ElectronApplication,win:Page
async function open(){await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]!.webContents.send('app:command','conversation-search'))}
test.beforeEach(async()=>{
 data=mkdtempSync(join(tmpdir(),'tm-search-e2e-'))
 seedState(data,[{id:'a',name:'A',paneId:'a-pane',cwd:data},{id:'b',name:'B',paneId:'b-pane',cwd:data}],[],{secretCustom:[{name:'내부',pattern:'INTERNAL-[A-Z]{6}'}]})
 const state=JSON.parse(readFileSync(join(data,'state.json'),'utf8'))
 state.tasks[1].panes['b-pane']={id:'b-pane',cwd:data,kind:'chat',chat:{agent:'codex'}}
 writeFileSync(join(data,'state.json'),JSON.stringify(state));mkdirSync(join(data,'chat'))
 writeFileSync(join(data,'chat/b-pane.jsonl'),[{t:'user',text:'needle INTERNAL-ABCDEF',at:10},{t:'text',text:'answer needle'},{t:'turn_end',ok:true,ms:1,reason:'done'}].map(e=>JSON.stringify(e)).join('\n'))
 app=await electron.launch({args:['.'],env:{...process.env,TASKMINAL_USER_DATA:data}})
 win=await firstWindow(app);await waitLoaded(win)
})
test.afterEach(async()=>{await app?.close();rmSync(data,{recursive:true,force:true,maxRetries:5})})
test('저장한 대화를 가려 검색하고 정확한 일감과 턴으로 이동한다',async()=>{
 await open();const dialog=win.getByRole('dialog',{name:'대화 찾기'})
 await expect(dialog.getByRole('searchbox')).toBeFocused();await dialog.getByRole('searchbox').fill('needle')
 await expect(dialog.getByRole('listitem')).toHaveCount(2)
 await dialog.getByRole('button',{name:'닫기',exact:true}).focus()
 await win.keyboard.press('Meta+p')
 await expect(win.getByRole('dialog',{name:'명령 팔레트'})).toHaveCount(0)
 await expect(dialog).not.toContainText('INTERNAL-ABCDEF')
 await dialog.getByRole('combobox',{name:'에이전트',exact:true}).selectOption('claude');await expect(dialog.getByText('검색 결과가 없습니다.')).toBeVisible()
 await dialog.getByRole('combobox',{name:'에이전트',exact:true}).selectOption('codex');await expect(dialog.getByRole('listitem')).toHaveCount(2)
 await captureWindow(app,'test-results/conversation-search.png')
 await dialog.getByRole('listitem').first().getByRole('button').click()
 await expect(dialog).toHaveCount(0)
 await expect(win.locator('[data-testid="task-view"]:visible')).toHaveAttribute('data-task-name','B')
 await expect(win.locator('[data-testid="chat-pane"]:visible [data-chat-turn="0"]')).toBeVisible()
 await expect(win.getByTestId('chat-input')).toHaveValue('')
})
test('검색 뒤 바뀐 대화는 잘못 열지 않으며 작은 창 확대에서도 닫을 수 있다',async()=>{
 await open();const dialog=win.getByRole('dialog',{name:'대화 찾기'})
 await dialog.getByRole('searchbox').fill('needle');await expect(dialog.getByRole('listitem')).toHaveCount(2)
 writeFileSync(join(data,'chat/b-pane.jsonl'),JSON.stringify({t:'user',text:'changed',at:99}))
 await dialog.getByRole('listitem').first().getByRole('button').click()
 await expect(dialog.getByRole('alert')).toContainText('다시 검색')
 await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0]!;w.setSize(640,400);w.webContents.setZoomFactor(2)})
 await expect.poll(()=>win.evaluate(()=>innerWidth)).toBe(320)
 await win.evaluate(()=>document.documentElement.dataset.theme='light')
 await expect.poll(()=>dialog.evaluate(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&e.scrollWidth<=e.clientWidth+1})).toBe(true)
 await expect(dialog.getByRole('button',{name:'닫기',exact:true})).toBeInViewport()
 await captureWindow(app,'test-results/conversation-search-small-light.png')
 await dialog.getByRole('searchbox').press('Escape');await expect(dialog).toHaveCount(0)
})

test('메모리에 열린 대화는 디스크 앞부분이 잘려도 같은 메시지로 한 번만 이동한다',async()=>{
 await app.close()
 const events=Array.from({length:45},(_,i)=>[{t:'user',text:`needle${i}\n`+'내용\n'.repeat(8),at:i+1},{t:'text',text:`reply needle${i}`},{t:'turn_end',ok:true,ms:1,reason:'done'}]).flat()
 writeFileSync(join(data,'chat/b-pane.jsonl'),events.map(e=>JSON.stringify(e)).join('\n'))
 app=await electron.launch({args:['.'],env:{...process.env,TASKMINAL_USER_DATA:data}});win=await firstWindow(app);await waitLoaded(win)
 await win.locator('[data-testid="task-row"][data-task-name="B"]').click()
 const user=win.locator('[data-testid="chat-pane"]:visible [data-kind="user"]').filter({hasText:'needle20'})
 await expect(user).toHaveCount(1)
 writeFileSync(join(data,'chat/b-pane.jsonl'),events.slice(60).map(e=>JSON.stringify(e)).join('\n'))
 await open();const dialog=win.getByRole('dialog',{name:'대화 찾기'})
 await dialog.getByRole('searchbox').fill('needle20');await expect(dialog.getByRole('listitem')).toHaveCount(2)
 await dialog.getByRole('listitem').first().getByRole('button').click()
 await expect(user).toBeFocused();await expect(user).toBeInViewport()
 const input=win.getByTestId('chat-input');await input.focus()
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]!.webContents.send('chat:event','b-pane',{t:'text',text:'late-output'},1000))
 await expect(win.locator('[data-kind="text"]').last()).toContainText('late-output')
 await expect(input).toBeFocused()
})
test('결과 검증 중 검색창을 닫으면 늦은 검증 완료가 일감을 바꾸지 않는다',async()=>{
 await app.evaluate(({ipcMain})=>{
  const g=globalThis as unknown as {releaseVerify?:(v:boolean)=>void}
  ipcMain.removeHandler('conversations:verify')
  ipcMain.handle('conversations:verify',()=>new Promise<boolean>(resolve=>{g.releaseVerify=resolve}))
 })
 await open();const dialog=win.getByRole('dialog',{name:'대화 찾기'})
 await dialog.getByRole('searchbox').fill('needle');await expect(dialog.getByRole('listitem')).toHaveCount(2)
 await dialog.getByRole('listitem').first().getByRole('button').click()
 await expect.poll(()=>app.evaluate(()=>typeof (globalThis as unknown as {releaseVerify?:unknown}).releaseVerify)).toBe('function')
 await dialog.getByRole('button',{name:'닫기',exact:true}).click()
 await app.evaluate(()=>(globalThis as unknown as {releaseVerify:(v:boolean)=>void}).releaseVerify(true))
 // Negative assertion after the deliberately released IPC reply has reached the renderer.
 await win.waitForTimeout(150)
 await expect(win.locator('[data-testid="task-view"]:visible')).toHaveAttribute('data-task-name','A')
 await expect(dialog).toHaveCount(0)
})
