import { execFileSync } from 'node:child_process'
import { afterEach, expect, test, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rename, symlink, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RECEIPT_KEEP, RemoteWorkspaceServer } from '../../src/main/remote/workspace-server'
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
  const rejected = Promise.all([expect(blocker).rejects.toThrow(), expect(queuedSave).rejects.toThrow('경계'), expect(queuedTerminal).rejects.toThrow('경계')])
  release(); await rejected
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


test('git diff includes staged and working changes even before the first commit', async () => {
  temp = await realpath(await mkdtemp(join(tmpdir(), 'tm-remote-git-')))
  const root = join(temp, 'repo'); await mkdir(root)
  const git = (...args: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' })
  git('init', '-q'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@example.invalid')
  service = new RemoteWorkspaceServer(root, join(temp, 'data'))
  const w = await service.call('open', ['.', 'open']) as {id: string}
  const diff = () => service!.call('git', [w.id]) as Promise<{status: string; diff: string}>
  await writeFile(join(root, 'note.txt'), 'initial staged\n'); git('add', 'note.txt')
  expect((await diff()).diff).toContain('+initial staged')
  git('commit', '-qm', 'initial')
  await writeFile(join(root, 'note.txt'), 'staged change\n'); git('add', 'note.txt')
  expect((await diff()).status).toContain('M  note.txt')
  expect((await diff()).diff).toContain('+staged change')
  await writeFile(join(root, 'note.txt'), 'working change\n')
  const mixed = await diff()
  expect(mixed.diff).toContain('+staged change'); expect(mixed.diff).toContain('+working change')
  git('reset', '-q', 'HEAD')
  const working = await diff()
  expect(working.diff).toContain('+working change'); expect(working.diff).not.toContain('+staged change')
})

// 58단계: 요청 기록이 쓰기(터미널 글자)마다 하나씩 쌓이고 지워지지 않아 1만에서 모든 쓰기가 400 으로 막혔다.
async function terminalServer() {
  temp = await realpath(await mkdtemp(join(tmpdir(), 'tm-remote-receipts-')))
  const root = join(temp, 'root'); await mkdir(root)
  const write = vi.fn()
  vi.mocked(pty.spawn).mockReturnValue({ onData: vi.fn(), onExit: vi.fn(), kill: vi.fn(), resize: vi.fn(), write } as never)
  service = new RemoteWorkspaceServer(root, join(temp, 'data'))
  const w = await service.call('open', ['.', 'r-open']) as { id: string }
  const t = await service.call('terminal', [w.id, 'r-term']) as { id: string }
  const receipts = () => (Reflect.get(service!, 'data') as { receipts: Array<{ id: string; hash: string; done: boolean; result?: unknown }> }).receipts
  const seed = (n: number, done = true) => { for (let i = 0; i < n; i++) receipts().push({ id: `seed-${done ? 'd' : 'u'}-${receipts().length}`, hash: 'a'.repeat(64), done, ...(done ? { result: null } : {}) }) }
  const type = (requestId: string, data = 'x') => service!.call('write', [w.id, t.id, { requestId, data }])
  return { write, receipts, seed, type }
}

test('끝난 요청 기록이 1만에 가까워도 쓰기가 막히지 않고, 끝난 기록은 최근 것만 남는다', async () => {
  const { write, receipts, seed, type } = await terminalServer()
  seed(9_995)
  for (let i = 0; i < 20; i++) await type(`w-${i}`)
  expect(write).toHaveBeenCalledTimes(20)
  expect(receipts().filter((r) => r.done).length).toBeLessThanOrEqual(RECEIPT_KEEP)
  expect(receipts().some((r) => r.id === 'w-19')).toBe(true)
})

test('정리 뒤에도 방금 보낸 번호를 다시 보내면 한 번만 실행된다', async () => {
  const { write, seed, type } = await terminalServer()
  seed(9_995)
  await type('again', 'q')
  for (let i = 0; i < 50; i++) await type(`after-${i}`)
  await type('again', 'q')
  expect(write.mock.calls.filter(([data]) => data === 'q')).toHaveLength(1)
})

test('안 끝난 기록(중단된 요청의 울타리)은 정리하지 않는다 — 같은 번호는 다시 실행되지 않고 거절된다', async () => {
  const { write, receipts, seed, type } = await terminalServer()
  receipts().unshift({ id: 'stuck', hash: 'a'.repeat(64), done: false })
  seed(9_990)
  for (let i = 0; i < 5; i++) await type(`w-${i}`)
  expect(receipts().some((r) => r.id === 'stuck' && !r.done)).toBe(true)
  await expect(type('stuck')).rejects.toThrow()
  expect(write).toHaveBeenCalledTimes(5)
})

test('한계: 최근 것 밖으로 밀려 지워진 옛 번호는 새 요청으로 실행된다', async () => {
  const { write, seed, type } = await terminalServer()
  await type('old', 'o')
  seed(RECEIPT_KEEP + 10)
  await type('newer')
  await type('old', 'o')
  expect(write.mock.calls.filter(([data]) => data === 'o')).toHaveLength(2)
})
