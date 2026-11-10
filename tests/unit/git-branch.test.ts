import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { branchesOf, branchOf } from '../../src/main/git-branch'

// 15c: 실제 git 저장소(임시 폴더)로 본다 — 만들 때만 git 을 쓰고, branchOf 는 파일만 읽는다.
let root: string
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).toString()

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-git-')))
})
const locked: string[] = []
afterEach(() => {
  for (const d of locked) chmodSync(d, 0o755)
  locked.length = 0
  rmSync(root, { recursive: true, force: true })
})

function repo(name: string, ...initArgs: string[]): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main', ...initArgs)
  writeFileSync(join(dir, 'a.txt'), 'a')
  git(dir, 'add', 'a.txt')
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'first')
  return dir
}

describe('branchOf (15c)', () => {
  it('저장소 폴더 · 하위 폴더는 지금 브랜치, 바꾸면 따라간다', async () => {
    const dir = repo('r')
    mkdirSync(join(dir, 'src', 'deep'), { recursive: true })
    expect(await branchOf(dir)).toBe('main')
    expect(await branchOf(join(dir, 'src', 'deep'))).toBe('main')
    git(dir, 'switch', '-q', '-c', 'feat/x')
    expect(await branchOf(dir)).toBe('feat/x')
  })

  it('git worktree 폴더는 그 worktree 의 브랜치 (.git 파일의 gitdir 를 따라간다)', async () => {
    const dir = repo('main-repo')
    const wt = join(root, 'wt')
    git(dir, 'worktree', 'add', '-q', '-b', 'stage/15', wt)
    expect(await branchOf(wt)).toBe('stage/15')
    expect(await branchOf(dir)).toBe('main')
  })

  it('브랜치가 아닌 HEAD 는 커밋 앞 7자리', async () => {
    const dir = repo('d')
    const sha = git(dir, 'rev-parse', 'HEAD').trim()
    git(dir, 'checkout', '-q', '--detach')
    expect(await branchOf(dir)).toBe(sha.slice(0, 7))
  })

  it('한글 폴더 이름도', async () => {
    const dir = repo('한글 저장소')
    expect(await branchOf(dir)).toBe('main')
  })

  it('저장소가 아니거나 없는 폴더는 null', async () => {
    const plain = join(root, 'plain')
    mkdirSync(plain)
    expect(await branchOf(plain)).toBeNull()
    expect(await branchOf(join(root, 'nope'))).toBeNull()
  })

  it('reftable 저장소는 HEAD 가 자리 표시(.invalid)라 브랜치를 모른다 → null(폴더를 보인다) (15c 리뷰)', async () => {
    const dir = repo('rt', '--ref-format=reftable')
    expect(await branchOf(dir)).toBeNull()
  })

  it('.git 을 볼 수 없는 폴더(권한)는 위쪽 저장소의 브랜치로 잘못 보이지 않는다 (15c 리뷰)', async () => {
    const outer = repo('outer')
    const inner = join(outer, 'inner')
    mkdirSync(join(inner, 'sub'), { recursive: true })
    // inner 에 x 권한이 없으면 inner/sub/.git · inner/.git 의 stat 이 EACCES — '없음' 으로 보고 outer 까지 올라가면 안 된다
    chmodSync(inner, 0o600)
    locked.push(inner)
    expect(await branchOf(join(inner, 'sub'))).toBeNull()
  })

  it('.git 파일이 깨졌으면 null (던지지 않는다)', async () => {
    const broken = join(root, 'broken')
    mkdirSync(broken)
    writeFileSync(join(broken, '.git'), 'gitdir: /no/such/place')
    expect(await branchOf(broken)).toBeNull()
  })
})

describe('branchesOf', () => {
  it('폴더마다 결과, ~ 는 home 으로 푼다', async () => {
    const dir = repo('r2')
    const plain = join(root, 'p')
    mkdirSync(plain)
    expect(await branchesOf([dir, plain], root)).toEqual({ [dir]: 'main', [plain]: null })
    expect(await branchesOf(['~/r2'], root)).toEqual({ '~/r2': 'main' })
  })
})
