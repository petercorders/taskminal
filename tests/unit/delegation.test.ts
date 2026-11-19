import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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
const hash6 = (branch: string) => createHash('sha256').update(branch).digest('hex').slice(0, 6)

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
  // 창의 일감 — 만든 일감은 다음 delegate.source 에 existing 으로 알린다(cli-bridge 와 같게)
  const tasks = new Map<string, string>()
  const made = (req: Extract<UiRequest, { op: 'delegate.prepare' }>): UiReply => (tasks.set(req.taskId, req.cwd), { ok: true, data: { task: req.taskId, existing: false } })
  let prepare: (req: Extract<UiRequest, { op: 'delegate.prepare' }>) => UiReply = made
  const askUi = async (req: UiRequest): Promise<UiReply> => {
    asked.push(req)
    if (req.op === 'delegate.source') {
      const has = tasks.get(req.taskId)
      return { ok: true, data: { taskId: 'parent', paneId: 'pp', cwd, ...(has ? { existing: { cwd: has } } : {}) } }
    }
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
    made,
    prepared: () => asked.filter((r): r is Extract<UiRequest, { op: 'delegate.prepare' }> => r.op === 'delegate.prepare'),
  }
}

describe('delegateTask (69)', () => {
  it('부른 pane 의 저장소에 worktree 를 만들고, 요청 번호로 정한 id 의 일감에 부모를 기록한다', async () => {
    const f = fixture()
    const r = await f.call({ template: 'Claude' })
    const path = join(f.temporary, 'main-worktrees', `feat-login-${hash6('feat/login')}`)
    const id = delegatedTaskId('r-1')
    expect(r).toMatchObject({ ok: true, data: { task: id, path, branch: 'feat/login', request: 'r-1', existing: false } })
    expect(f.prepared()).toEqual([{ op: 'delegate.prepare', taskId: id, name: '로그인 고침', cwd: path, parent: { taskId: 'parent', paneId: 'pp' }, template: 'Claude', self: 'pp' }])
    expect(f.asked[0]).toEqual({ op: 'delegate.source', taskId: id, template: 'Claude', self: 'pp' })
    expect(git(path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feat/login')
    expect(git(path, 'rev-parse', 'HEAD').trim()).toBe(git(f.root, 'rev-parse', 'HEAD').trim())
  })

  it('같은 요청 번호를 다시 보내면 worktree · 일감을 새로 만들지 않고 이미 만든 일감을 알린다', async () => {
    const f = fixture()
    const first = await f.call()
    const again = await f.call()
    expect(f.writes()).toBe(1)
    expect(again).toMatchObject({ ok: true, data: { task: (first as { data: { task: string; path: string } }).data.task, path: (first as { data: { path: string } }).data.path, existing: true } })
    expect(f.prepared().map((r) => r.taskId)).toEqual([delegatedTaskId('r-1')])
    expect(git(f.root, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(2)
  })

  it('만든 worktree 에 커밋한 뒤 같은 요청으로 다시 해도 성공(이미 만듦) — 39 의 결과 모름에 걸리지 않는다 (69 리뷰)', async () => {
    const f = fixture()
    const first = (await f.call()) as { ok: true; data: { path: string } }
    git(first.data.path, 'commit', '--allow-empty', '-m', 'child work')
    expect(await f.call()).toMatchObject({ ok: true, data: { existing: true, path: first.data.path } })
    expect(f.writes()).toBe(1)
  })

  it('저장소는 CLI 를 친 폴더(from)에서 찾는다 — pane 폴더가 저장소가 아니어도, 반대로 친 폴더가 저장소가 아니면 종료 2 (69 리뷰)', async () => {
    const f = fixture()
    const plain = join(f.temporary, 'plain')
    mkdirSync(plain)
    f.from(plain)
    expect(await f.call({ from: f.root })).toMatchObject({ ok: true, data: { existing: false } })
    f.from(f.root)
    const r = await f.call({ from: plain, request: 'r-3', worktree: 'feat/other' })
    expect(r).toMatchObject({ ok: false, exit: 2 })
    expect((r as { error: string }).error).toContain(plain)
    expect(f.writes()).toBe(1)
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
    f.onPrepare(f.made)
    expect(await f.call()).toMatchObject({ ok: true, data: { task: delegatedTaskId('r-1'), existing: false } })
    expect(f.writes()).toBe(1)
  })

  it('다른 worktree 에서 불러도 경로는 기본 worktree 옆, 기준은 부른 worktree 의 HEAD', async () => {
    const f = fixture()
    const side = join(f.temporary, 'side')
    git(f.root, 'worktree', 'add', '-b', 'side', side)
    git(side, 'commit', '--allow-empty', '-m', 'side work')
    f.from(side)
    const r = await f.call({ worktree: 'feat/from-side', request: 'r-2' })
    const path = join(f.temporary, 'main-worktrees', `feat-from-side-${hash6('feat/from-side')}`)
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

  it('id · 경로 규칙: 같은 번호는 같은 uuid 모양 id, 브랜치의 / 와 쓸 수 없는 글자는 - · 소문자, 글자가 바뀌면 브랜치 해시 6자', () => {
    expect(delegatedTaskId('a')).toBe(delegatedTaskId('a'))
    expect(delegatedTaskId('a')).not.toBe(delegatedTaskId('b'))
    expect(delegatedTaskId('a')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(delegatePath('/w/app', 'feat-x')).toBe('/w/app-worktrees/feat-x')
    expect(delegatePath('/w/app', 'feat/x')).toBe(`/w/app-worktrees/feat-x-${hash6('feat/x')}`)
    expect(delegatePath('/w/app', 'fix/한글#1')).toBe(`/w/app-worktrees/fix-1-${hash6('fix/한글#1')}`)
    expect(delegatePath('/w/app', '.hidden/x')).toBe(`/w/app-worktrees/hidden-x-${hash6('.hidden/x')}`)
  })

  it('브랜치가 달라도 같은 폴더가 되던 것(feat/x · feat-x · Feat-X — macOS 는 대소문자를 가리지 않는다)이 서로 다른 경로 (69 리뷰)', () => {
    const paths = ['feat/x', 'feat-x', 'Feat-X', 'feat/X'].map((b) => delegatePath('/w/app', b).toLowerCase())
    expect(new Set(paths).size).toBe(4)
  })
})
