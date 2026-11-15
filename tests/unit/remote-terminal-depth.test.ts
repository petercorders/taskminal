import { afterEach, expect, test, vi } from 'vitest'
import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemoteWorkspaceServer } from '../../src/main/remote/workspace-server'
vi.mock('node-pty',()=>({spawn:vi.fn()}))
import { spawn } from 'node-pty'
let dir='',server:RemoteWorkspaceServer|undefined
afterEach(()=>{server?.dispose();vi.restoreAllMocks();if(dir)rmSync(dir,{recursive:true,force:true})})
test('raw terminal stream uses monotonic offsets, retains ANSI, validates resize and has no duplicate chunks',async()=>{
 dir=realpathSync(mkdtempSync(join(tmpdir(),'tm-stream-')))
 let output!:(s:string)=>void
 const resize=vi.fn(),write=vi.fn()
 vi.mocked(spawn).mockReturnValue({onData:(f:any)=>{output=f},onExit:vi.fn(),kill:vi.fn(),resize,write} as any)
 server=new RemoteWorkspaceServer(dir,join(dir,'state'))
 const w=await server.call('open',['.','open']) as {id:string},t=await server.call('terminal',[w.id,'term']) as {id:string}
 output('\x1b[31mRED\x1b[0m')
 const a=await server.call('stream',[w.id,t.id,0]) as {data:string;offset:number;start:number}
 expect(a.data).toBe('\x1b[31mRED\x1b[0m')
 expect((await server.call('stream',[w.id,t.id,a.offset]) as any).data).toBe('')
 output('new');expect((await server.call('stream',[w.id,t.id,a.offset]) as any).data).toBe('new')
 await server.call('resize',[w.id,t.id,80,24]);expect(resize).toHaveBeenCalledWith(80,24)
 await expect(server.call('resize',[w.id,t.id,-1,24])).rejects.toThrow()
 await expect(server.call('stream',[w.id,t.id,-1])).rejects.toThrow()
 await expect(server.call('stream',[w.id,'other',0])).rejects.toThrow()
})
