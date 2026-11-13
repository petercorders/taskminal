import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Accounts } from '../../src/main/accounts'
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tm-account-protocol-'))
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})
function fake(mode: string) {
  const path = join(dir, 'fake-codex'),
    log = join(dir, 'calls')
  writeFileSync(
    path,
    `#!${process.execPath}
const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(log)},process.argv.includes('login')?'login\\n':'status\\n');
if(process.argv.includes('login')){process.stdout.write('https://example.invalid/device\\n');setTimeout(()=>process.exit(0),80)}
else require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
const req=JSON.parse(line);if(req.id===undefined)return;
let result={};if(req.method==='account/read')result=${mode === 'out' ? '{account:null,requiresOpenaiAuth:true}' : '{account:{type:"chatgpt",email:"test@example.invalid"},requiresOpenaiAuth:true}'};
if(req.method==='account/rateLimits/read')result={rateLimits:{primary:{usedPercent:0,windowDurationMins:300,resetsAt:1800000000}}};
process.stdout.write(JSON.stringify({id:req.id,result})+'\\n');
});`,
    { mode: 0o700 },
  )
  vi.stubEnv('TASKMINAL_CODEX_BIN', path)
  return log
}
test('JSON-RPC zero usage is real, concurrent status shares one process and sign-out is explicit', async () => {
  const log = fake('ok'),
    a = new Accounts(join(dir, 'accounts'))
  const [one, two] = await Promise.all([a.status('default-codex'), a.status('default-codex')])
  expect(one).toMatchObject({ state: 'ready', display: 'test@example.invalid', windows: [{ used: 0, resetsAt: 1800000000000 }] })
  expect(two).toEqual(one)
  expect(readFileSync(log, 'utf8')).toBe('status\n')
  fake('out')
  expect(await a.status('default-codex')).toMatchObject({ state: 'signed-out', windows: [] })
  a.dispose()
})
test('same-frame login starts one isolated process and completed credentials are never copied from default', async () => {
  const log = fake('ok'),
    a = new Accounts(join(dir, 'accounts'))
  a.add('codex', '추가')
  const id = a.list().find((x) => x.name === '추가')!.id
  await Promise.all([a.login(id), a.login(id)])
  await expect
    .poll(() => {
      try {
        return readFileSync(log, 'utf8')
      } catch {
        return ''
      }
    })
    .toBe('login\n')
  await expect(a.login('default-codex')).rejects.toThrow('기본 계정')
  a.cancel(id)
  a.dispose()
})
