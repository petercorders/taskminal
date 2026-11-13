import { afterEach, expect, test, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const race = vi.hoisted(() => ({ beforeOpen: null as (() => void) | null }))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      race.beforeOpen?.()
      return actual.open(...args)
    },
  }
})
import { WorkspaceFiles } from '../../src/main/workspace-files'
let dir = ''
afterEach(() => {
  race.beforeOpen = null
  if (dir) rmSync(dir, { recursive: true, force: true })
})
test('symlink replacement after validation never reads the external file', async () => {
  dir = mkdtempSync(join(tmpdir(), 'tm-file-race-'))
  const root = join(dir, 'root')
  mkdirSync(root)
  writeFileSync(join(root, 'inside.txt'), 'inside')
  writeFileSync(join(dir, 'outside.txt'), 'outside')
  race.beforeOpen = () => {
    unlinkSync(join(root, 'inside.txt'))
    symlinkSync(join(dir, 'outside.txt'), join(root, 'inside.txt'))
  }
  await expect(new WorkspaceFiles().read(root, 'inside.txt')).rejects.toThrow()
})
