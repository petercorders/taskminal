import { afterEach, beforeEach, expect, test } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceFiles } from '../../src/main/workspace-files'

let base: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'tm-files-'))
  mkdirSync(join(base, 'root'))
  writeFileSync(join(base, 'outside'), 'private')
})
afterEach(() => rmSync(base, { recursive: true, force: true }))
test('root boundary includes realpath, sensitive names and binary size limits', async () => {
  const root = join(base, 'root'),
    files = new WorkspaceFiles()
  writeFileSync(join(root, 'a.ts'), 'hello\nworld')
  writeFileSync(join(root, '.env'), 'secret')
  symlinkSync(join(base, 'outside'), join(root, 'escape'))
  expect((await files.list(root, '')).map((e) => e.name)).toContain('a.ts')
  expect((await files.read(root, 'a.ts')).text).toBe('hello\nworld')
  await expect(files.read(root, '../outside')).rejects.toThrow()
  await expect(files.read(root, 'escape')).rejects.toThrow()
  await expect(files.read(root, '.env')).rejects.toThrow()
  writeFileSync(join(root, 'large.txt'), 'x'.repeat(2_100_000))
  await expect(files.read(root, 'large.txt')).rejects.toThrow('2 MB')
})
test('snapshot is masked, fingerprint detects changes, and missing file reports error', async () => {
  const root = join(base, 'root'),
    files = new WorkspaceFiles()
  writeFileSync(join(root, 'a.txt'), 'token=ghp_' + 'a'.repeat(36))
  const first = await files.read(root, 'a.txt')
  expect(first.text).not.toContain('ghp_')
  writeFileSync(join(root, 'a.txt'), 'new')
  expect((await files.read(root, 'a.txt')).signature).not.toBe(first.signature)
  await expect(files.read(root, 'missing')).rejects.toThrow()
})
test('file preview applies current custom masking rules',async()=>{
  const root=join(base,'root')
  writeFileSync(join(root,'custom.txt'),'INTERNAL-ABCDEF')
  const options=()=>({custom:[{name:'내부값',pattern:'INTERNAL-[A-Z]{6}'}]})
  const file=await new WorkspaceFiles(options).read(root,'custom.txt')
  expect(file.text).not.toContain('INTERNAL-ABCDEF')
  expect(file.text).toContain('가림')
})
