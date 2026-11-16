import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { githubRepo } from '../../src/shared/git-workflow'
import { localGithubRepo, makeWorkflowRunner } from '../../src/main/git-workflow'

// 56단계: 이슈 연결의 'GitHub 저장소 (owner/repo)' 칸을 일감 폴더의 git remote 로 채운다 — gh · 네트워크 없이 로컬 git 만
describe('githubRepo', () => {
  it('https · scp · ssh 꼴 GitHub 주소에서 owner/repo', () => {
    expect(githubRepo('https://github.com/acme/widgets.git')).toBe('acme/widgets')
    expect(githubRepo('https://github.com/acme/widgets')).toBe('acme/widgets')
    expect(githubRepo('git@github.com:acme/my.repo.git')).toBe('acme/my.repo')
    expect(githubRepo('ssh://git@github.com/acme/widgets.git')).toBe('acme/widgets')
  })
  it('다른 호스트 · 모양이 다른 주소는 null', () => {
    expect(githubRepo('https://gitlab.com/acme/widgets.git')).toBeNull()
    expect(githubRepo('https://github.com.evil.example/acme/widgets')).toBeNull()
    expect(githubRepo('https://github.com/acme')).toBeNull()
    expect(githubRepo('/srv/git/widgets.git')).toBeNull()
  })
})

describe('localGithubRepo', () => {
  let dir: string
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tm-remote-repo-'))
    git('init', '-q')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const read = () => localGithubRepo(makeWorkflowRunner(), dir)

  it('origin 이 있으면 origin', async () => {
    git('remote', 'add', 'upstream', 'https://github.com/other/thing.git')
    git('remote', 'add', 'origin', 'git@github.com:acme/widgets.git')
    expect(await read()).toBe('acme/widgets')
  })
  it('origin 이 없으면 하나뿐인 remote, 여럿이면 고르지 않는다', async () => {
    git('remote', 'add', 'fork', 'https://github.com/me/widgets.git')
    expect(await read()).toBe('me/widgets')
    git('remote', 'add', 'second', 'https://github.com/you/widgets.git')
    expect(await read()).toBeNull()
  })
  it('remote 가 없거나 GitHub 가 아니거나 저장소가 아니면 null', async () => {
    expect(await read()).toBeNull()
    git('remote', 'add', 'origin', 'https://gitlab.com/acme/widgets.git')
    expect(await read()).toBeNull()
    expect(await localGithubRepo(makeWorkflowRunner(), tmpdir())).toBeNull()
  })
})
