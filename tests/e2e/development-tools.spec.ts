import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { captureWindow, firstWindow, seedState, waitLoaded } from './helpers'
let temp:string,root:string,target:string,app:ElectronApplication,win:Page
const git=(...args:string[])=>execFileSync('git',['-c','commit.gpgsign=false',...args],{cwd:root,encoding:'utf8'})
function config(commands:Array<{file:string;args:string[]}>=[]){writeFileSync(join(root,'.taskminal/environment.json'),JSON.stringify({copies:['.env'],commands}))}
test.beforeEach(async()=>{
 temp=realpathSync(mkdtempSync(join(tmpdir(),'tm-development-')));root=join(temp,'repo');target=join(temp,'checkout');mkdirSync(root);mkdirSync(join(root,'.taskminal'))
 git('init','-q');git('config','user.email','test@example.com');git('config','user.name','Test');writeFileSync(join(root,'.gitignore'),'.env\n');config();git('add','.');git('commit','-m','fixture');git('worktree','add','-q','-b','worker',target)
 writeFileSync(join(root,'.env'),'ORIGINAL_PRIVATE_CONFIG=local\n')
 const data=join(temp,'data');mkdirSync(data);seedState(data,[{id:'t',name:'환경 검증',paneId:'p',cwd:root}])
 app=await electron.launch({args:['.'],env:{...process.env,TASKMINAL_USER_DATA:data}});win=await firstWindow(app);await waitLoaded(win)
 await win.getByRole('button',{name:'환경·확장',exact:true}).click();await expect(win.getByTestId('development-panel')).toBeVisible()
})
test.afterEach(async()=>{await app?.close();rmSync(temp,{recursive:true,force:true,maxRetries:5})})
async function preview(){await win.getByRole('textbox',{name:'준비할 worktree 경로',exact:true}).fill(target);await win.getByRole('button',{name:'환경 준비 미리보기',exact:true}).click();await expect(win.getByText('로컬 명령은 이 컴퓨터의 권한으로 실행됩니다.',{exact:false})).toBeVisible()}
test('환경 미리보기 확인 뒤 ignored 설정을 독립 복사하고 기존 대상은 보존한다',async()=>{
 config([{file:process.execPath,args:['-e',"require('fs').writeFileSync('ready.txt','prepared')"]}])
 await preview();await expect(win.getByTestId('environment-preview')).not.toContainText('ORIGINAL_PRIVATE_CONFIG');await win.getByTestId('environment-preview').scrollIntoViewIfNeeded();await captureWindow(app,'/tmp/taskminal-50-environment-preview.png');await win.getByRole('button',{name:'확인하고 환경 준비',exact:true}).click()
 await expect(win.getByTestId('preparation-record').first().locator('strong')).toHaveText('완료');expect(readFileSync(join(target,'.env'),'utf8')).toBe('ORIGINAL_PRIVATE_CONFIG=local\n');expect(readFileSync(join(target,'ready.txt'),'utf8')).toBe('prepared')
 writeFileSync(join(target,'.env'),'CHECKOUT_ONLY=kept\n');await preview();await expect(win.getByTestId('environment-preview')).toContainText('기존 파일 보존');await win.getByRole('button',{name:'확인하고 환경 준비',exact:true}).click()
 await expect(win.getByTestId('preparation-record')).toHaveCount(2);await expect(win.getByTestId('preparation-record').first().locator('strong')).toHaveText('완료');await expect.poll(()=>readFileSync(join(target,'.env'),'utf8')).toBe('CHECKOUT_ONLY=kept\n');expect(readFileSync(join(root,'.env'),'utf8')).toBe('ORIGINAL_PRIVATE_CONFIG=local\n')
 await captureWindow(app,'/tmp/taskminal-50-environment.png')
})
test('명령 실패를 표시하고 새 미리보기·명시적 새 요청으로 재시도한다',async()=>{
 config([{file:process.execPath,args:['-e','process.exit(7)']}]);await preview();await win.getByRole('button',{name:'확인하고 환경 준비',exact:true}).click();await expect(win.getByTestId('preparation-record').first().locator('strong')).toHaveText('실패')
 config([{file:process.execPath,args:['-e',"require('fs').writeFileSync('retried.txt','ok')"]}]);await preview();await win.getByRole('button',{name:'확인하고 환경 준비',exact:true}).click();await expect(win.getByTestId('preparation-record').first().locator('strong')).toHaveText('완료');expect(readFileSync(join(target,'retried.txt'),'utf8')).toBe('ok')
})
test('선언형 확장을 확인·설치하고 비활성·재활성하며 본문은 일반 텍스트로 표시한다',async()=>{
 const body='<script>globalThis.extensionExecuted=true</script>'
 writeFileSync(join(root,'extension.json'),JSON.stringify({id:'fixture',name:'샘플 확장',version:'1.0.0',panels:[{id:'notes',title:'샘플 패널',body}],commands:[{id:'docs',title:'공식 문서',url:'https://example.com/docs'}]}))
 await win.getByRole('textbox',{name:'확장 manifest 상대 경로',exact:true}).fill('extension.json');await win.getByRole('button',{name:'확장 검사',exact:true}).click();await expect(win.getByTestId('extension-preview')).toContainText('샘플 확장');await expect(win.getByTestId('extension-preview')).toContainText('https://example.com/docs');await win.getByRole('button',{name:'확인하고 확장 설치',exact:true}).click()
 await expect(win.getByTestId('extension-panel')).toHaveText('샘플 패널'+body);expect(await win.evaluate(()=>Object.hasOwn(globalThis,'extensionExecuted'))).toBe(false)
 await win.getByRole('button',{name:'비활성화 샘플 확장',exact:true}).click();await expect(win.getByTestId('extension-panel')).toHaveCount(0);await win.getByRole('button',{name:'활성화 샘플 확장',exact:true}).click();await expect(win.getByTestId('extension-panel')).toContainText(body)
 await win.getByTestId('extension-panel').scrollIntoViewIfNeeded();await captureWindow(app,'/tmp/taskminal-50-extensions.png');await win.getByRole('button',{name:'제거 샘플 확장',exact:true}).click();await expect(win.getByTestId('extension-panel')).toHaveCount(0)
})
test('준비 완료 응답 유실 뒤 같은 요청 번호로 확인하고 초기화 명령은 한 번만 실행한다',async()=>{
 config([{file:process.execPath,args:['-e',"require('fs').appendFileSync('count.txt','once\\n')"]}])
 await app.evaluate(({ipcMain})=>{
  const handlers=(ipcMain as unknown as {_invokeHandlers:Map<string,(...args:unknown[])=>Promise<unknown>>})._invokeHandlers
  const original=handlers.get('development:request')!;if(!original)throw Error('development handler missing')
  let lost=false
  ipcMain.removeHandler('development:request');ipcMain.handle('development:request',async(...args)=>{const result=await original(...args);if(args[1]==='prepare'&&!lost){lost=true;throw Error('lost reply')}return result})
 })
 await preview();await win.getByRole('button',{name:'확인하고 환경 준비',exact:true}).click();await expect(win.getByRole('alert')).toContainText('같은 요청 번호')
 await win.getByRole('button',{name:'같은 요청 번호로 결과 확인',exact:true}).click();await expect(win.getByRole('button',{name:'같은 요청 번호로 결과 확인',exact:true})).toHaveCount(0)
 expect(readFileSync(join(target,'count.txt'),'utf8')).toBe('once\n');await expect(win.getByTestId('preparation-record')).toHaveCount(1)
})
test('패널을 닫아도 준비를 유지하고 다시 열어 실제 실행 중인 명령을 중단한다',async()=>{
 config([{file:process.execPath,args:['-e',"require('fs').writeFileSync('started.txt','started');setInterval(()=>{},1000)"]}]);await preview();await win.getByRole('button',{name:'확인하고 환경 준비',exact:true}).click()
 await expect.poll(()=>{try{return readFileSync(join(target,'started.txt'),'utf8')}catch{return ''}}).toBe('started')
 await win.getByRole('button',{name:'작업 보조 화면 닫기',exact:true}).click();await win.getByRole('button',{name:'환경·확장',exact:true}).click()
 await expect(win.getByTestId('preparation-record').first().locator('strong')).toHaveText('실행 중');await win.getByRole('button',{name:'환경 준비 중단',exact:true}).click();await expect(win.getByTestId('preparation-record').first().locator('strong')).toHaveText('중단')
})
test('좁은 창과 200% 확대에서도 준비 확인·취소와 확장 검사에 키보드로 도달한다',async()=>{
 await win.setViewportSize({width:640,height:480})
 await preview()
 const panel=win.getByTestId('development-panel')
 await expect.poll(()=>panel.evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true)
 const cancel=win.getByRole('button',{name:'미리보기 취소',exact:true})
 await cancel.focus();await win.keyboard.press('Enter');await expect(win.getByTestId('environment-preview')).toHaveCount(0)
 await win.screenshot({path:'/tmp/taskminal-50-development-narrow.png'})
 await win.setViewportSize({width:1280,height:800})
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(2))
 await expect.poll(()=>panel.evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true)
 const input=win.getByRole('textbox',{name:'확장 manifest 상대 경로',exact:true});await input.focus();await input.fill('missing.json');await win.keyboard.press('Tab')
 await expect(win.getByRole('button',{name:'확장 검사',exact:true})).toBeFocused()
 await win.keyboard.press('Enter');await expect(win.getByRole('alert')).toBeVisible()
 await win.screenshot({path:'/tmp/taskminal-50-development-zoom.png'})
})
