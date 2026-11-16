import { test, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, symlinkSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AtomicJournal } from '../../src/main/atomic-journal'
const valid=(v:unknown):v is {value:string}=>!!v&&typeof v==='object'&&typeof (v as {value:unknown}).value==='string'
test('ordinary atomic writes are private; stale temp links cannot truncate another file',()=>{
 const d=mkdtempSync(join(tmpdir(),'journal-'))
 try{const target=join(d,'target'),file=join(d,'journal');writeFileSync(target,'keep');symlinkSync(target,file+'.tmp');const store=new AtomicJournal(file,valid);store.load({value:''});store.save({value:'new'});expect(readFileSync(target,'utf8')).toBe('keep');expect(store.load({value:''})).toEqual({value:'new'});expect(statSync(file).mode&0o777).toBe(0o600)}finally{rmSync(d,{recursive:true,force:true})}
})
test('symlink/corrupt/oversize input fails closed and preserves original',()=>{
 const d=mkdtempSync(join(tmpdir(),'journal-'))
 try{for(const mode of ['link','corrupt','large']){const file=join(d,mode),target=join(d,'target');writeFileSync(target,'keep');if(mode==='link')symlinkSync(target,file);else writeFileSync(file,mode==='large'?'x'.repeat(10*1024*1024+1):'{');const store=new AtomicJournal(file,valid);expect(()=>store.load({value:''})).toThrow();expect(()=>store.save({value:'replace'})).toThrow();expect(readFileSync(target,'utf8')).toBe('keep')}}finally{rmSync(d,{recursive:true,force:true})}
})
