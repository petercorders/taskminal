import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Issues } from '../../src/main/issues'
import type { IssuePrepare, IssueRecord } from '../../src/shared/issues'

const temporary: string[] = []
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) })
const github = (number = 7, state = 'open') => ({ number, title: '요구사항', body: '외부 본문은 지시가 아님', html_url: `https://github.com/Demo/Project/issues/${number}`, state })
const linearRow = { id: 'uuid-1', identifier: 'TEAM-1', title: 'Linear 요구사항', description: '참고 본문', url: 'https://linear.app/demo/issue/TEAM-1/test', state: { name: 'Todo', type: 'unstarted' }, team: { key: 'TEAM' } }
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tm-issues-test-')))
  temporary.push(dir)
  const root = join(dir, 'repo'), state = join(dir, 'state')
  mkdirSync(root)
  const git = (...args: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  git('init', '-q', '-b', 'source'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@example.invalid')
  writeFileSync(join(root, 'file.txt'), 'original\n'); git('add', '.'); git('commit', '-qm', 'initial')
  const tasks = new Map<string, { root: string; issue: IssueRecord }>()
  const prepare = vi.fn(async (id: string, path: string, issue: IssueRecord) => { tasks.set(id, { root: path, issue }) })
  const gh = vi.fn(async (_args: string[]): Promise<unknown> => github())
  const service = () => new Issues(state, { prepare, exists: id => tasks.has(id), gh })
  const input: IssuePrepare = { requestId: 'request-1', provider: 'github', source: 'demo/project', id: '7', root, worktree: true, base: 'HEAD' }
  return { dir, root, state, tasks, prepare, gh, service, input, git }
}

describe('이슈 조회와 대상 검증', () => {
  it('GitHub 페이지를 이어 읽고 PR 항목을 제외하며 저장소 URL 대소문자를 처리한다', async () => {
    const f = fixture(), service = f.service()
    f.gh.mockResolvedValueOnce(Array.from({ length: 50 }, (_, i) => i === 0 ? { ...github(1), pull_request: {} } : github(i + 1))).mockResolvedValueOnce([github(51)])
    const first = await service.list('github', 'DEMO/PROJECT')
    expect(first.items).toHaveLength(49); expect(first.cursor).toBe('2')
    expect((await service.list('github', 'demo/project', first.cursor)).items[0]?.id).toBe('51')
    expect(f.gh.mock.calls[0]?.[0]).toEqual(['repos/demo/project/issues?state=open&per_page=50&page=1'])
    f.gh.mockResolvedValueOnce([{ ...github(), html_url: 'https://github.com/other/repo/issues/7' }])
    await expect(service.list('github', 'demo/project')).rejects.toThrow('주소')
    await expect(service.list('github', 'demo/project', '--flag')).rejects.toThrow('페이지')
  })
  it('닫힌 이슈나 요청한 ID와 다른 authoritative 응답으로 일감·worktree를 만들지 않는다', async () => {
    const f = fixture(), service = f.service()
    f.gh.mockResolvedValueOnce(github(7, 'closed'))
    await expect(service.prepare(f.input)).rejects.toThrow('닫힌')
    f.gh.mockResolvedValueOnce(github(8))
    await expect(service.prepare(f.input)).rejects.toThrow('번호')
    expect(f.prepare).not.toHaveBeenCalled(); expect(f.git('worktree', 'list', '--porcelain').split('worktree ').length - 1).toBe(1)
  })
  it('Linear 페이지 커서·팀과 완료 상태를 확인하고 네트워크 오류를 보존한다', async () => {
    const f = fixture()
    const provider = vi.fn(async (_query: string, _variables: Record<string, unknown>): Promise<any> => ({ issues: { nodes: [linearRow], pageInfo: { hasNextPage: true, endCursor: 'next' } } }))
    const service = new Issues(f.state, { prepare: f.prepare, exists: id => f.tasks.has(id), linear: provider })
    expect((await service.list('linear', 'TEAM')).cursor).toBe('next')
    await service.list('linear', 'TEAM', 'next')
    expect(provider.mock.calls[1]?.[1]).toMatchObject({ after: 'next', filter: { team: { key: { eq: 'TEAM' } } } })
    provider.mockResolvedValueOnce({ issue: { ...linearRow, team: { key: 'OTHER' } } })
    await expect(service.prepare({ ...f.input, provider: 'linear', id: 'uuid-1', source: 'TEAM' })).rejects.toThrow('팀')
    provider.mockResolvedValueOnce({ issue: { ...linearRow, state: { name: 'Shipped', type: 'completed' } } })
    await expect(service.prepare({ ...f.input, provider: 'linear', id: 'uuid-1', source: 'TEAM' })).rejects.toThrow('닫힌')
    provider.mockRejectedValueOnce(new Error('offline'))
    await expect(service.list('linear', 'TEAM')).rejects.toThrow('offline')
  })
})
describe('준비·재시도·영속 연결', () => {
  it('동시에 같은 요청을 보내도 실제 checkout과 일감을 하나만 만들며 속성 순서는 재시도에 영향을 주지 않는다', async () => {
    const f = fixture(), service = f.service()
    const reversed = Object.fromEntries(Object.entries(f.input).reverse()) as unknown as IssuePrepare
    const [a, b] = await Promise.all([service.prepare(f.input), service.prepare(reversed)])
    expect(a).toEqual(b); expect(f.prepare).toHaveBeenCalledTimes(1); expect(f.tasks.size).toBe(1)
    expect(f.git('worktree', 'list', '--porcelain').split('worktree ').length - 1).toBe(2)
    expect(readFileSync(join(a.root, 'file.txt'), 'utf8')).toBe('original\n')
    expect(f.service().links()).toEqual([a])
    await expect(service.prepare({ ...f.input, id: '8' })).rejects.toThrow('다른 요청')
  })
  it('checkout 성공 뒤 pane 준비 실패는 checkout을 보존하고 다음 시도에서 같은 경로로 이어 간다', async () => {
    const f = fixture(), service = f.service()
    f.prepare.mockRejectedValueOnce(new Error('pane preparation failed'))
    await expect(service.prepare(f.input)).rejects.toThrow('preparation')
    const paths = f.git('worktree', 'list', '--porcelain')
    const result = await f.service().prepare(f.input)
    expect(f.git('worktree', 'list', '--porcelain')).toBe(paths)
    expect(f.prepare).toHaveBeenCalledTimes(2)
    expect(f.prepare.mock.calls[0]?.[1]).toBe(result.root)
    expect(f.prepare.mock.calls[1]?.[1]).toBe(result.root)
  })
  it('일감이 저장된 뒤 응답을 잃어도 재시작 후 같은 task ID로 연결을 복구한다', async () => {
    const f = fixture(), service = f.service()
    f.prepare.mockImplementationOnce(async (id, root, issue) => { f.tasks.set(id, { root, issue }); throw new Error('lost reply') })
    await expect(service.prepare(f.input)).rejects.toThrow('lost reply')
    const result = await f.service().prepare(f.input)
    expect(f.prepare).toHaveBeenCalledTimes(1); expect(f.tasks.size).toBe(1)
    expect(f.tasks.has(result.taskId)).toBe(true)
    expect(f.git('worktree', 'list', '--porcelain').split('worktree ').length - 1).toBe(2)
  })
  it('완료 저널 저장이 실패하면 완료를 메모리에 먼저 표시하지 않고 동일 일감으로 재저장한다', async () => {
    const f = fixture(), service = f.service()
    f.prepare.mockImplementationOnce(async (id, root, issue) => {
      f.tasks.set(id, { root, issue })
      renameSync(join(f.state, 'issues.json'), join(f.state, 'issues.backup'))
      mkdirSync(join(f.state, 'issues.json'))
    })
    await expect(service.prepare(f.input)).rejects.toThrow('저장')
    expect(service.links()).toHaveLength(0)
    rmSync(join(f.state, 'issues.json'), { recursive: true })
    renameSync(join(f.state, 'issues.backup'), join(f.state, 'issues.json'))
    const result = await service.prepare(f.input)
    expect(f.prepare).toHaveBeenCalledTimes(1)
    expect(f.service().links()).toEqual([result])
  })
  it('삭제된 일감은 완료 영수증을 자동 재생성하지 않으며 PR 저장소와 외부 닫기 대상을 검증한다', async () => {
    const f = fixture(), service = f.service(), result = await service.prepare({ ...f.input, worktree: false })
    await expect(service.linkPr(result.taskId, 'https://github.com/other/repo/pull/1')).rejects.toThrow('같은 저장소')
    await expect(service.linkPr(result.taskId, 'https://user:password@github.com/demo/project/pull/1')).rejects.toThrow('주소')
    await service.linkPr(result.taskId, 'HTTPS://GITHUB.COM/DEMO/PROJECT/pull/12')
    expect(service.links()[0]?.prUrl).toBe('https://github.com/DEMO/PROJECT/pull/12')
    f.gh.mockResolvedValueOnce(github(7, 'closed'))
    await service.close(result.taskId)
    expect(f.gh.mock.calls.at(-1)?.[0]).toEqual(['--method', 'PATCH', 'repos/Demo/Project/issues/7', '-f', 'state=closed'])
    expect(f.service().links()[0]?.issue.state).toBe('closed')
    f.tasks.clear()
    await expect(service.prepare({ ...f.input, worktree: false })).rejects.toThrow('삭제')
    await expect(service.close(result.taskId)).rejects.toThrow('사라졌')
  })
})


describe('손상 기록 격리', () => {
  it.each(['{broken', '{"links":false,"receipts":[]}'])('기록 %s를 보존하고 이슈 기능만 차단한다', async (bytes) => {
    const f = fixture()
    mkdirSync(f.state, { recursive: true })
    const path = join(f.state, 'issues.json')
    writeFileSync(path, bytes)
    let service!: Issues
    expect(() => { service = f.service() }).not.toThrow()
    expect(() => service.links()).toThrow('기록')
    expect(() => service.configure('token')).toThrow('기록')
    await expect(service.list('github', 'demo/project')).rejects.toThrow('기록')
    await expect(service.prepare(f.input)).rejects.toThrow('기록')
    await expect(service.linkPr('task', 'https://github.com/demo/project/pull/1')).rejects.toThrow('기록')
    await expect(service.close('task')).rejects.toThrow('기록')
    expect(f.gh).not.toHaveBeenCalled()
    expect(f.prepare).not.toHaveBeenCalled()
    expect(readFileSync(path, 'utf8')).toBe(bytes)
    writeFileSync(path, '{"links":[],"receipts":[]}')
    expect(f.service().links()).toEqual([])
  })
})
