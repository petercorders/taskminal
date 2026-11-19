import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyMerge, cleanupPreview, cleanupStep, mergeBadges, runCleanup, shownBadge, usedTaskPaths,
  type CleanupCandidate, type CleanupDeps, type CleanupFlow, type MergeInput,
} from '../../src/shared/worktree-cleanup'
import { validWorktreeJournal, WORKTREE_USED_REASON, type ManagedWorktree, type WorktreeJournalState, type WorktreeView } from '../../src/shared/worktree-management'
import { WorktreeManagement, makeWorktreeGit, type WorktreeGit } from '../../src/main/worktree-management'
import { AtomicJournal } from '../../src/main/atomic-journal'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5 }) })

function git(cwd: string, ...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  return execFileSync('git', ['-c', 'commit.gpgSign=false', '-C', cwd, ...args], {
    encoding: 'utf8', env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' }, stdio: ['pipe', 'pipe', 'pipe'],
  })
}

function repository(trunk = 'main') {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'tm-worktree-67-test-')))
  roots.push(temporary)
  const root = join(temporary, 'main')
  mkdirSync(root)
  git(root, 'init', '-b', trunk, '.')
  git(root, 'config', 'user.name', 'Cleanup test')
  git(root, 'config', 'user.email', 'cleanup-test@example.invalid')
  git(root, 'config', 'core.hooksPath', join(temporary, 'hooks'))
  writeFileSync(join(root, 'tracked.txt'), 'original\n')
  git(root, 'add', '.')
  git(root, 'commit', '-m', 'initial')
  const service = (run?: WorktreeGit) => new WorktreeManagement({
    journal: new AtomicJournal<WorktreeJournalState>(join(temporary, 'journal.json'), validWorktreeJournal), ...(run ? { run } : {}),
  })
  const add = (name: string, base = trunk) => { const path = join(temporary, name); git(root, 'worktree', 'add', '-b', name, path, base); return path }
  const commit = (cwd: string, file: string) => { writeFileSync(join(cwd, file), file + '\n'); git(cwd, 'add', file); git(cwd, 'commit', '-m', file) }
  return { temporary, root, service, add, commit }
}

const row = (view: WorktreeView, path: string) => view.entries.find((entry) => entry.path === path)!
const none = async () => [] as string[]

describe('병합 판정 classifyMerge', () => {
  const base = { ref: 'refs/remotes/origin/main', oid: 'b'.repeat(40) }
  const input = (over: Partial<MergeInput>): MergeInput => ({ head: 'a'.repeat(40), branch: 'refs/heads/feat', primary: false, bare: false, base, created: 'c'.repeat(40), ancestor: true, ...over })
  it('조상이고 만든 뒤 커밋이 있었으면 병합됨, 만든 지점 그대로면 fresh', () => {
    expect(classifyMerge(input({}))?.state).toBe('merged')
    expect(classifyMerge(input({ created: 'a'.repeat(40) }))?.state).toBe('fresh')
  })
  it('기준 없음 · 분리된 HEAD · 비교 실패 · 조상 아님 · 만든 기록 없음은 모름', () => {
    for (const over of [{ base: null }, { branch: null }, { ancestor: null }, { ancestor: false }, { created: null }]) {
      expect(classifyMerge(input(over))?.state).toBe('unknown')
    }
  })
  it('기본 · bare · 기준 브랜치 자신은 표시하지 않는다', () => {
    expect(classifyMerge(input({ primary: true }))).toBeNull()
    expect(classifyMerge(input({ bare: true }))).toBeNull()
    expect(classifyMerge(input({ branch: 'refs/heads/main' }))).toBeNull()
  })
})

describe('병합 판정 — 실제 git', () => {
  it('merge 커밋 · fast-forward 는 병합됨, squash 는 모름', async () => {
    const f = repository()
    const merged = f.add('feat-merge'); f.commit(merged, 'm.txt')
    const ff = f.add('feat-ff'); f.commit(ff, 'f.txt')
    const squash = f.add('feat-squash'); f.commit(squash, 's.txt')
    git(f.root, 'merge', '--ff-only', 'feat-ff')
    git(f.root, 'merge', '--no-ff', '-m', 'merge feat-merge', 'feat-merge')
    git(f.root, 'merge', '--squash', 'feat-squash'); git(f.root, 'commit', '-m', 'squash')
    const view = await f.service().list(f.root)
    expect(row(view, merged).merge).toMatchObject({ state: 'merged', base: 'refs/heads/main' })
    expect(row(view, ff).merge?.state).toBe('merged')
    expect(row(view, ff).merge?.last?.subject).toBe('f.txt')
    expect(row(view, squash).merge?.state).toBe('unknown')
    expect(row(view, f.root).merge).toBeNull()
  })
  it('커밋 없이 새로 만든 worktree 는 기준이 앞서가도 병합됨이 아니다', async () => {
    const f = repository()
    const fresh = f.add('fresh')
    f.commit(f.root, 'later.txt')
    const view = await f.service().list(f.root)
    expect(row(view, fresh).merge?.state).toBe('fresh')
    expect(cleanupPreview(view).candidates).toEqual([])
  })
  it('기준 브랜치가 없으면 모름', async () => {
    const f = repository('trunk')
    const done = f.add('done'); f.commit(done, 'd.txt')
    git(f.root, 'merge', '--ff-only', 'done')
    const view = await f.service().list(f.root)
    expect(row(view, done).merge).toMatchObject({ state: 'unknown', base: null })
  })
  it('origin/HEAD 가 먼저 — fetch 안 한 낡은 원격 기준이면 로컬 main 에 병합돼도 모름', async () => {
    const f = repository()
    const initial = git(f.root, 'rev-parse', 'HEAD').trim()
    // origin/HEAD 가 가리키는 develop 은 대체 목록(origin/main · master · main · master)에 없다 — 로컬 main 보다 먼저 쓰는지 본다
    git(f.root, 'update-ref', 'refs/remotes/origin/develop', initial)
    git(f.root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop')
    const local = f.add('local'); f.commit(local, 'l.txt')
    git(f.root, 'merge', '--ff-only', 'local')
    let view = await f.service().list(f.root)
    expect(row(view, local).merge).toMatchObject({ state: 'unknown', base: 'refs/remotes/origin/develop' })
    git(f.root, 'update-ref', 'refs/remotes/origin/develop', git(f.root, 'rev-parse', 'main').trim())
    view = await f.service().list(f.root)
    expect(row(view, local).merge?.state).toBe('merged')
  })
})

describe('정리 후보 cleanupPreview', () => {
  it('변경 · 미추적 파일이 있는 병합 worktree 와 기본 worktree 는 후보가 아니다', async () => {
    const f = repository()
    const clean = f.add('clean'); f.commit(clean, 'c.txt')
    const dirty = f.add('dirty'); f.commit(dirty, 'd.txt')
    const untracked = f.add('untracked'); f.commit(untracked, 'u.txt')
    for (const name of ['clean', 'dirty', 'untracked']) git(f.root, 'merge', '--no-ff', '-m', name, name)
    writeFileSync(join(dirty, 'c.txt'), 'changed\n'); writeFileSync(join(dirty, 'd.txt'), 'changed\n')
    writeFileSync(join(untracked, 'new.txt'), 'new\n')
    const preview = cleanupPreview(await f.service().list(f.root))
    expect(preview.candidates.map((c) => c.path)).toEqual([clean])
    expect(preview.excluded.map((e) => e.path).sort()).toEqual([dirty, untracked].sort())
    expect(preview.excluded.find((e) => e.path === dirty)?.reason).toContain('변경')
  })

  const entry = (over: Partial<ManagedWorktree>): ManagedWorktree => ({
    path: '/r/w', commonDir: '/r/.git', head: 'a'.repeat(40), branch: 'refs/heads/w', primary: false, bare: false, locked: false, prunable: false,
    unknownAttributes: [], dirty: false, untracked: false, ignored: false, used: false, nested: false, unsafeIndex: false, statusKnown: true,
    canOpen: true, removable: true, reasons: [], cleanable: true, merge: { state: 'merged', base: 'refs/heads/main', reason: '' }, ...over,
  })
  const view = (...entries: ManagedWorktree[]): WorktreeView => ({ root: '/r/main', commonDir: '/r/.git', entries })
  it('연결 일감이 그 폴더의 일감이면 후보(보관할 일감과 함께), pane 만 둔 다른 일감 · 명령 도는 일감 · 이 패널 폴더 · 일감 없이 사용 중이면 제외', () => {
    const own = entry({ path: '/r/own', used: true, removable: false, reasons: [WORKTREE_USED_REASON], tasks: [{ id: 't1', name: 'A', own: true }, { id: 't2', name: 'B', own: true, archived: true }] })
    const pane = entry({ path: '/r/pane', used: true, tasks: [{ id: 't3', name: 'C', own: false }] })
    const busy = entry({ path: '/r/busy', used: true, tasks: [{ id: 't4', name: 'D', own: true }] })
    const current = entry({ path: '/r/current', current: true })
    const shell = entry({ path: '/r/shell', used: true, tasks: [] })
    const p = cleanupPreview(view(own, pane, busy, current, shell), (id) => id === 't4')
    expect(p.candidates.map((c) => c.path)).toEqual(['/r/own'])
    expect(p.candidates[0]!.tasks).toEqual([{ id: 't1', name: 'A', archived: false }, { id: 't2', name: 'B', archived: true }])
    expect(p.excluded.map((e) => e.path)).toEqual(['/r/pane', '/r/busy', '/r/current', '/r/shell'])
  })
  it('모름 · 새 브랜치는 후보도 제외도 아니고 개수만', () => {
    const p = cleanupPreview(view(entry({ merge: { state: 'unknown', base: null, reason: '' } }), entry({ merge: { state: 'fresh', base: 'x', reason: '' } }), entry({ primary: true, merge: null })))
    expect(p).toEqual({ candidates: [], excluded: [], unknown: 1, fresh: 1 })
  })
  it('연결 일감 칩은 일감 폴더가 그 안인 일감만, 브랜치가 바뀌면 숨긴다', () => {
    const badges = mergeBadges(view(entry({ tasks: [{ id: 'own', name: 'A', own: true }, { id: 'pane', name: 'B', own: false }] })))
    expect(Object.keys(badges)).toEqual(['own'])
    expect(shownBadge(badges.own, 'w')?.state).toBe('merged')
    expect(shownBadge(badges.own, 'other')).toBeNull()
  })
})

const candidate = (path: string, tasks: CleanupCandidate['tasks'] = []): CleanupCandidate => ({ path, commonDir: '/r/.git', head: 'a'.repeat(40), branch: 'refs/heads/' + path.slice(3), label: path.slice(3), tasks })

describe('확인 흐름 cleanupStep — 확인 없이 지우지 않는다', () => {
  const play = (actions: Parameters<typeof cleanupStep>[1][]) => {
    let flow: CleanupFlow = { kind: 'idle' }
    const runs: CleanupCandidate[][] = []
    for (const action of actions) { const next = cleanupStep(flow, action); flow = next.flow; if (next.run) runs.push(next.run) }
    return { flow, runs }
  }
  const all = [candidate('/r/a'), candidate('/r/b')]
  it('고르기 · 확인 열기 · 취소 · 닫기 · 확인 열기 전 confirm 은 실행하지 않는다', () => {
    expect(play([{ type: 'open' }, { type: 'toggle', path: '/r/a' }, { type: 'confirm' }]).runs).toEqual([])
    expect(play([{ type: 'open' }, { type: 'toggle', path: '/r/a' }, { type: 'ask', candidates: all }, { type: 'cancel' }, { type: 'confirm' }]).runs).toEqual([])
    expect(play([{ type: 'open' }, { type: 'ask', candidates: all }, { type: 'confirm' }]).runs).toEqual([])
    expect(play([{ type: 'open' }, { type: 'toggle', path: '/r/a' }, { type: 'close' }, { type: 'confirm' }]).runs).toEqual([])
  })
  it('confirm 은 확인을 연 순간의 사본으로 한 번만 — 그 사이 목록 값이 바뀌어도, 두 번 눌러도', () => {
    const live = [candidate('/r/a'), candidate('/r/b', [{ id: 't', name: 'T', archived: false }])]
    let flow: CleanupFlow = { kind: 'idle' }
    for (const action of [{ type: 'open' }, { type: 'toggle', path: '/r/b' }, { type: 'ask', candidates: live }] as const) flow = cleanupStep(flow, action).flow
    live[1]!.head = 'f'.repeat(40)
    live[1]!.tasks.push({ id: 'late', name: 'L', archived: false })
    const first = cleanupStep(flow, { type: 'confirm' })
    const second = cleanupStep(first.flow, { type: 'confirm' })
    expect(second.run).toBeUndefined()
    expect(first.run!.map((c) => [c.path, c.head, c.tasks.map((t) => t.id)])).toEqual([['/r/b', 'a'.repeat(40), ['t']]])
  })
})

describe('실행 순서 runCleanup', () => {
  const merged = (path: string, head: string, tasks: ManagedWorktree['tasks'] = []): ManagedWorktree => ({
    path, commonDir: '/r/.git', head, branch: 'refs/heads/' + path.slice(3), primary: false, bare: false, locked: false, prunable: false, unknownAttributes: [],
    dirty: false, untracked: false, ignored: false, used: !!tasks.length, nested: false, unsafeIndex: false, statusKnown: true, canOpen: true,
    removable: !tasks.length, reasons: tasks.length ? [WORKTREE_USED_REASON] : [], cleanable: true, tasks, merge: { state: 'merged', base: 'refs/heads/main', reason: '' },
  })
  it('다시 읽은 목록에서 HEAD · 연결 일감이 바뀐 줄은 보관도 지우기도 안 하고, 남은 줄의 일감만 보관한 뒤 정리한다', async () => {
    const calls: string[] = []
    const deps: CleanupDeps = {
      list: async () => ({ root: '/r/main', commonDir: '/r/.git', entries: [
        merged('/r/a', 'a'.repeat(40), [{ id: 'ta', name: 'A', own: true }]),
        merged('/r/b', 'f'.repeat(40), [{ id: 'tb', name: 'B', own: true }]),
        merged('/r/c', 'a'.repeat(40), [{ id: 'tc', name: 'C', own: true }, { id: 'new', name: 'N', own: true }]),
      ] }),
      busy: () => false,
      archive: (ids) => { calls.push('archive ' + ids.join(',')); return ids },
      clean: async (_root, items) => { calls.push('clean ' + items.map((i) => i.target.path + ':' + i.taskIds.join(',')).join(' ')); return items.map((i) => ({ state: 'removed' as const, path: i.target.path, message: 'ok' })) },
    }
    const rows = await runCleanup('/r/main', [
      candidate('/r/a', [{ id: 'ta', name: 'A', archived: false }]),
      candidate('/r/b', [{ id: 'tb', name: 'B', archived: false }]),
      candidate('/r/c', [{ id: 'tc', name: 'C', archived: false }]),
    ], deps)
    expect(calls).toEqual(['archive ta', 'clean /r/a:ta'])
    expect(rows.map((r) => [r.path, r.state])).toEqual([['/r/b', 'skipped'], ['/r/c', 'skipped'], ['/r/a', 'removed']])
    expect(rows.find((r) => r.path === '/r/a')?.archived).toEqual(['A'])
  })
  it('정리 응답을 못 받으면 줄마다 모름', async () => {
    const deps: CleanupDeps = {
      list: async () => ({ root: '/r/main', commonDir: '/r/.git', entries: [merged('/r/a', 'a'.repeat(40))] }),
      busy: () => false, archive: (ids) => ids, clean: async () => { throw new Error('lost') },
    }
    expect((await runCleanup('/r/main', [candidate('/r/a')], deps)).map((r) => r.state)).toEqual(['unknown'])
  })
})

describe('사용 경로 usedTaskPaths — 보관한 그 일감만 뺀다', () => {
  it('보관 안 된 일감 · 다른 보관 일감은 그대로 막고 원격 일감은 39 처럼 뺀다', () => {
    const tasks: Parameters<typeof usedTaskPaths>[0] = [
      { id: 'gone', archivedAt: 1, cwd: '/w/a', panes: { p: { cwd: '/w/a/sub' } } },
      { id: 'live', cwd: '/w/b', panes: {} },
      { id: 'old', archivedAt: 1, cwd: '/w/c', panes: {} },
      { id: 'remote', host: 'h', cwd: '/w/d', panes: {} },
    ]
    expect(usedTaskPaths(tasks, ['gone', 'live'])).toEqual(['/w/b', '/w/c'])
  })
})

describe('main clean — 지우기 직전에 다시 찾는다 (실제 git)', () => {
  const mergedFixture = async (names: string[]) => {
    const f = repository()
    const paths = names.map((name) => { const path = f.add(name); f.commit(path, name + '.txt'); return path })
    for (const name of names) git(f.root, 'merge', '--no-ff', '-m', name, name)
    const preview = cleanupPreview(await f.service().list(f.root))
    expect(preview.candidates.map((c) => c.path).sort()).toEqual([...paths].sort())
    const item = (path: string, taskIds: string[] = []) => { const c = preview.candidates.find((x) => x.path === path)!; return { target: { path: c.path, commonDir: c.commonDir, head: c.head, branch: c.branch }, taskIds } }
    return { f, paths, item }
  }
  it('병합된 것만 지우고 브랜치는 남긴다', async () => {
    const { f, paths: [path], item } = await mergedFixture(['done'])
    const [result] = await f.service().clean(f.root, [item(path!)], none)
    expect(result).toMatchObject({ state: 'removed', path })
    expect(existsSync(path!)).toBe(false)
    expect(git(f.root, 'rev-parse', '--verify', 'refs/heads/done').trim()).toMatch(/^[0-9a-f]{40}$/)
  })
  it('확인한 뒤 HEAD 가 바뀌면 안 한다', async () => {
    const { f, paths: [path], item } = await mergedFixture(['moved'])
    const confirmed = item(path!)
    f.commit(path!, 'after.txt')
    const [result] = await f.service().clean(f.root, [confirmed], none)
    expect(result!.state).toBe('unchanged')
    expect(existsSync(path!)).toBe(true)
  })
  it('병합됨이 아닌 대상 · 기본 worktree 는 요청이 와도 지우지 않는다', async () => {
    const f = repository()
    const fresh = f.add('fresh')
    const view = await f.service().list(f.root)
    const snap = (path: string) => { const e = row(view, path); return { target: { path: e.path, commonDir: e.commonDir, head: e.head, branch: e.branch }, taskIds: [] } }
    const results = await f.service().clean(f.root, [snap(fresh), snap(f.root)], none)
    expect(results.map((r) => r.state)).toEqual(['unchanged', 'unchanged'])
    expect(existsSync(fresh)).toBe(true)
  })
  it('사용 경로가 남아 있으면 기다렸다가 끝나면 지우고, 끝까지 쓰이면 남긴다', async () => {
    const { f, paths: [a, b], item } = await mergedFixture(['dying', 'busy'])
    let calls = 0
    const dying = async () => (++calls <= 2 ? [join(a!, 'sub')] : [])
    expect((await f.service().clean(f.root, [item(a!, ['t'])], dying, 1000))[0]!.state).toBe('removed')
    const busy = await f.service().clean(f.root, [item(b!, ['t'])], async () => [b!], 300)
    expect(busy[0]!.state).toBe('unchanged')
    expect(existsSync(b!)).toBe(true)
  })
  it('앞 줄의 결과를 모르면 뒤 줄은 멈춘다', async () => {
    const { f, paths: [a, b], item } = await mergedFixture(['first', 'second'])
    const real = makeWorktreeGit()
    let removed = false
    const run: WorktreeGit = (cwd, args) => {
      if (args[0] === 'worktree' && args[1] === 'remove') { removed = true; return real(cwd, args) }
      if (removed && args[0] === 'worktree' && args[1] === 'list') return Promise.resolve({ code: 1, stdout: '' })
      return real(cwd, args)
    }
    const results = await f.service(run).clean(f.root, [item(a!), item(b!)], none)
    expect(results.map((r) => r.state)).toEqual(['unknown', 'skipped'])
    expect(existsSync(b!)).toBe(true)
  })
})
