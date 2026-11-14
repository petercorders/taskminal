import { afterEach, beforeEach, expect, test } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, symlinkSync, rmSync, linkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceEditor } from '../../src/main/workspace-editor'
let root: string
const editor = new WorkspaceEditor()
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'tm-editor-')); writeFileSync(join(root, 'code.ts'), 'const token = "ghp_' + 'a'.repeat(36) + '"\n') })
afterEach(() => rmSync(root, {recursive:true,force:true}))
test('editing uses original UTF8 bytes, never overwrites masked preview text', async () => {
  const file = await editor.read(root, 'code.ts')
  expect(file.text).toContain('ghp_')
  const saved = await editor.save(root, 'code.ts', {signature:file.signature,text:file.text+'// 한글\n'})
  expect(saved.ok).toBe(true)
  expect(readFileSync(join(root,'code.ts'),'utf8')).toContain('ghp_')
  expect(readFileSync(join(root,'code.ts'),'utf8')).toContain('한글')
})
test('external changes return conflict snapshot and keep disk unchanged', async () => {
  const file = await editor.read(root,'code.ts')
  writeFileSync(join(root,'code.ts'),'external')
  const result = await editor.save(root,'code.ts',{signature:file.signature,text:'mine'})
  expect(result).toMatchObject({ok:false,reason:'conflict',current:{text:'external'}})
  expect(readFileSync(join(root,'code.ts'),'utf8')).toBe('external')
})
test('two simultaneous saves with same signature cannot both commit', async () => {
  const file = await editor.read(root,'code.ts')
  const results = await Promise.all(['one','two'].map(text=>editor.save(root,'code.ts',{signature:file.signature,text})))
  expect(results.filter(r=>r.ok)).toHaveLength(1)
  expect(results.filter(r=>!r.ok)).toHaveLength(1)
})
test('sensitive files, links, binary/invalid UTF8 and oversized writes are rejected', async () => {
  writeFileSync(join(root,'.env'),'SECRET=1');writeFileSync(join(root,'target.ts'),'target');symlinkSync(join(root,'target.ts'),join(root,'link.ts'));linkSync(join(root,'code.ts'),join(root,'hard.ts'))
  for (const name of ['.env','link.ts','hard.ts','../outside']) await expect(editor.read(root,name)).rejects.toThrow()
  writeFileSync(join(root,'binary'),Buffer.from([255,0,1]))
  await expect(editor.read(root,'binary')).rejects.toThrow()
  writeFileSync(join(root,'invalid-utf8'),Buffer.from([255,65]))
  await expect(editor.read(root,'invalid-utf8')).rejects.toThrow('UTF-8')
  writeFileSync(join(root,'normal'),'hello')
  const normal=await editor.read(root,'normal')
  await expect(editor.save(root,'normal',{signature:normal.signature,text:'x'.repeat(2_000_001)})).rejects.toThrow()
  expect(readFileSync(join(root,'normal'),'utf8')).toBe('hello')
})
