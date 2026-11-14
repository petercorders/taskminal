import { afterEach, expect, test, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rename, symlink, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemoteWorkspaceServer } from '../../src/main/remote/workspace-server'
import type { WorkspaceFiles } from '../../src/main/workspace-files'
import * as pty from 'node-pty'
vi.mock('node-pty',()=>({spawn: vi.fn()}))
let temp = '', service: RemoteWorkspaceServer | undefined
afterEach(async () => { service?.dispose(); service = undefined; vi.restoreAllMocks(); if(temp) await rm(temp, {recursive:true,force:true}) })
test('queued writes revalidate the canonical workspace after waiting, before a side effect', async () => {
  temp = await realpath(await mkdtemp(join(tmpdir(),'tm-remote-unit-')))
  const root=join(temp,'root'), project=join(root,'project'), outside=join(temp,'outside')
  await mkdir(project,{recursive:true});await mkdir(outside);await writeFile(join(project,'note.txt'),'same');await writeFile(join(outside,'note.txt'),'same')
  service=new RemoteWorkspaceServer(root,join(temp,'data'))
  const w=await service.call('open',['project','initial']) as {id:string}
  const file=await service.call('read',[w.id,'note.txt']) as {signature:string}
  let release!:()=>void, entered!:()=>void
  const gate=new Promise<void>(r=>release=r), ready=new Promise<void>(r=>entered=r)
  const files=Reflect.get(service,'files') as WorkspaceFiles, original=files.path.bind(files)
  vi.spyOn(files,'path').mockImplementation(async(root,path)=>{if(path==='project'){entered();await gate}return original(root,path)})
  const blocker=service.call('open',['project','blocker']);await ready
  const internal=service as unknown as {cwd(w: unknown): Promise<string>}
  const originalCwd=internal.cwd.bind(service)
  let checks=0, checked!:()=>void
  const checkedBeforeQueue=new Promise<void>(r=>checked=r)
  vi.spyOn(internal,'cwd').mockImplementation(async w=>{const result=await originalCwd(w);if(++checks===2)checked();return result})
  const queuedSave=service.call('save',[w.id,'note.txt',{signature:file.signature,text:'bad'},'queued-save'])
  const queuedTerminal=service.call('terminal',[w.id,'queued-terminal'])
  // Both initial cwd checks completed successfully while open still holds the mutation queue.
  await checkedBeforeQueue;await new Promise<void>(r=>setImmediate(r))
  await rename(project,join(root,'original'));await symlink(outside,project)
  release();await expect(blocker).rejects.toThrow()
  await expect(queuedSave).rejects.toThrow('경계');await expect(queuedTerminal).rejects.toThrow('경계')
  expect(await readFile(join(outside,'note.txt'),'utf8')).toBe('same')
})
test('exited terminal retains output but releases the PID before stop or server shutdown', async () => {
  temp=await realpath(await mkdtemp(join(tmpdir(),'tm-remote-exit-')))
  const root=join(temp,'root');await mkdir(root)
  let exit!:(e:{exitCode:number})=>void, output!:(s:string)=>void
  const kill=vi.fn()
  vi.mocked(pty.spawn).mockReturnValue({kill,onData:(fn:(data:string)=>void)=>{output=fn;return{dispose(){}}},onExit:(fn:(event:{exitCode:number})=>void)=>{exit=fn;return{dispose(){}}}} as unknown as pty.IPty)
  service=new RemoteWorkspaceServer(root,join(temp,'data'))
  const w=await service.call('open',['.','open']) as {id:string}
  const s=await service.call('terminal',[w.id,'terminal']) as {id:string}
  output('finished output');exit({exitCode:0})
  await service.call('stop',[w.id,s.id])
  expect(await service.call('tail',[w.id,s.id])).toEqual({data:'finished output',exited:0})
  service.dispose();expect(kill).not.toHaveBeenCalled()
  await expect(service.call('terminal',[w.id,'after-stop'])).rejects.toThrow('종료')
})
