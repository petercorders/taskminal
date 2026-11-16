import { afterEach, expect, test } from 'vitest'
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync,symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { DevelopmentTools } from '../../src/main/development-tools'
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
