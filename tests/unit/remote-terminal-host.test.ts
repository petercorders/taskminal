import { afterEach,expect,test,vi } from 'vitest'
import { mkdtempSync,rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const fake=vi.hoisted(()=>({options:undefined as any,request:vi.fn(),send:vi.fn(),dispose:vi.fn()}))
vi.mock('../../src/main/ptyhost/client',()=>({HostClient:class {
 connected=true
 constructor(options:unknown){fake.options=options}
 start=async()=>{}
 request=fake.request
 send=fake.send
 dispose=fake.dispose
}}))
import { RemoteTerminalHost } from '../../src/main/remote/terminal-host'
let dir='',host:RemoteTerminalHost|undefined
afterEach(()=>{host?.dispose();if(dir)rmSync(dir,{recursive:true,force:true});vi.clearAllMocks()})
test('restore places serialized screen before attach-time live data, sends fire-and-forget controls and detaches on dispose',async()=>{
 dir=mkdtempSync(join(tmpdir(),'tm-remote-host-'))
 fake.request.mockImplementation(async(r:any)=>{
  if(r.op==='list')return {sessions:[{paneId:'session'}]}
  if(r.op==='attach'){fake.options.onData('session','LIVE');return {screen:'SCREEN'}}
  return {}
 });fake.send.mockReturnValue(true)
 host=new RemoteTerminalHost(dir,'host.js');const data=vi.fn(),exit=vi.fn()
 await host.start(['session'],data,exit)
 expect(data.mock.calls).toEqual([['session','SCREEN'],['session','LIVE']])
 await host.write('session','a');await host.resize('session',80,24)
 expect(fake.send.mock.calls).toEqual([[{op:'write',paneId:'session',data:'a'}],[{op:'resize',paneId:'session',cols:80,rows:24}]])
 fake.options.onExit('session',{exitCode:2})
 await expect(host.write('session','late')).rejects.toThrow()
 expect(exit).toHaveBeenCalledWith('session',2)
 host.dispose();expect(fake.send.mock.calls.some(([r])=>r.op==='kill')).toBe(false)
})
test('missing guardian session is marked exited instead of respawning an old command',async()=>{
 dir=mkdtempSync(join(tmpdir(),'tm-remote-host-'));fake.request.mockResolvedValue({sessions:[]})
 host=new RemoteTerminalHost(dir,'host.js');const exit=vi.fn()
 await host.start(['gone'],vi.fn(),exit)
 expect(exit).toHaveBeenCalledWith('gone',-1)
 await expect(host.write('gone','a')).rejects.toThrow()
 expect(fake.request.mock.calls).toEqual([[{op:'list'}]])
})
