import { describe, expect, it } from 'vitest'
import { GitWorkflowService, type WorkflowOutput, type WorkflowRunner } from '../../src/main/git-workflow'
import type { PrFeedback } from '../../src/shared/ci-feedback'
import type { GitTarget } from '../../src/shared/git-workflow'
import { redact } from '../../src/shared/redact'

// 54단계: PR 피드백 읽기 — 가짜 runner 로 gh 인자 · 부분 실패 · 한도 · 같은 요청 하나를 본다
const HEAD = 'a'.repeat(40)
const target: GitTarget = { root: '/tmp', branch: 'feature', head: HEAD, remote: 'origin', base: 'main', repo: 'o/r', remoteUrl: 'git@github.com:o/r.git' }
const out = (v: unknown, code = 0): WorkflowOutput => ({ code, stdout: typeof v === 'string' ? v : JSON.stringify(v), timedOut: false, missing: false })
const TOKEN = 'ghp_' + 'a'.repeat(36)
const actions = (name: string, run: number, job: number) => ({ __typename: 'CheckRun', name, workflowName: 'CI', conclusion: 'FAILURE', detailsUrl: `https://github.com/o/r/actions/runs/${run}/job/${job}` })
const prView = {
  number: 7,
  headRefOid: HEAD,
  statusCheckRollup: [
    actions('build', 111, 222),
    { __typename: 'CheckRun', name: 'lint', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/o/r/actions/runs/1/job/1' },
    { __typename: 'StatusContext', context: 'ci/circle', state: 'ERROR', targetUrl: 'https://circleci.com/x' },
    actions('e2e', 3, 4),
    actions('unit', 5, 6),
    actions('extra', 7, 8),
  ],
  reviews: [{ id: 'R1', author: { login: 'alice' }, state: 'CHANGES_REQUESTED', body: '고쳐 주세요', submittedAt: '2026-11-13T10:00:00Z' }],
  comments: [],
}
const lineRows = [{ id: 9, user: { login: 'dave' }, path: 'src/a.ts', line: 12, body: `토큰 ${TOKEN} 이 보여요`, created_at: '2026-11-13T13:00:00Z', html_url: 'https://github.com/o/r/pull/7#discussion_r9' }]

function fake(over: Partial<Record<'view' | 'api' | 'run', (args: readonly string[]) => Promise<WorkflowOutput>>> = {}) {
  const calls: string[][] = []
  const run: WorkflowRunner = async (tool, args) => {
    calls.push([tool, ...args])
    if (tool !== 'gh') throw new Error('git 은 부르지 않는다')
    if (args[0] === 'pr' && args[1] === 'view') return over.view ? over.view(args) : out(prView)
    if (args[0] === 'api') return over.api ? over.api(args) : out(lineRows)
    if (args[0] === 'run') return over.run ? over.run(args) : out(`build\tRun tests\t2026-11-13T16:01:26Z FAIL run ${args[2]}\nbuild\tRun tests\t2026-11-13T16:01:27Z GH_TOKEN=${TOKEN}\n`)
    throw new Error(`모르는 gh ${args.join(' ')}`)
  }
  return { calls, run }
}
const mask = (s: string) => redact(s)
const never = () => new Promise<WorkflowOutput>(() => {})
const prViews = (calls: string[][]) => calls.filter((c) => c[1] === 'pr' && c[2] === 'view')

describe('GitWorkflowService.feedback', () => {
  it('실패 체크의 로그 끝 · 리뷰 의견을 모으고, gh 는 인자 배열과 링크의 숫자로만 부른다', async () => {
    const f = fake()
    const r = (await new GitWorkflowService(f.run).feedback('/tmp', { target, number: 7, head: HEAD }, mask)) as PrFeedback
    expect(r.state).toBe('ok')
    expect(f.calls).toContainEqual(['gh', 'pr', 'view', '7', '--repo', 'o/r', '--json', 'number,headRefOid,statusCheckRollup,reviews,comments'])
    expect(f.calls).toContainEqual(['gh', 'api', 'repos/o/r/pulls/7/comments?per_page=100&sort=created&direction=desc'])
    expect(f.calls).toContainEqual(['gh', 'run', 'view', '111', '--repo', 'o/r', '--job', '222', '--log-failed'])
    expect(r.checks.map((c) => [c.name, c.logState])).toEqual([
      ['build', 'ok'],
      ['ci/circle', 'not-actions'],
      ['e2e', 'ok'],
      ['unit', 'ok'],
      ['extra', 'skipped'],
    ])
    // 로그는 처음 3개 Actions 체크만 내려받는다
    expect(f.calls.filter((c) => c[1] === 'run')).toHaveLength(3)
    expect(r.checks[0]!.log).toContain('FAIL run 111')
    expect(JSON.stringify(r)).not.toContain(TOKEN)
    expect(r.checks[0]!.log).toContain('‹가림')
    expect(r.notes.map((n) => n.id)).toEqual(['line:9', 'review:R1'])
    expect(r.notes[0]!.body).toContain('‹가림')
    expect(r.lineComments).toBe('ok')
  })

  it('로그 · 줄 의견을 못 읽어도 나머지는 보인다', async () => {
    const f = fake({ run: async () => out('', 1), api: async () => out('', 1) })
    const r = (await new GitWorkflowService(f.run).feedback('/tmp', { target, number: 7, head: HEAD })) as PrFeedback
    expect(r.state).toBe('ok')
    expect(r.checks[0]!.logState).toBe('error')
    expect(r.lineComments).toBe('error')
    expect(r.notes.map((n) => n.id)).toEqual(['review:R1'])
  })

  it('잘못된 요청은 gh 를 부르지 않는다', async () => {
    const f = fake()
    const svc = new GitWorkflowService(f.run)
    for (const req of [
      { target, number: 0, head: HEAD },
      { target, number: '7' as unknown as number, head: HEAD },
      { target: { ...target, repo: null }, number: 7, head: HEAD },
      { target, number: 7, head: 'main' },
      { target: { ...target, branch: '--evil' }, number: 7, head: HEAD },
    ]) expect((await svc.feedback('/tmp', req)).state).toBe('error')
    expect(await svc.feedback('relative', { target, number: 7, head: HEAD })).toMatchObject({ state: 'error' })
    expect(f.calls).toEqual([])
  })

  it('gh 가 없거나 PR 을 못 읽으면 오류 글, 다른 PR 번호가 오면 받지 않는다', async () => {
    const missing = fake({ view: async () => ({ code: -1, stdout: '', timedOut: false, missing: true }) })
    expect(await new GitWorkflowService(missing.run).feedback('/tmp', { target, number: 7, head: HEAD })).toMatchObject({ state: 'error', message: expect.stringContaining('gh') })
    const failed = fake({ view: async () => out('', 1) })
    expect((await new GitWorkflowService(failed.run).feedback('/tmp', { target, number: 7, head: HEAD })).state).toBe('error')
    const other = fake({ view: async () => out({ ...prView, number: 8 }) })
    expect((await new GitWorkflowService(other.run).feedback('/tmp', { target, number: 7, head: HEAD })).state).toBe('error')
  })

  it('한도 안에 답이 없으면 timeout, 아직 도는 읽기에 다시 누르면 gh 를 또 부르지 않는다', async () => {
    const f = fake({ view: never })
    const svc = new GitWorkflowService(f.run, undefined, 60)
    const req = { target, number: 7, head: HEAD }
    expect(await svc.feedback('/tmp', req)).toMatchObject({ state: 'timeout', message: expect.stringContaining('응답이 없어요') })
    expect(await svc.feedback('/tmp', req)).toMatchObject({ state: 'timeout' })
    expect(prViews(f.calls)).toHaveLength(1)
  })

  it('같은 PR · 같은 머리의 동시 읽기는 하나, 머리가 다르면 따로', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const f = fake({ view: async () => (await gate, out(prView)) })
    const svc = new GitWorkflowService(f.run)
    const req = { target, number: 7, head: HEAD }
    const a = svc.feedback('/tmp', req)
    const b = svc.feedback('/tmp', req)
    const c = svc.feedback('/tmp', { ...req, head: 'b'.repeat(40) })
    release()
    expect((await a).state).toBe('ok')
    expect(await b).toEqual(await a)
    expect((await c).state).toBe('ok')
    expect(prViews(f.calls)).toHaveLength(2)
    // 끝난 뒤 다시 읽기는 새로 부른다
    await svc.feedback('/tmp', req)
    expect(prViews(f.calls)).toHaveLength(3)
  })

  it('로그가 늦으면 로그만 timeout 으로 두고 체크 · 리뷰는 한도 안에 돌려준다', async () => {
    const f = fake({ run: never })
    const r = (await new GitWorkflowService(f.run, undefined, 300).feedback('/tmp', { target, number: 7, head: HEAD })) as PrFeedback
    expect(r.state).toBe('ok')
    expect(r.checks[0]!.logState).toBe('timeout')
    expect(r.notes).toHaveLength(2)
  })
})
