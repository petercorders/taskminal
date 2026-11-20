import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { compareWorktrees } from '../../src/main/worktree-comparison'

let root: string
let base: string
function git(...args: string[]): string {
  return execFileSync('git', ['-C', root, '-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim()
}
function commit(): string {
  git('add', '.')
  git('commit', '-qm', 'change')
  return git('rev-parse', 'HEAD')
}
function candidate(name: string, content: string): string {
  git('switch', '--detach', '-q', base)
  writeFileSync(join(root, name), content)
  return commit()
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'taskminal-comparison-test-'))
  git('init', '-q')
  writeFileSync(join(root, 'existing.txt'), 'old\n')
  base = commit()
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

it('compares each branch against the same base and keeps the actual checkout untouched', async () => {
  const left = candidate('left.txt', 'left')
  const right = candidate('right.txt', 'right')
  writeFileSync(join(root, 'existing.txt'), 'uncommitted')
  const index = readFileSync(join(root, '.git', 'index'))
  const objects = git('count-objects', '-v')
  const result = await compareWorktrees(root, { left, right })
  expect(result).toMatchObject({
    base, left: { sha: left, changes: [{ status: 'A', path: 'left.txt' }] },
    right: { sha: right, changes: [{ status: 'A', path: 'right.txt' }] },
    merge: { state: 'clean', paths: [] },
  })
  expect(git('rev-parse', 'HEAD')).toBe(right)
  expect(git('count-objects', '-v')).toBe(objects)
  expect(readFileSync(join(root, '.git', 'index'))).toEqual(index)
  expect(readFileSync(join(root, 'existing.txt'), 'utf8')).toBe('uncommitted')
})

it('reads actual conflict paths from the merge result', async () => {
  const left = candidate('existing.txt', 'left\n')
  const right = candidate('existing.txt', 'right\n')
  expect((await compareWorktrees(root, { left, right })).merge).toEqual({ state: 'conflicts', paths: ['existing.txt'] })
})

it('reports rename paths in the comparison', async () => {
  git('mv', 'existing.txt', 'renamed file.txt')
  const left = commit()
  const right = candidate('right.txt', 'right')
  expect((await compareWorktrees(root, { left, right })).left.changes).toEqual([{ status: 'R100', from: 'existing.txt', path: 'renamed file.txt' }])
})

it('rejects a chosen base which is not an ancestor of both heads', async () => {
  const left = candidate('left.txt', 'left')
  const right = candidate('right.txt', 'right')
  await expect(compareWorktrees(root, { left, right, base: left })).rejects.toThrow('공통 조상')
})
