import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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

  it('나쁜 브랜치 이름은 git 을 부르지 않고 이유', async () => {
    const dir = repo('app')
    const got = await addWorktree(dir, '-evil', root)
    expect(got).toMatchObject({ ok: false })
    expect(existsSync(join(root, 'app--evil'))).toBe(false)
  })
})
