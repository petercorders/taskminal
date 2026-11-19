import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { delegateTask, delegatedTaskId, delegatePath } from '../../src/main/delegation'
import { WorktreeManagement, makeWorktreeGit, type WorktreeGit } from '../../src/main/worktree-management'
import { AtomicJournal } from '../../src/main/atomic-journal'
import { validWorktreeJournal, type WorktreeJournalState } from '../../src/shared/worktree-management'
import type { CliRequest, UiReply, UiRequest } from '../../src/shared/cli'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5 }) })

function git(root: string, ...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  return execFileSync('git', ['-c', 'commit.gpgSign=false', '-C', root, ...args], {
    encoding: 'utf8', env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' }, stdio: ['pipe', 'pipe', 'pipe'],
  })
}

type TaskNew = Extract<CliRequest, { op: 'task.new' }>

function fixture() {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'tm-delegate-69-')))
  roots.push(temporary)
  const root = join(temporary, 'main'), journalFile = join(temporary, 'journal.json')
  mkdirSync(root)
  git(root, 'init', '.')
  git(root, 'config', 'user.name', 'Delegate test')
  git(root, 'config', 'user.email', 'delegate-test@example.invalid')
  git(root, 'config', 'core.hooksPath', join(temporary, 'hooks'))
  git(root, 'commit', '--allow-empty', '-m', 'initial')
  let writes = 0
  let addFails = false
  const real = makeWorktreeGit()
  const run: WorktreeGit = async (cwd, args) => {
    if (args[0] === 'worktree' && args[1] === 'add') {
      writes++
      if (addFails) return { code: -1, stdout: '', timedOut: true }
    }
    return real(cwd, args)
  }
  const service = new WorktreeManagement({ journal: new AtomicJournal<WorktreeJournalState>(journalFile, validWorktreeJournal), run })
  const asked: UiRequest[] = []
  let cwd = root
  let prepare: (req: Extract<UiRequest, { op: 'delegate.prepare' }>) => UiReply = (req) => ({ ok: true, data: { task: req.taskId, existing: false } })
  const askUi = async (req: UiRequest): Promise<UiReply> => {
    asked.push(req)
    if (req.op === 'delegate.source') return { ok: true, data: { taskId: 'parent', paneId: 'pp', cwd } }
    if (req.op === 'delegate.prepare') return prepare(req)
    return { ok: false, error: '모르는 요청' }
  }
  const call = (over: Partial<TaskNew> = {}) => delegateTask({ op: 'task.new', name: '로그인 고침', worktree: 'feat/login', request: 'r-1', self: 'pp', ...over }, { askUi, worktrees: service, git: run })
  return {
    temporary, root, journalFile, service, asked, call,
    writes: () => writes,
    failAdd: (v: boolean) => (addFails = v),
    from: (dir: string) => (cwd = dir),
    onPrepare: (fn: typeof prepare) => (prepare = fn),
    prepared: () => asked.filter((r): r is Extract<UiRequest, { op: 'delegate.prepare' }> => r.op === 'delegate.prepare'),
  }
}

describe('delegateTask (69)', () => {
  it('부른 pane 의 저장소에 worktree 를 만들고, 요청 번호로 정한 id 의 일감에 부모를 기록한다', async () => {
    const f = fixture()
    const r = await f.call({ template: 'Claude' })
    const path = join(f.temporary, 'main-worktrees', 'feat-login')
    const id = delegatedTaskId('r-1')
    expect(r).toMatchObject({ ok: true, data: { task: id, path, branch: 'feat/login', request: 'r-1', existing: false } })
    expect(f.prepared()).toEqual([{ op: 'delegate.prepare', taskId: id, name: '로그인 고침', cwd: path, parent: { taskId: 'parent', paneId: 'pp' }, template: 'Claude', self: 'pp' }])
    expect(f.asked[0]).toEqual({ op: 'delegate.source', template: 'Claude', self: 'pp' })
    expect(git(path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feat/login')
    expect(git(path, 'rev-parse', 'HEAD').trim()).toBe(git(f.root, 'rev-parse', 'HEAD').trim())
  })

  it('같은 요청 번호를 다시 보내면 worktree 를 새로 만들지 않고 같은 일감 id 로 창에 다시 묻는다', async () => {
    const f = fixture()
    const first = await f.call()
    f.onPrepare((req) => ({ ok: true, data: { task: req.taskId, existing: true } }))
    const again = await f.call()
    expect(f.writes()).toBe(1)
    expect(again).toMatchObject({ ok: true, data: { task: (first as { data: { task: string } }).data.task, existing: true } })
    expect(f.prepared().map((r) => r.taskId)).toEqual([delegatedTaskId('r-1'), delegatedTaskId('r-1')])
    expect(git(f.root, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(2)
  })

  it('저장소가 아닌 일감에서 부르면 종료 2 — git 쓰기 · 생성 기록 · 일감 만들기 없음', async () => {
    const f = fixture()
    const plain = join(f.temporary, 'plain')
    mkdirSync(plain)
    f.from(plain)
    const r = await f.call()
    expect(r).toMatchObject({ ok: false, exit: 2 })
    expect((r as { error: string }).error).toContain('Git 저장소가 아니에요')
    expect(f.writes()).toBe(0)
    expect(existsSync(f.journalFile)).toBe(false)
    expect(f.prepared()).toEqual([])
    f.from(join(f.root, '.git'))
    expect(await f.call()).toMatchObject({ ok: false, exit: 2 })
  })

  it('일감 밖(self 없음)이면 창에 묻기 전에 종료 2, 창이 거절하면(원격 일감 등) 그 답 그대로', async () => {
    const f = fixture()
    expect(await f.call({ self: undefined } as Partial<TaskNew>)).toMatchObject({ ok: false, exit: 2 })
    expect(f.asked).toEqual([])
    const refused: UiReply = { ok: false, error: '원격 일감에서는 worktree 를 만들 수 없어요', exit: 2 }
    const r = await delegateTask({ op: 'task.new', name: 'x', worktree: 'b', request: 'r', self: 'pp' }, {
      askUi: async () => refused,
      worktrees: { create: async () => { throw new Error('부르면 안 됨') }, targets: async () => { throw new Error('부르면 안 됨') } },
      git: async () => { throw new Error('부르면 안 됨') },
    })
    expect(r).toEqual(refused)
  })

  it('만들기 결과를 모르면 일감을 만들지 않고 종료 1 · 같은 요청 번호로 다시 하라고 알린다', async () => {
    const f = fixture()
    f.failAdd(true)
    const r = await f.call()
    expect(r).toMatchObject({ ok: false, exit: 1 })
    expect((r as { error: string }).error).toContain('--request r-1')
    expect(f.prepared()).toEqual([])
  })

  it('worktree 는 만들었는데 창이 일감을 못 만들면 종료 1 — 같은 번호로 다시 하면 worktree 하나로 이어 간다', async () => {
    const f = fixture()
    f.onPrepare(() => ({ ok: false, error: '앱 화면이 답하지 않아요' }))
    const r = await f.call()
    expect(r).toMatchObject({ ok: false, exit: 1 })
    expect((r as { error: string }).error).toMatch(/worktree 는 만들었어요.*--request r-1/)
    f.onPrepare((req) => ({ ok: true, data: { task: req.taskId, existing: false } }))
    expect(await f.call()).toMatchObject({ ok: true, data: { task: delegatedTaskId('r-1') } })
    expect(f.writes()).toBe(1)
  })

  it('다른 worktree 에서 불러도 경로는 기본 worktree 옆, 기준은 부른 worktree 의 HEAD', async () => {
    const f = fixture()
    const side = join(f.temporary, 'side')
    git(f.root, 'worktree', 'add', '-b', 'side', side)
    git(side, 'commit', '--allow-empty', '-m', 'side work')
    f.from(side)
    const r = await f.call({ worktree: 'feat/from-side', request: 'r-2' })
    const path = join(f.temporary, 'main-worktrees', 'feat-from-side')
    expect(r).toMatchObject({ ok: true, data: { path } })
    expect(git(path, 'rev-parse', 'HEAD').trim()).toBe(git(side, 'rev-parse', 'HEAD').trim())
  })

  it('pane 폴더가 ~ 로 저장돼 있어도 펼쳐서 git 에 넘긴다', async () => {
    const seen: string[] = []
    const r = await delegateTask({ op: 'task.new', name: 'x', worktree: 'b', request: 'r', self: 'pp' }, {
      askUi: async (req) => (req.op === 'delegate.source' ? { ok: true, data: { taskId: 't', paneId: 'pp', cwd: '~/tm-delegate-not-a-repo' } } : { ok: false, error: 'x' }),
      worktrees: { create: async () => { throw new Error('부르면 안 됨') }, targets: async () => { throw new Error('부르면 안 됨') } },
      git: async (cwd) => (seen.push(cwd), { code: 128, stdout: '' }),
    })
    expect(r).toMatchObject({ ok: false, exit: 2 })
    expect(seen).toEqual([join(homedir(), 'tm-delegate-not-a-repo')])
  })

  it('id · 경로 규칙: 같은 번호는 같은 uuid 모양 id, 브랜치의 / 와 쓸 수 없는 글자는 -', () => {
    expect(delegatedTaskId('a')).toBe(delegatedTaskId('a'))
    expect(delegatedTaskId('a')).not.toBe(delegatedTaskId('b'))
    expect(delegatedTaskId('a')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(delegatePath('/w/app', 'feat/x')).toBe('/w/app-worktrees/feat-x')
    expect(delegatePath('/w/app', 'fix/한글#1')).toBe('/w/app-worktrees/fix-1')
    expect(delegatePath('/w/app', '.hidden/x')).toBe('/w/app-worktrees/hidden-x')
  })
})
