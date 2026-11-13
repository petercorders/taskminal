import { afterEach, beforeEach, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitWorkflowService, makeWorkflowRunner, type WorkflowRunner } from '../../src/main/git-workflow'

let base: string
let repo: string
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'taskminal-gitflow-'))
  repo = join(base, 'work'); mkdirSync(repo)
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid')
  writeFileSync(join(repo, 'one'), 'one'); git('add', '.'); git('commit', '-qm', 'one')
})
afterEach(() => rmSync(base, { recursive: true, force: true }))
const noGh: WorkflowRunner = async (tool, args, cwd, input) => tool === 'gh'
  ? { code: -1, stdout: '', timedOut: false, missing: true }
  : makeWorkflowRunner()(tool, args, cwd, input)

it('원격 없음·여러 원격·detached HEAD를 구별하며 원격을 자동 선택하지 않는다', async () => {
  const svc = new GitWorkflowService(noGh)
  expect((await svc.view(repo)).remotes).toEqual([])
  git('remote', 'add', 'a', join(base, 'a')); git('remote', 'add', 'b', join(base, 'b'))
  expect((await svc.view(repo)).target).toBeNull()
  git('checkout', '--detach')
  expect((await svc.view(repo, { remote: 'a' })).branch).toBeNull()
})

it('임시 bare 원격으로 일반 push하고 같은 SHA 재시도는 중복 전송하지 않는다', async () => {
  const remote = join(base, 'remote.git')
  execFileSync('git', ['init', '--bare', remote], { stdio: 'pipe' })
  git('remote', 'add', 'origin', remote)
  const svc = new GitWorkflowService(noGh)
  const view = await svc.view(repo)
  expect(view.gh).toBe('not-github')
  expect(view.target).not.toBeNull()
  const target = view.target!
  expect((await svc.push(repo, target)).state).toBe('ok')
  expect(git('ls-remote', '--heads', 'origin', 'main').split(/\s/)[0]).toBe(target.head)
  expect((await svc.push(repo, target)).state).toBe('ok')
})

it('확인 뒤 로컬 HEAD가 바뀌면 push를 거부한다', async () => {
  git('remote', 'add', 'origin', join(base, 'remote.git'))
  const svc = new GitWorkflowService(noGh)
  const target = (await svc.view(repo)).target!
  writeFileSync(join(repo, 'two'), 'two'); git('add', '.'); git('commit', '-qm', 'two')
  expect((await svc.push(repo, target)).state).toBe('changed')
})

function githubRunner(opts: { createUnknown?: boolean; failedCheck?: boolean; changedHead?: boolean } = {}) {
  let created = false
  let creates = 0
  let merges = 0
  const run: WorkflowRunner = async (tool, args, cwd, input) => {
    if (tool === 'git' && args[0] === 'ls-remote') return { code: 0, stdout: `${git('rev-parse', 'HEAD')}\trefs/heads/feature`, timedOut: false, missing: false }
    if (tool === 'git') return noGh(tool, args, cwd, input)
    const result = (obj: unknown) => ({ code: 0, stdout: JSON.stringify(obj), timedOut: false, missing: false })
    if (args[0] === 'auth') return result({})
    if (args[0] === 'repo') return result({ defaultBranchRef: { name: 'main' } })
    const pr = { number: 7, title: 'Feature', url: 'https://github.com/test/repo/pull/7', state: 'OPEN', isDraft: false, isCrossRepository: false, headRefName: 'feature', headRefOid: opts.changedHead ? 'f'.repeat(40) : git('rev-parse', 'HEAD'), baseRefName: 'main', reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ conclusion: opts.failedCheck ? 'FAILURE' : 'SUCCESS', status: 'COMPLETED' }] }
    if (args[1] === 'list') return result(created ? [pr] : [])
    if (args[1] === 'view') return result(pr)
    if (args[1] === 'create') { creates++; created = true; return { code: opts.createUnknown ? -1 : 0, stdout: '', timedOut: !!opts.createUnknown, missing: false } }
    if (args[1] === 'merge') { merges++; return result({}) }
    throw new Error(`unexpected ${args.join(' ')}`)
  }
  return { run, counts: () => ({ creates, merges }) }
}

it('PR 생성 응답 유실 뒤 기존 PR로 조정하고 재시도해도 한 번만 생성한다', async () => {
  git('remote', 'add', 'origin', 'https://github.com/test/repo.git'); git('checkout', '-b', 'feature')
  const fake = githubRunner({ createUnknown: true }); const svc = new GitWorkflowService(fake.run)
  const target = (await svc.view(repo)).target!
  const req = { target, title: 'Feature', body: 'Body' }
  expect((await svc.create(repo, req)).url).toContain('/pull/7')
  expect((await svc.create(repo, req)).url).toContain('/pull/7')
  expect(fake.counts().creates).toBe(1)
})

it.each([{ failedCheck: true }, { changedHead: true }])('실패 체크 또는 바뀐 PR HEAD는 병합 실행을 차단한다: %j', async (options) => {
  git('remote', 'add', 'origin', 'https://github.com/test/repo.git'); git('checkout', '-b', 'feature')
  const fake = githubRunner(options); const svc = new GitWorkflowService(fake.run)
  const target = (await svc.view(repo)).target!
  const r = await svc.merge(repo, { target, number: 7, head: target.head })
  expect(['blocked', 'changed']).toContain(r.state)
  expect(fake.counts().merges).toBe(0)
})

it('PR 생성 결과가 아직 조회되지 않으면 같은 요청을 다시 전송하지 않는다', async () => {
  git('remote', 'add', 'origin', 'https://github.com/test/repo.git'); git('checkout', '-b', 'feature')
  const original = githubRunner()
  let creates = 0
  const run: WorkflowRunner = async (tool, args, cwd, input) => {
    if (tool === 'gh' && args[1] === 'list') return { code: 0, stdout: '[]', timedOut: false, missing: false }
    if (tool === 'gh' && args[1] === 'create') { creates++; return { code: -1, stdout: '', timedOut: true, missing: false } }
    return original.run(tool, args, cwd, input)
  }
  const svc = new GitWorkflowService(run); const target = (await svc.view(repo)).target!
  const req = { target, title: 'title', body: 'body' }
  expect((await svc.create(repo, req)).state).toBe('unknown')
  expect((await svc.create(repo, req)).state).toBe('unknown')
  expect(creates).toBe(1)
})

it('main 잠금은 같은 프레임의 push 중복 실행을 막는다', async () => {
  const remote = join(base, 'remote.git')
  execFileSync('git', ['init', '--bare', remote], { stdio: 'pipe' }); git('remote', 'add', 'origin', remote)
  const svc = new GitWorkflowService(noGh); const target = (await svc.view(repo)).target!
  const [a, b] = await Promise.all([svc.push(repo, target), svc.push(repo, target)])
  expect([a.state, b.state].sort()).toEqual(['busy', 'ok'])
})

it('PR 결과 모름 기록은 앱 서비스 재시작 후에도 재전송을 막는다', async () => {
  git('remote', 'add', 'origin', 'https://github.com/test/repo.git'); git('checkout', '-b', 'feature')
  const original = githubRunner(); let creates = 0
  const run: WorkflowRunner = async (tool, args, cwd, input) => {
    if (tool === 'gh' && args[1] === 'list') return { code: 0, stdout: '[]', timedOut: false, missing: false }
    if (tool === 'gh' && args[1] === 'create') { creates++; return { code: -1, stdout: '', timedOut: true, missing: false } }
    return original.run(tool, args, cwd, input)
  }
  const pending = join(base, 'pending.json')
  const first = new GitWorkflowService(run, pending); const target = (await first.view(repo)).target!
  const request = { target, title: 't', body: 'b' }
  expect((await first.create(repo, request)).state).toBe('unknown')
  const restarted = new GitWorkflowService(run, pending)
  expect((await restarted.create(repo, request)).state).toBe('unknown')
  expect(creates).toBe(1)
})

it('GitHub CLI 없음과 로그인 거절을 별도 상태로 표시한다', async () => {
  git('remote', 'add', 'origin', 'https://github.com/test/repo.git')
  expect((await new GitWorkflowService(noGh).view(repo)).gh).toBe('missing')
  const denied: WorkflowRunner = async (tool, args, cwd, input) => tool === 'gh' ? { code: 1, stdout: '', timedOut: false, missing: false } : noGh(tool, args, cwd, input)
  expect((await new GitWorkflowService(denied).view(repo)).gh).toBe('login')
})
