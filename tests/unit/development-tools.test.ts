import { afterEach, expect, test } from 'vitest'
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync,symlinkSync,lstatSync,readlinkSync,existsSync,unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { DevelopmentTools,configured } from '../../src/main/development-tools'
import { linkLine } from '../../src/shared/development-tools'
let dir=''
afterEach(()=>{if(dir)rmSync(dir,{recursive:true,force:true})})
function fixture(){
 dir=realpathSync(mkdtempSync(join(tmpdir(),'tm-env-')));const root=join(dir,'repo'),target=join(dir,'worker');mkdirSync(root)
 const git=(...args:string[])=>execFileSync('git',['-c','commit.gpgsign=false',...args],{cwd:root,encoding:'utf8'})
 git('init','-q');git('config','user.name','test');git('config','user.email','test@example.invalid')
 writeFileSync(join(root,'.gitignore'),'.env\n');mkdirSync(join(root,'.taskminal'));writeFileSync(join(root,'.taskminal/environment.json'),JSON.stringify({copies:['.env'],commands:[]}));git('add','.');git('commit','-qm','init');git('worktree','add','-qb','worker',target)
 writeFileSync(join(root,'.env'),'SECRET=value\n')
 return {root,target,git,service:new DevelopmentTools(join(dir,'state'))}
}
test('previews and copies ignored local settings independently, deduplicates preparation, rejects changed approval',async()=>{
 const f=fixture(),p=await f.service.preview(f.root,f.target)
 expect(JSON.stringify(p)).not.toContain('SECRET=value')
 const done=await f.service.prepare(f.root,p,'request');expect(done.state).toBe('done')
 expect(readFileSync(join(f.target,'.env'),'utf8')).toBe('SECRET=value\n')
 writeFileSync(join(f.target,'.env'),'local change');expect((await f.service.prepare(f.root,p,'request')).state).toBe('done')
 expect(readFileSync(join(f.target,'.env'),'utf8')).toBe('local change')
 const next=await f.service.preview(f.root,f.target);writeFileSync(join(f.root,'.taskminal/environment.json'),JSON.stringify({copies:[],commands:[]}))
 await expect(f.service.prepare(f.root,next,'changed')).rejects.toThrow('바뀌')
})
test('refuses paths outside registered worktrees, tracked settings and symlink ancestors',async()=>{
 const f=fixture();await expect(f.service.preview(f.root,dir)).rejects.toThrow()
 writeFileSync(join(f.root,'.taskminal/environment.json'),JSON.stringify({copies:['.gitignore'],commands:[]}))
 await expect(f.service.preview(f.root,f.target)).rejects.toThrow()
 writeFileSync(join(f.root,'.taskminal/environment.json'),JSON.stringify({copies:['link/value'],commands:[]}));symlinkSync(dir,join(f.root,'link'))
 await expect(f.service.preview(f.root,f.target)).rejects.toThrow()
})
test('extension requires exact reviewed content; disables safely; no arbitrary script/html execution capabilities',async()=>{
 const f=fixture();const manifest={id:'notes',name:'Notes',version:'1',panels:[{id:'note',title:'Notes',body:'<script>not executable</script>'}],commands:[{id:'docs',title:'Docs',url:'https://example.com/docs'}]}
 const path='.taskminal/extension.json';writeFileSync(join(f.root,path),JSON.stringify(manifest))
 const p=await f.service.inspect(f.root,path);writeFileSync(join(f.root,path),JSON.stringify({...manifest,version:'2'}))
 await expect(f.service.install(f.root,p)).rejects.toThrow('바뀌')
 const updated=await f.service.inspect(f.root,path);await f.service.install(f.root,updated)
 expect(f.service.extensions(f.root)[0]?.enabled).toBe(true)
 f.service.enable(f.root,'notes',false);expect(f.service.extensions(f.root)[0]?.enabled).toBe(false)
 writeFileSync(join(f.root,path),JSON.stringify({...manifest,script:'evil.js'}));await expect(f.service.inspect(f.root,path)).rejects.toThrow()
 f.service.uninstall(f.root,'notes');expect(f.service.extensions(f.root)).toEqual([])
})

test('two simultaneous preparations share one command; cancelled/failed requests never silently restart',async()=>{
 const f=fixture();writeFileSync(join(f.root,'.taskminal/environment.json'),JSON.stringify({copies:[],commands:[{file:process.execPath,args:['-e',"require('fs').appendFileSync('count.txt','once\\n')"]}]}))
 const plan=await f.service.preview(f.root,f.target)
 const [a,b]=await Promise.all([f.service.prepare(f.root,plan,'same'),f.service.prepare(f.root,plan,'same')])
 expect(a.state).toBe('done');expect(b.state).toBe('done');expect(readFileSync(join(f.target,'count.txt'),'utf8')).toBe('once\n')
 writeFileSync(join(f.root,'.taskminal/environment.json'),JSON.stringify({copies:[],commands:[{file:process.execPath,args:['-e','process.exit(3)']}]}))
 const failed=await f.service.preview(f.root,f.target)
 expect((await f.service.prepare(f.root,failed,'failed')).state).toBe('failed')
 expect((await f.service.prepare(f.root,failed,'failed')).state).toBe('failed')
})
test('startup uncertainty is preserved and revoked source task authorization blocks writes',async()=>{
 const f=fixture(),data=join(dir,'uncertain');mkdirSync(data)
 writeFileSync(join(data,'tools.json'),JSON.stringify({extensions:[],preparations:[{id:'interrupted',root:f.root,target:f.target,signature:'a'.repeat(64),state:'running',log:'x'.repeat(20000)}]}))
 const restored=new DevelopmentTools(data);expect(restored.preparations(f.root)[0]?.state).toBe('unknown')
 let allowed=true;const service=new DevelopmentTools(join(dir,'authorized'),()=>allowed)
 const preview=await service.preview(f.root,f.target);allowed=false
 await expect(service.prepare(f.root,preview,'revoked')).rejects.toThrow('닫혔')
})
test('rechecks task authorization immediately at command spawn after asynchronous path validation',async()=>{
 const f=fixture();writeFileSync(join(f.root,'.taskminal/environment.json'),JSON.stringify({copies:[],commands:[{file:process.execPath,args:['-e',"require('fs').writeFileSync('unapproved.txt','bad')"]}]}))
 let checks=0;const service=new DevelopmentTools(join(dir,'spawn-check'),()=>++checks<3)
 const plan=await service.preview(f.root,f.target)
 expect((await service.prepare(f.root,plan,'revoked-at-spawn')).state).toBe('failed')
 expect(()=>readFileSync(join(f.target,'unapproved.txt'))).toThrow()
})
test('cancel during asynchronous path validation prevents the command from starting',async()=>{
 const f=fixture();writeFileSync(join(f.root,'.taskminal/environment.json'),JSON.stringify({copies:[],commands:[{file:process.execPath,args:['-e',"require('fs').writeFileSync('cancelled.txt','must not run')"]}]}))
 let checks=0;let service:DevelopmentTools
 service=new DevelopmentTools(join(dir,'cancel-gap'),()=>{if(++checks===2)queueMicrotask(()=>service.cancel(f.root,'cancel-gap'));return true})
 const plan=await service.preview(f.root,f.target)
 expect((await service.prepare(f.root,plan,'cancel-gap')).state).toBe('stopped')
 expect(()=>readFileSync(join(f.target,'cancelled.txt'))).toThrow()
})
test('executes the exact approved snapshot when source bytes change just before copying',async()=>{
 const f=fixture();let checks=0
 const service=new DevelopmentTools(join(dir,'snapshot'),()=>{if(++checks===2){writeFileSync(join(f.root,'.env'),'CHANGED_AFTER_APPROVAL');writeFileSync(join(f.root,'.taskminal/environment.json'),JSON.stringify({copies:[],commands:[{file:process.execPath,args:['-e',"require('fs').writeFileSync('unapproved.txt','bad')"]}]}))}return true})
 const plan=await service.preview(f.root,f.target)
 expect((await service.prepare(f.root,plan,'snapshot')).state).toBe('done')
 expect(readFileSync(join(f.target,'.env'),'utf8')).toBe('SECRET=value\n')
 expect(()=>readFileSync(join(f.target,'unapproved.txt'))).toThrow()
})

// 62단계 links: 원본의 무시된 폴더 shared(값 파일 하나)를 워크트리에 링크로 — 설정은 configure 로 바꾼다
function linked(config:object={copies:[],links:['shared'],commands:[]},ignore='.env\nshared\n'){
 const f=fixture(),configure=(c:object)=>writeFileSync(join(f.root,'.taskminal/environment.json'),JSON.stringify(c))
 writeFileSync(join(f.root,'.gitignore'),ignore);writeFileSync(join(f.target,'.gitignore'),ignore);mkdirSync(join(f.root,'shared'));writeFileSync(join(f.root,'shared/value.txt'),'from-source');configure(config)
 return {...f,configure}
}
const refuse=async(f:ReturnType<typeof linked>,links:unknown,why:string)=>{f.configure({copies:[],links,commands:[]});await expect(f.service.preview(f.root,f.target)).rejects.toThrow(why)}
test('a config without links previews with no links and prepares as before',async()=>{
 const f=fixture(),p=await f.service.preview(f.root,f.target)
 expect(p.links).toEqual([]);expect(p.copies).toEqual([{path:'.env',size:13,exists:false}])
 expect((await f.service.prepare(f.root,p,'no-links')).state).toBe('done');expect(readFileSync(join(f.target,'.env'),'utf8')).toBe('SECRET=value\n')
})
test('links appear in the preview with the destination state and the signature follows that state',async()=>{
 const f=linked(),p=await f.service.preview(f.root,f.target)
 expect(p.links).toEqual([{path:'shared',exists:false}])
 mkdirSync(join(f.target,'shared'));const kept=await f.service.preview(f.root,f.target)
 expect(kept.links).toEqual([{path:'shared',exists:true,state:'kept'}])
 rmSync(join(f.target,'shared'),{recursive:true});symlinkSync(join(f.root,'shared'),join(f.target,'shared'));const same=await f.service.preview(f.root,f.target)
 expect(same.links).toEqual([{path:'shared',exists:true,state:'linked'}])
 // 설정 글 · 복사는 그대로이고 링크 대상의 상태만 달랐다 — 미리 본 뒤 대상이 바뀌면 '다시 미리 보세요' 가 뜬다
 expect(new Set([p.signature,kept.signature,same.signature]).size).toBe(3)
 unlinkSync(join(f.target,'shared'));symlinkSync(dir,join(f.target,'shared'))
 expect((await f.service.preview(f.root,f.target)).links).toEqual([{path:'shared',exists:true,state:'kept'}])
})
test('links refuse malformed lists and paths that leave the folder',async()=>{
 const f=linked()
 await refuse(f,['../outside'],'상대 경로');await refuse(f,[join(f.root,'shared')],'상대 경로');await refuse(f,['.git/hooks'],'상대 경로')
 await refuse(f,['shared','shared'],'형식');await refuse(f,Array.from({length:11},(_,i)=>'d'+i),'형식');await refuse(f,'shared','형식');await refuse(f,[1],'형식')
 const ten=Array.from({length:10},(_,i)=>'d'+i);writeFileSync(join(f.root,'.gitignore'),'.env\nd?\n');for(const d of ten)mkdirSync(join(f.root,d))
 f.configure({copies:[],links:ten,commands:[]});expect((await f.service.preview(f.root,f.target)).links).toHaveLength(10)
})
test('links refuse unignored, tracked, missing and symlinked sources',async()=>{
 const f=linked(undefined,'.env\nshared\nvia\nalias\ngone\nheld\n')
 // 무시하지 않는 폴더 — 추적하지 않아도 거절
 mkdirSync(join(f.root,'plain'));await refuse(f,['plain'],'추적하지 않는')
 // 무시 규칙에 걸려도 원본이 그 안의 파일을 추적하면 거절 (git check-ignore 는 인덱스에 있는 경로를 무시됨으로 보지 않는다)
 mkdirSync(join(f.root,'held'));writeFileSync(join(f.root,'held/tracked.txt'),'tracked');f.git('add','-f','held/tracked.txt');await refuse(f,['held'],'추적하지 않는')
 // 원본에서는 무시하지만 대상 워크트리가 추적하는 경로
 mkdirSync(join(f.target,'shared'));writeFileSync(join(f.target,'shared/kept.txt'),'tracked');execFileSync('git',['add','-f','shared/kept.txt'],{cwd:f.target})
 await refuse(f,['shared'],'추적하지 않는')
 await refuse(f,['gone'],'원본이 없어요')
 symlinkSync(dir,join(f.root,'via'));mkdirSync(join(dir,'inner'));await refuse(f,['via/inner'],'심볼릭')
 symlinkSync(join(f.root,'shared'),join(f.root,'alias'));await refuse(f,['alias'],'심볼릭')
})
test('links point an absent destination at the absolute source, after copies and before commands',async()=>{
 const read="const fs=require('fs');fs.writeFileSync('seen.txt',fs.readFileSync('shared/value.txt','utf8')+'|'+fs.readFileSync('.env','utf8'))"
 const f=linked({copies:['.env'],links:['shared','pkg/cache','local.db'],commands:[{file:process.execPath,args:['-e',read]}]},'.env\nshared\npkg/cache\nlocal.db\n')
 mkdirSync(join(f.root,'pkg/cache'),{recursive:true});writeFileSync(join(f.root,'local.db'),'source-db')
 const done=await f.service.prepare(f.root,await f.service.preview(f.root,f.target),'link')
 expect(done.state).toBe('done')
 for(const path of ['shared','pkg/cache','local.db'])expect(readlinkSync(join(f.target,path))).toBe(join(f.root,path))
 expect(lstatSync(join(f.target,'pkg')).isSymbolicLink()).toBe(false)
 // 명령은 복사한 파일과 링크된 폴더를 둘 다 읽는다 — 명령이 먼저 돌면 실패한다
 expect(readFileSync(join(f.target,'seen.txt'),'utf8')).toBe('from-source|SECRET=value\n')
 const copied=done.log.indexOf('.env — 복사 완료'),first=done.log.indexOf('shared — 원본에 연결')
 expect(copied).toBeGreaterThanOrEqual(0);expect(first).toBeGreaterThan(copied);expect(done.log).toContain('pkg/cache — 원본에 연결');expect(done.log).toContain('local.db — 원본에 연결')
 // 링크라서 워크트리에서 고치면 원본도 바뀐다
 writeFileSync(join(f.target,'shared/value.txt'),'changed-in-worktree');expect(readFileSync(join(f.root,'shared/value.txt'),'utf8')).toBe('changed-in-worktree')
})
test('links leave an existing folder or file at the destination untouched and say so',async()=>{
 const f=linked({copies:[],links:['shared','local.db'],commands:[]},'.env\nshared\nlocal.db\n');writeFileSync(join(f.root,'local.db'),'source-db')
 mkdirSync(join(f.target,'shared'));writeFileSync(join(f.target,'shared/own.txt'),'worktree-only');writeFileSync(join(f.target,'local.db'),'worktree-db')
 const p=await f.service.preview(f.root,f.target);expect(p.links).toEqual([{path:'shared',exists:true,state:'kept'},{path:'local.db',exists:true,state:'kept'}])
 const done=await f.service.prepare(f.root,p,'kept')
 expect(done.state).toBe('done');expect(done.log).toContain('shared — 기존 것 보존');expect(done.log).toContain('local.db — 기존 것 보존')
 expect(lstatSync(join(f.target,'shared')).isSymbolicLink()).toBe(false);expect(readFileSync(join(f.target,'shared/own.txt'),'utf8')).toBe('worktree-only')
 expect(lstatSync(join(f.target,'local.db')).isSymbolicLink()).toBe(false);expect(readFileSync(join(f.target,'local.db'),'utf8')).toBe('worktree-db')
 expect(existsSync(join(f.root,'shared/own.txt'))).toBe(false);expect(readFileSync(join(f.root,'local.db'),'utf8')).toBe('source-db')
})
test('a failed preparation keeps the link it made on record, and the next one reports it as already linked without recreating it',async()=>{
 const f=linked({copies:[],links:['shared'],commands:[{file:process.execPath,args:['-e','process.exit(3)']}]})
 const first=await f.service.prepare(f.root,await f.service.preview(f.root,f.target),'first')
 expect(first.state).toBe('failed');expect(first.log).toContain('shared — 원본에 연결')
 const made=lstatSync(join(f.target,'shared')).ino
 f.configure({copies:[],links:['shared'],commands:[]});const again=await f.service.preview(f.root,f.target)
 expect(again.links).toEqual([{path:'shared',exists:true,state:'linked'}])
 const second=await f.service.prepare(f.root,again,'second')
 expect(second.state).toBe('done');expect(second.log).toContain('shared — 이미 연결됨')
 expect(lstatSync(join(f.target,'shared')).ino).toBe(made);expect(readlinkSync(join(f.target,'shared'))).toBe(join(f.root,'shared'))
})
test('a destination that appears after the preview is never replaced by a link',async()=>{
 const f=linked(),p=await f.service.preview(f.root,f.target)
 writeFileSync(join(f.target,'shared'),'appeared');await expect(f.service.prepare(f.root,p,'stale')).rejects.toThrow('바뀌')
 expect(readFileSync(join(f.target,'shared'),'utf8')).toBe('appeared');rmSync(join(f.target,'shared'))
 // 서명을 다시 확인한 뒤 · 링크를 만들기 직전에 생긴 것도 덮지 않고 실패로 남긴다
 let checks=0;const service=new DevelopmentTools(join(dir,'late'),()=>{if(++checks===2)writeFileSync(join(f.target,'shared'),'late');return true})
 const late=await service.prepare(f.root,await service.preview(f.root,f.target),'late')
 expect(late.state).toBe('failed');expect(late.log).toContain('shared — 연결 실패')
 expect(lstatSync(join(f.target,'shared')).isSymbolicLink()).toBe(false);expect(readFileSync(join(f.target,'shared'),'utf8')).toBe('late')
})
test('configured tells whether the folder has an environment file the preview would read',async()=>{
 const f=fixture();expect(await configured(f.root)).toBe(true)
 rmSync(join(f.root,'.taskminal/environment.json'));expect(await configured(f.root)).toBe(false)
 symlinkSync(join(f.target,'.taskminal/environment.json'),join(f.root,'.taskminal/environment.json'));expect(await configured(f.root)).toBe(false)
 expect(await configured(join(dir,'missing'))).toBe(false)
})
test('a link line says it changes together with the source unless something else is kept there',()=>{
 expect(linkLine({path:'node_modules',exists:false})).toBe('node_modules · 원본에 연결 · 원본과 함께 바뀌어요')
 expect(linkLine({path:'node_modules',exists:true,state:'linked'})).toBe('node_modules · 이미 연결됨 · 원본과 함께 바뀌어요')
 expect(linkLine({path:'node_modules',exists:true,state:'kept'})).toBe('node_modules · 기존 것 보존')
})
test('links warn when the worktree would not ignore the link (a folder-only pattern)',async()=>{
 const f=linked({copies:[],links:['shared'],commands:[]},'.env\nshared/\n')
 const p=await f.service.preview(f.root,f.target);expect(p.links).toEqual([{path:'shared',exists:false,unignored:true}]);expect(linkLine(p.links[0]!)).toContain('무시하지 않아요')
 expect((await f.service.prepare(f.root,p,'warned')).state).toBe('done')
 expect((await f.service.preview(f.root,f.target)).links).toEqual([{path:'shared',exists:true,state:'linked',unignored:true}])
 // 끝의 / 없이 적으면 링크도 무시된다
 writeFileSync(join(f.target,'.gitignore'),'.env\nshared\n');const quiet=(await f.service.preview(f.root,f.target)).links
 expect(quiet).toEqual([{path:'shared',exists:true,state:'linked'}]);expect(linkLine(quiet[0]!)).not.toContain('무시하지 않아요')
})
test('a copy inside a linked folder is refused before anything is made',async()=>{
 const f=linked({copies:['shared/value.txt'],links:['shared'],commands:[]});await expect(f.service.preview(f.root,f.target)).rejects.toThrow('겹쳐요')
 f.configure({copies:['.env'],links:['shared'],commands:[]});expect((await f.service.preview(f.root,f.target)).links).toHaveLength(1)
})

test('preview distinguishes missing paths and a broken existing worktree link',async()=>{
 const f=linked({copies:[],links:['shared'],requiredPaths:['.gitignore','local.env','shared'],commands:[]})
 symlinkSync(join(dir,'gone'),join(f.target,'shared'))
 const plan=await f.service.preview(f.root,f.target)
 expect(plan.links).toEqual([{path:'shared',exists:true,state:'broken'}])
 expect(plan.readiness?.paths).toEqual([
  {path:'.gitignore',state:'present'},{path:'local.env',state:'missing'},{path:'shared',state:'broken'},
 ])
 expect(readlinkSync(join(f.target,'shared'))).toBe(join(dir,'gone'))
})

test('rejects a required path outside the selected worktree',async()=>{
 const f=linked({copies:[],requiredPaths:['../outside'],commands:[]})
 await expect(f.service.preview(f.root,f.target)).rejects.toThrow('상대 경로')
})
