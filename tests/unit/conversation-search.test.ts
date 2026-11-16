import { test, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationSearch } from '../../src/main/conversation-search'
import { emptyState } from '../../src/shared/model'

test('searches only attached chat panes and masks before matching; excludes tools', async () => {
 const dir=mkdtempSync(join(tmpdir(),'tm-conversations-'))
 try {
 const state=emptyState()
 const task={id:'t',name:'일감',cwd:'/tmp',statusId:'doing',groupId:null,color:null,tabs:[{id:'tab',layout:{type:'pane' as const,paneId:'p'},activePaneId:'p'}],activeTabId:'tab',panes:{p:{id:'p',cwd:'/tmp',kind:'chat' as const,chat:{agent:'claude' as const}},orphan:{id:'orphan',cwd:'/tmp',kind:'chat' as const,chat:{agent:'claude' as const}}},createdAt:1}
 state.tasks=[task]
 mkdirSync(join(dir,'chat'))
 writeFileSync(join(dir,'chat/p.jsonl'),[{t:'user',text:'hello INTERNAL-ABCDEF',at:5},{t:'text',text:'answer hello'},{t:'tool',id:'tool',name:'Bash',summary:'tool-only'},{t:'turn_end',ok:true,ms:1,reason:'done'}].map(e=>JSON.stringify(e)).join('\n'))
 writeFileSync(join(dir,'chat/orphan.jsonl'),JSON.stringify({t:'user',text:'orphan-only',at:1}))
 const service=new ConversationSearch(join(dir,'chat'),()=>state,()=>({custom:[{name:'내부',pattern:'INTERNAL-[A-Z]{6}'}]}))
 const [outdated,result]=await Promise.all([service.search({text:'hello'}),service.search({text:'hello'})])
 expect(outdated.hits).toEqual([])
 expect(result.hits).toHaveLength(2)
 expect(await service.verify(result.hits[0]!)).toBe(true)
 const old=result.hits[0]!
 expect(await service.verify({...old,turn:99})).toBe(false)
 expect(await service.verify({...old,fingerprint:'wrong'})).toBe(false)
 expect(result.hits[0]).toMatchObject({paneId:'p',turn:0,at:5,role:'user'})
 expect(result.hits[0]!.snippet).not.toContain('INTERNAL-ABCDEF')
 expect((await service.search({text:'INTERNAL-ABCDEF'})).hits).toEqual([])
 expect((await service.search({text:'orphan-only'})).hits).toEqual([])
 expect((await service.search({text:'tool-only'})).hits).toEqual([])
 state.tasks[0]!.archivedAt=5
 expect((await service.search({text:'hello'})).hits).toEqual([])
 expect((await service.search({text:'hello',archived:true,agent:'codex'})).hits).toEqual([])
 expect((await service.search({text:'hello',archived:true})).hits).toHaveLength(2)
 } finally {rmSync(dir,{recursive:true,force:true})}
})
test('invalid input, oversized and symlink records fail closed without hiding error as empty results',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'tm-conversations-'))
 try{
 const state=emptyState()
 state.tasks=[{id:'t',name:'일감',cwd:'/tmp',statusId:'doing',groupId:null,color:null,tabs:[{id:'tab',layout:{type:'pane',paneId:'p'},activePaneId:'p'}],activeTabId:'tab',panes:{p:{id:'p',cwd:'/tmp',kind:'chat',chat:{agent:'claude'}}},createdAt:1}]
 mkdirSync(join(dir,'chat'));writeFileSync(join(dir,'outside'),JSON.stringify({t:'text',text:'outside'}));symlinkSync(join(dir,'outside'),join(dir,'chat/p.jsonl'))
 const service=new ConversationSearch(join(dir,'chat'),()=>state)
 expect((await service.search({text:'outside'})).errors).toHaveLength(1)
 await expect(service.search({text:'a'.repeat(501)})).rejects.toThrow()
 }finally{rmSync(dir,{recursive:true,force:true})}
})
