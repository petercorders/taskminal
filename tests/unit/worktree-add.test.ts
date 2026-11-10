import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { branchOf } from '../../src/main/git-branch'
import { addWorktree } from '../../src/main/worktree'

// 15f: 실제 git 저장소(임시 폴더)에 worktree 를 만든다
let root: string
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe', env: gitEnv }).toString()

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-wt-')))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function repo(name: string): string {
  const dir = join(root, name)
  mkdirSync(join(dir, 'src'), { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'a.txt'), 'a')
  git(dir, 'add', 'a.txt')
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'first')
  return dir
}

describe('addWorktree (15f)', () => {
  it('저장소 옆에 새 브랜치 worktree 를 만들고 그 경로를 돌려준다 — 하위 폴더에서 불러도 뿌리 옆', async () => {
    const dir = repo('app')
    const got = await addWorktree(join(dir, 'src'), 'stage/15', root)
    expect(got).toEqual({ ok: true, path: join(root, 'app-stage-15') })
    expect(await branchOf(join(root, 'app-stage-15'))).toBe('stage/15')
    expect(await branchOf(dir)).toBe('main') // 원래 저장소는 그대로
  })

  it('~ 로 준 폴더도 home 기준으로 푼다', async () => {
    repo('home-repo')
    const got = await addWorktree('~/home-repo', 'feat-x', root)
    expect(got).toEqual({ ok: true, path: join(root, 'home-repo-feat-x') })
  })

  it('이미 있는 브랜치면 git 의 오류, 폴더는 남지 않는다', async () => {
    const dir = repo('app')
    git(dir, 'branch', 'taken')
    const got = await addWorktree(dir, 'taken', root)
    expect(got.ok).toBe(false)
    expect(existsSync(join(root, 'app-taken'))).toBe(false)
  })

  it('만들 자리에 폴더가 이미 있으면 git 을 부르지 않고 오류', async () => {
    const dir = repo('app')
    mkdirSync(join(root, 'app-x'))
    const got = await addWorktree(dir, 'x', root)
    expect(got).toMatchObject({ ok: false })
    expect(!got.ok && got.error).toContain('이미 있는 폴더')
    expect(git(dir, 'branch', '--list', 'x').trim()).toBe('') // 브랜치도 안 생김
  })

  it('저장소가 아니면 오류', async () => {
    const plain = join(root, 'plain')
    mkdirSync(plain)
    expect(await addWorktree(plain, 'x', root)).toMatchObject({ ok: false })
  })

  it('앞뒤 빈칸은 떼고 본다 — 끝 빈칸 때문에 바깥 저장소에 만들지 않는다 (15f 리뷰)', async () => {
    const outer = repo('outer')
    const inner = join(outer, 'inner')
    mkdirSync(inner)
    git(inner, 'init', '-q', '-b', 'main')
    writeFileSync(join(inner, 'b.txt'), 'b')
    git(inner, 'add', 'b.txt')
    git(inner, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'first')
    expect(await addWorktree(inner + ' ', 'x', root)).toEqual({ ok: true, path: join(outer, 'inner-x') })
    expect(existsSync(join(root, 'outer-x'))).toBe(false)
    expect(await addWorktree('  ~/outer', 'y', root)).toEqual({ ok: true, path: join(root, 'outer-y') })
  })

  it('상대 경로는 받지 않는다 (main 의 지금 폴더 기준으로 풀지 않게)', async () => {
    // 지금 폴더를 임시 저장소 안으로 옮겨 둔다 — 검사가 빠지면(변이) 진짜 저장소가 아니라 이 임시 저장소 옆에 만들어져 시험이 잡는다
    const dir = repo('app')
    const before = process.cwd()
    process.chdir(dir)
    try {
      expect(await addWorktree('sub', 'x', root)).toMatchObject({ ok: false })
      expect(existsSync(join(root, 'app-x'))).toBe(false)
    } finally {
      process.chdir(before)
    }
  })

  it('post-checkout 훅이 실패해도 worktree 가 만들어졌으면 성공 (15f 리뷰)', async () => {
    const dir = repo('hooked')
    const hook = join(dir, '.git', 'hooks', 'post-checkout')
    writeFileSync(hook, '#!/bin/sh\necho hook-broke >&2\nexit 1\n')
    chmodSync(hook, 0o755)
    const got = await addWorktree(dir, 'h1', root)
    expect(got).toMatchObject({ ok: true, path: join(root, 'hooked-h1') })
    expect(await branchOf(join(root, 'hooked-h1'))).toBe('h1')
  })

  it('나쁜 브랜치 이름은 git 을 부르지 않고 이유', async () => {
    const dir = repo('app')
    const got = await addWorktree(dir, '-evil', root)
    expect(got).toMatchObject({ ok: false })
    expect(existsSync(join(root, 'app--evil'))).toBe(false)
  })
})
