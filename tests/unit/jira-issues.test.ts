import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Issues } from '../../src/main/issues'
import { ISSUE_TASK_DELETED, type IssuePrepare, type IssueRecord } from '../../src/shared/issues'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const record = (id = '10007', extra: Partial<IssueRecord> = {}): IssueRecord => ({ provider: 'jira', id, key: 'PROJ-7', title: 'Jira 요구사항', body: '담당: 나', url: 'https://acme.atlassian.net/browse/PROJ-7', state: 'To Do', due: '2026-11-10', ...extra })
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tm-jira-issues-')))
  dirs.push(dir)
  const root = join(dir, 'repo'); mkdirSync(root)
  const tasks = new Map<string, string>([['existing', root]])
  const prepare = vi.fn(async (id: string, path: string) => { await new Promise((r) => setTimeout(r, 20)); tasks.set(id, path) })
  const jira = { list: vi.fn(async () => ({ items: [record()] })), issue: vi.fn(async (id: string) => record(id)) }
  const service = () => new Issues(join(dir, 'state'), { prepare, exists: (id) => tasks.has(id), cwd: (id) => tasks.get(id), jira })
  const input: IssuePrepare = { requestId: 'req-1', provider: 'jira', id: '10007', source: '', root, worktree: false, base: 'HEAD' }
  return { root, tasks, prepare, jira, service, input }
}

describe('Jira 공급자를 이슈 연결에 잇기', () => {
  it('목록은 Jira 서비스로 넘기고 커서는 받지 않는다', async () => {
    const f = fixture()
    const s = f.service()
    expect((await s.list('jira', 'project = PROJ')).items[0]!.key).toBe('PROJ-7')
    expect(f.jira.list).toHaveBeenCalledWith('project = PROJ')
    await expect(s.list('jira', 'x', 'next')).rejects.toThrow()
  })
  it('같은 프레임에서 두 번 준비해도 일감은 하나 · 재시작 뒤 마감과 연결이 남는다', async () => {
    const f = fixture()
    const s = f.service()
    const [a, b] = await Promise.all([s.prepare(f.input), s.prepare({ ...f.input })])
    expect(a.taskId).toBe(b.taskId)
    expect(f.prepare).toHaveBeenCalledTimes(1)
    expect(f.jira.issue).toHaveBeenCalledWith('10007')
    const again = f.service().links()
    expect(again).toHaveLength(1)
    expect(again[0]!.issue).toMatchObject({ provider: 'jira', key: 'PROJ-7', due: '2026-11-10' })
  })
  it('기존 일감에 연결 — 두 번 눌러도 연결 하나, 대상 일감이 사라졌으면 막고 안내한다', async () => {
    const f = fixture()
    const s = f.service()
    const attach = { requestId: 'att-1', provider: 'jira' as const, id: '10007', source: '', taskId: 'existing' }
    const [a, b] = await Promise.all([s.attach(attach), s.attach({ ...attach })])
    expect(a).toEqual(b)
    expect(a.root).toBe(f.root)
    expect(s.links()).toHaveLength(1)
    expect(f.jira.issue).toHaveBeenCalledTimes(1)
    f.tasks.delete('existing')
    await expect(s.attach({ ...attach, requestId: 'att-2', taskId: 'existing' })).rejects.toThrow(ISSUE_TASK_DELETED)
    // 이슈를 다시 읽는 사이 일감이 사라져도 연결을 만들지 않는다
    f.tasks.set('other', f.root)
    f.jira.issue.mockImplementationOnce(async (id: string) => { f.tasks.delete('other'); return record(id) })
    await expect(s.attach({ ...attach, id: '10008', requestId: 'att-3', taskId: 'other' })).rejects.toThrow(ISSUE_TASK_DELETED)
    expect(s.links().map((l) => l.taskId)).toEqual(['existing'])
  })
  it('Jira 는 읽기만 — 외부 닫기를 거절하고 요청을 보내지 않는다', async () => {
    const f = fixture()
    const s = f.service()
    await s.attach({ requestId: 'att-1', provider: 'jira', id: '10007', source: '', taskId: 'existing' })
    await expect(s.close('existing')).rejects.toThrow(/Jira 에서/)
    expect(f.jira.issue).toHaveBeenCalledTimes(1)
  })
})
