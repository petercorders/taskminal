import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyImport, assignSessions, dropSessionHints, importGroup, importPlan, importRows, importTasks, pickedByDefault, repoName, runImport,
  type ImportPreview, type ImportRow, type SessionLike,
} from '../../src/shared/repo-import'
import { createTask, emptyState, normalizeState, parseSessionHints } from '../../src/shared/model'
import { worktreeUseKey } from '../../src/shared/worktree-cleanup'
import { validWorktreeJournal, type ManagedWorktree, type WorktreeJournalState, type WorktreeView } from '../../src/shared/worktree-management'
import type { AgentSessionList } from '../../src/shared/agent-sessions'
import type { AppState, Task } from '../../src/shared/types'
import { WorktreeManagement } from '../../src/main/worktree-management'
import { AtomicJournal } from '../../src/main/atomic-journal'
import { AgentSessions } from '../../src/main/agent-sessions'
import { buildImportPreview, ImportRoots, taskFolders } from '../../src/main/repo-import'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5 }) })
const temp = (prefix: string) => { const d = realpathSync(mkdtempSync(join(tmpdir(), prefix))); roots.push(d); return d }

function git(cwd: string, ...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  return execFileSync('git', ['-c', 'commit.gpgSign=false', '-C', cwd, ...args], {
    encoding: 'utf8', env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' }, stdio: ['pipe', 'pipe', 'pipe'],
  })
}

function repository() {
  const temporary = temp('tm-import-70-test-')
  const root = join(temporary, 'shop')
  mkdirSync(root)
  git(root, 'init', '-b', 'main', '.')
  git(root, 'config', 'user.name', 'Import test')
  git(root, 'config', 'user.email', 'import-test@example.invalid')
  git(root, 'config', 'core.hooksPath', join(temporary, 'hooks'))
  writeFileSync(join(root, 'a.txt'), 'a\n')
  git(root, 'add', '.')
  git(root, 'commit', '-m', 'initial')
  const service = new WorktreeManagement({ journal: new AtomicJournal<WorktreeJournalState>(join(temporary, 'journal.json'), validWorktreeJournal) })
  const add = (name: string, ...extra: string[]) => { const path = join(temporary, name); git(root, 'worktree', 'add', ...extra, ...(extra.includes('--detach') ? [] : ['-b', name]), path, 'main'); return path }
  return { temporary, root, service, add }
}

const emptyList = (sessions: AgentSessionList['sessions'] = []): AgentSessionList => ({ sessions, skipped: 0, badLines: 0, subagents: 0, home: '/h', at: 0 })
const uuid = (n: number) => `${n.toString(16).padStart(8, '0')}-2222-4333-8444-555555555555`

let n = 0
const newId = () => `id${++n}`
const task = (s: AppState, name: string, cwd: string, extra: Partial<Task> = {}): Task =>
  ({ ...createTask({ name, cwd, templateId: null, statusId: s.settings.statuses[0]!.id, groupId: null, color: null }, s.settings, newId, 0), ...extra })

const entry = (over: Partial<ManagedWorktree>): ManagedWorktree => ({
  path: '/r/x', commonDir: '/r/main/.git', head: 'a'.repeat(40), branch: 'refs/heads/x', primary: false, bare: false, locked: false, prunable: false,
  unknownAttributes: [], dirty: false, untracked: false, ignored: false, used: false, nested: false, unsafeIndex: false,
  statusKnown: true, canOpen: true, removable: false, reasons: [], ...over,
})
const row = (over: Partial<ImportRow>): ImportRow => ({
  path: '/r/x', commonDir: '/r/main/.git', head: 'a'.repeat(40), branch: 'refs/heads/x', label: 'x', name: 'x', primary: false, locked: false,
  merge: null, existing: null, nearby: null, blocked: null, sessions: [], ...over,
})
const preview = (rows: ImportRow[], over: Partial<ImportPreview> = {}): ImportPreview => ({ root: '/r/main', commonDir: '/r/main/.git', repo: 'main', home: '/h', rows, ...over })

describe('미리보기 줄 — porcelain 해석 결과(bare · 잠김 · prunable · 분리된 HEAD)', () => {
  it('bare · prunable · 모르는 속성 · 상태 미확인은 막고, 잠김은 표시만, 분리된 HEAD 는 폴더 이름', () => {
    const view: WorktreeView = { root: '/r/main', commonDir: '/r/main/.git', entries: [
      entry({ path: '/r/main.git', bare: true, primary: true, head: null, branch: null, canOpen: false }),
      entry({ path: '/r/gone', branch: 'refs/heads/gone', prunable: true, prunableReason: 'gitdir file points to non-existent location', canOpen: false }),
      entry({ path: '/r/locked', locked: true, branch: 'refs/heads/feat/lock' }),
      entry({ path: '/r/det', branch: null }),
      entry({ path: '/r/odd', branch: 'refs/heads/odd', unknownAttributes: ['future'] }),
      entry({ path: '/r/slow', branch: 'refs/heads/slow', canOpen: false, statusKnown: false }),
    ] }
    const rows = importRows(view, () => null, new Map())
    expect(rows.map((r) => [r.label, r.name, !!r.blocked])).toEqual([
      ['bare 저장소', 'main.git', true], ['gone', 'gone', true], ['feat/lock', 'feat/lock', false], ['분리된 HEAD', 'det', false], ['odd', 'odd', true], ['slow', 'slow', true],
    ])
    expect(rows[1]!.blocked).toContain('non-existent')
    expect(rows[2]!.locked).toBe(true)
    expect(repoName(view)).toBe('main')
  })

  it('실제 git — 잠근 worktree 는 가져올 수 있고, 폴더를 지운 worktree 는 막히고, --detach 는 폴더 이름', async () => {
    const r = repository()
    const locked = r.add('locked')
    git(r.root, 'worktree', 'lock', '--reason', 'usb', locked)
    const gone = r.add('gone')
    rmSync(gone, { recursive: true, force: true })
    const det = r.add('det', '--detach')
    const p = await buildImportPreview({ worktrees: r.service, tasks: () => [], home: '/h', sessions: async () => emptyList() }, r.root)
    const at = (path: string) => p.rows.find((x) => x.path === path)!
    expect(p.repo).toBe('shop')
    expect(at(r.root)).toMatchObject({ primary: true, blocked: null, name: 'main' })
    expect(at(locked)).toMatchObject({ locked: true, blocked: null, name: 'locked' })
    expect(at(gone).blocked).toBeTruthy()
    expect(at(det)).toMatchObject({ label: '분리된 HEAD', name: 'det', blocked: null })
  })
})

describe('리뷰 고침 — 시간 제한 이유 · 안쪽 폴더 일감', () => {
  it('39 list() 의 시간 제한으로 상태를 못 본 줄은 \'바뀜\' 이 아니라 \'확인 못 함\' 이유', () => {
    const view: WorktreeView = { root: '/r/main', commonDir: '/r/main/.git', entries: [
      entry({ path: '/r/late', branch: 'refs/heads/late', canOpen: false, statusKnown: false, reasons: ['전체 조회 시간 제한 — 새로 읽어 주세요'] }),
    ] }
    const [late] = importRows(view, () => null, new Map())
    expect(late!.blocked).toContain('시간 안에')
    const plan = importPlan([{ path: '/r/late', commonDir: '/r/main/.git', label: 'late' }], preview([late!]), [])
    expect(plan.skipped[0]!.reason).toContain('다시 확인하지 못했어요')
  })
  it('worktree 안쪽 폴더를 일감 폴더로 쓰는 일감이 있으면 가져올 수는 있지만 기본으로 고르지 않는다 — 더 안쪽 worktree 의 일감은 그 worktree 것', async () => {
    const r = repository()
    const wt = r.add('mono')
    mkdirSync(join(wt, 'packages', 'app'), { recursive: true })
    const nested = join(wt, 'nested')
    git(r.root, 'worktree', 'add', '-b', 'nested', nested, 'main')
    const s = emptyState()
    const inApp = task(s, '앱 일감', join(wt, 'packages', 'app'))
    const inNested = task(s, '안쪽', join(nested, 'src'))
    mkdirSync(join(nested, 'src'))
    const p = await buildImportPreview({ worktrees: r.service, tasks: () => [inApp, inNested], home: '/h', sessions: async () => emptyList() }, r.root)
    const mono = p.rows.find((x) => x.path === wt)!
    expect(mono.nearby).toEqual({ taskId: inApp.id, name: '앱 일감' })
    expect(mono.existing).toBeNull()
    expect(pickedByDefault(mono)).toBe(false)
    expect(p.rows.find((x) => x.path === nested)!.nearby).toEqual({ taskId: inNested.id, name: '안쪽' })
    expect(p.rows.find((x) => x.path === r.root)!.nearby).toBeNull()
  })
})

describe('같은 폴더 신원 — 39 열기와 70 이 같이 쓰는 taskFolders', () => {
  it('링크 · ~ 로 적은 일감 폴더도 같은 폴더, 보관 · 원격 일감은 세지 않는다', async () => {
    const home = temp('tm-import-home-')
    const real = join(home, 'code', 'shop')
    mkdirSync(real, { recursive: true })
    symlinkSync(join(home, 'code'), join(home, 'alias'))
    const s = emptyState()
    const viaHome = task(s, '집', '~/code/shop')
    const viaLink = task(s, '링크', join(home, 'alias', 'shop'))
    const archived = task(s, '보관', real, { archivedAt: 5 })
    const remote = task(s, '원격', real, { host: 'nas' })
    expect((await taskFolders(() => [archived, remote, viaHome, viaLink], home)).get(real)).toMatchObject({ id: viaHome.id, name: '집' })
    expect((await taskFolders(() => [archived, remote], home)).get(real)).toBeUndefined()
  })
  it('realpath 를 기다리는 사이 보관 · 폴더가 바뀐 일감은 아니다', async () => {
    const home = temp('tm-import-home-')
    const s = emptyState()
    const t = task(s, 'a', home)
    let calls = 0
    const owners = await taskFolders(() => (calls++ === 0 ? [t] : [{ ...t, archivedAt: 1 }]), home)
    expect(owners.size).toBe(0)
  })
  it('미리보기 — 이 폴더를 쓰는 일감이 있으면 이미 일감 있음', async () => {
    const r = repository()
    const wt = r.add('feat')
    const s = emptyState()
    const t = task(s, '있던 일감', wt)
    const p = await buildImportPreview({ worktrees: r.service, tasks: () => [t], home: '/h', sessions: async () => emptyList() }, r.root)
    expect(p.rows.find((x) => x.path === wt)!.existing).toEqual({ taskId: t.id, name: '있던 일감' })
    expect(pickedByDefault(p.rows.find((x) => x.path === wt)!)).toBe(false)
    expect(pickedByDefault(p.rows.find((x) => x.path === r.root)!)).toBe(true)
  })
})

describe('세션 후보는 그 폴더 것만', () => {
  const s = (over: Partial<SessionLike>): SessionLike => ({ agent: 'claude', id: uuid(1), summary: 'x', updatedAt: 1, cwd: '/w/app', ...over })
  it('같은 폴더 · 하위 폴더는 그 worktree, 앞부분만 같은 형제 폴더 · 바깥은 아니다, 안쪽 worktree 세션은 안쪽만', () => {
    const map = assignSessions([
      s({ id: uuid(1), cwd: '/w/app/src' }),
      s({ id: uuid(2), cwd: '/w/app-2' }),
      s({ id: uuid(3), cwd: '/w/app/.worktrees/x/lib' }),
      s({ id: uuid(4), cwd: '/w' }),
    ], ['/w/app', '/w/app/.worktrees/x', '/w/app-2-not'])
    expect(map.get('/w/app')!.map((h) => h.id)).toEqual([uuid(1)])
    expect(map.get('/w/app/.worktrees/x')!.map((h) => h.id)).toEqual([uuid(3)])
    expect(map.has('/w/app-2-not')).toBe(false)
  })
  it('에이전트마다 최신 하나 — 최신이 먼저', () => {
    const map = assignSessions([
      s({ id: uuid(1), updatedAt: 5 }), s({ id: uuid(2), updatedAt: 9 }),
      s({ agent: 'codex', id: uuid(3), updatedAt: 7 }), s({ agent: 'codex', id: uuid(4), updatedAt: 2 }),
    ], ['/w/app'])
    expect(map.get('/w/app')).toEqual([
      { agent: 'claude', id: uuid(2), summary: 'x', at: 9 }, { agent: 'codex', id: uuid(3), summary: 'x', at: 7 },
    ])
  })
  it('실제 git + 53 기록 읽기 — 링크로 적힌 세션 폴더도 realpath 로 맞추고, 다른 worktree 세션은 안 붙는다', async () => {
    const r = repository()
    const wt = r.add('feat')
    symlinkSync(wt, join(r.temporary, 'feat-link'))
    const dir = temp('tm-import-sessions-')
    const write = (agent: 'claude' | 'codex', i: number, cwd: string, mtime: number) => {
      const folder = agent === 'claude' ? join(dir, 'claude', 'projects', '-p') : join(dir, 'codex', 'sessions', '2026', '11', '19')
      mkdirSync(folder, { recursive: true })
      const file = agent === 'claude' ? join(folder, `${uuid(i)}.jsonl`) : join(folder, `rollout-2026-11-19T00-00-00-${uuid(i)}.jsonl`)
      writeFileSync(file, agent === 'claude'
        ? JSON.stringify({ type: 'user', cwd, timestamp: '2026-11-19T00:00:00.000Z', message: { role: 'user', content: `세션 ${i}` } }) + '\n'
        : JSON.stringify({ type: 'session_meta', payload: { id: uuid(i), cwd, timestamp: '2026-11-19T00:00:00.000Z', source: 'cli' } }) + '\n' +
          JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `세션 ${i}` }] } }) + '\n')
      utimesSync(file, mtime, mtime)
    }
    write('claude', 1, join(r.temporary, 'feat-link'), 1_000_100)
    write('claude', 2, wt, 1_000_050)
    write('codex', 3, r.root, 1_000_000)
    const sessions = new AgentSessions(() => [
      { agent: 'claude', dir: join(dir, 'claude', 'projects'), account: 'default-claude' },
      { agent: 'codex', dir: join(dir, 'codex', 'sessions'), account: 'default-codex' },
    ])
    const p = await buildImportPreview({ worktrees: r.service, tasks: () => [], home: '/h', sessions: () => sessions.list() }, r.root)
    expect(p.rows.find((x) => x.path === wt)!.sessions.map((h) => [h.agent, h.id, h.summary])).toEqual([['claude', uuid(1), '세션 1']])
    expect(p.rows.find((x) => x.path === r.root)!.sessions.map((h) => [h.agent, h.id])).toEqual([['codex', uuid(3)]])
    expect(p.sessionsNote).toBeUndefined()
  })
  it('세션 읽기가 실패하거나 한도를 넘으면 세션 없이 미리보기', async () => {
    const r = repository()
    const failed = await buildImportPreview({ worktrees: r.service, tasks: () => [], home: '/h', sessions: async () => { throw new Error('x') } }, r.root)
    expect(failed.sessionsNote).toContain('세션')
    expect(failed.rows).toHaveLength(1)
    const slow = await buildImportPreview({ worktrees: r.service, tasks: () => [], home: '/h', sessions: () => new Promise(() => {}), sessionsMs: 20 }, r.root)
    expect(slow.sessionsNote).toContain('세션')
  })
})

describe('누른 뒤 다시 읽은 목록으로 계획 — 사라짐 · 이미 일감은 만들지 않는다', () => {
  const picked = (path: string) => ({ path, commonDir: '/r/main/.git', label: path })
  it('다시 읽은 목록에 없음 · 이제 막힘 · main 이 본 일감 · 지금 상태의 같은 폴더 일감은 건너뜀', () => {
    const s = emptyState()
    s.tasks = [task(s, '방금', '~/later'), task(s, '보관', '/r/arch', { archivedAt: 1 })]
    const fresh = preview([
      row({ path: '/r/blocked', blocked: '폴더가 없거나 등록을 복구해야 해요' }),
      row({ path: '/r/has', existing: { taskId: 't', name: '있던' } }),
      row({ path: '/h/later' }),
      row({ path: '/r/arch', name: 'arch' }),
      row({ path: '/r/ok', name: 'ok' }),
    ])
    const plan = importPlan(['/r/gone', '/r/blocked', '/r/has', '/h/later', '/r/arch', '/r/ok', '/r/ok'].map(picked), fresh, s.tasks)
    expect(plan.create.map((x) => x.path)).toEqual(['/r/arch', '/r/ok'])
    const kind = (reason: string) => reason.startsWith('미리보기 뒤 사라') ? 'gone' : reason.startsWith('미리보기 뒤 바뀌') ? 'changed' : reason.startsWith('이미 일감이 있') ? 'has' : reason
    expect(plan.skipped.map((x) => [x.path, kind(x.reason)])).toEqual([['/r/gone', 'gone'], ['/r/blocked', 'changed'], ['/r/has', 'has'], ['/h/later', 'has']])
  })
  it('다른 저장소의 같은 경로(commonDir 다름)는 사라진 것으로 본다', () => {
    const plan = importPlan([{ path: '/r/ok', commonDir: '/other/.git', label: 'ok' }], preview([row({ path: '/r/ok' })]), [])
    expect(plan.create).toEqual([])
  })
  it('실제 git — 미리보기 뒤 폴더를 지우면 다시 읽기에서 막혀 만들지 않는다', async () => {
    const r = repository()
    const a = r.add('a'), b = r.add('b')
    const deps = { worktrees: r.service, tasks: () => [], home: '/h', sessions: async () => emptyList() }
    const first = await buildImportPreview(deps, r.root)
    const pick = first.rows.filter((x) => x.path === a || x.path === b).map((x) => ({ path: x.path, commonDir: x.commonDir, label: x.label }))
    rmSync(a, { recursive: true, force: true })
    let state = emptyState()
    const report = await runImport(r.root, pick, {
      preview: (root) => buildImportPreview(deps, root), state: () => state, newId, now: () => 1, alive: () => true,
      apply: (tasks, group) => { state = applyImport(state, tasks, group) },
    })
    expect(report!.created.map((c) => c.path)).toEqual([b])
    expect(report!.skipped.map((c) => c.path)).toEqual([a])
    expect(state.tasks.map((t) => t.cwd)).toEqual([b])
  })
})

describe('가져오기 실행 runImport', () => {
  const pick = [{ path: '/r/ok', commonDir: '/r/main/.git', label: 'ok' }]
  it('다시 읽기가 실패하면 던지고 아무것도 만들지 않는다 · 닫혔으면 만들지 않는다', async () => {
    let applied = 0
    const base = { state: () => emptyState(), newId, now: () => 1, apply: () => { applied++ } }
    await expect(runImport('/r/main', pick, { ...base, alive: () => true, preview: async () => { throw new Error('Git 조회에 실패했어요') } })).rejects.toThrow('Git')
    expect(await runImport('/r/main', pick, { ...base, alive: () => false, preview: async () => preview([row({ path: '/r/ok' })]) })).toBeNull()
    expect(applied).toBe(0)
  })
  it('같은 고름으로 다시 하면 모두 이미 일감 — 두 번 만들지 않는다', async () => {
    let state = emptyState()
    const deps = { state: () => state, newId, now: () => 1, alive: () => true, preview: async () => preview([row({ path: '/r/ok', sessions: [{ agent: 'claude' as const, id: uuid(1), summary: 's', at: 3 }] })]),
      apply: (tasks: Task[], group: Parameters<typeof applyImport>[2]) => { state = applyImport(state, tasks, group) } }
    const first = await runImport('/r/main', pick, deps)
    expect(first!.created).toHaveLength(1)
    expect(first!.created[0]!.hints).toBe(1)
    expect(state.tasks[0]!.sessionHints).toEqual([{ agent: 'claude', id: uuid(1), summary: 's', at: 3 }])
    const again = await runImport('/r/main', pick, deps)
    expect(again!.created).toEqual([])
    expect(again!.skipped[0]!.reason).toContain('이미 일감')
    expect(state.tasks).toHaveLength(1)
  })
})

describe('묶음 이름 — 저장소 이름, 겹치면', () => {
  const paths = ['/w/shop', '/w/shop-wt/a']
  const world = () => { const s = emptyState(); s.settings.groups = []; return s }
  it('없으면 새로 · 같은 이름(대소문자 · 공백 무시)의 빈 묶음은 재사용', () => {
    const s = world()
    expect(importGroup(s, 'shop', paths, '/h')).toEqual({ create: 'shop' })
    s.settings.groups = [{ id: 'g1', name: ' Shop ' }]
    expect(importGroup(s, 'shop', paths, '/h')).toEqual({ reuse: 'g1' })
  })
  it('그 저장소 일감만 든 묶음은 재사용, 다른 폴더 일감이 있으면 (2) · (2) 도 남의 것이면 (3)', () => {
    const s = world()
    s.settings.groups = [{ id: 'g1', name: 'shop' }]
    s.tasks = [task(s, 'a', '/w/shop-wt/a', { groupId: 'g1' })]
    expect(importGroup(s, 'shop', paths, '/h')).toEqual({ reuse: 'g1' })
    s.tasks.push(task(s, '남', '/w/other', { groupId: 'g1' }))
    expect(importGroup(s, 'shop', paths, '/h')).toEqual({ create: 'shop (2)' })
    s.settings.groups.push({ id: 'g2', name: 'shop (2)' })
    s.tasks.push(task(s, '남2', '/w/other2', { groupId: 'g2' }))
    expect(importGroup(s, 'shop', paths, '/h')).toEqual({ create: 'shop (3)' })
    s.settings.groups.push({ id: 'g3', name: 'shop (3)' })
    expect(importGroup(s, 'shop', paths, '/h')).toEqual({ reuse: 'g3' })
  })
})

describe('reducer task/import · 이어 하기 후보 · 저장 형식', () => {
  const repo = { name: 'shop', paths: ['/r/main', '/r/a', '/r/b'] }
  it('이미 가져온 저장소에 새 worktree 만 다시 가져오면 같은 묶음 — 묶음은 저장소의 모든 worktree 로 정한다', async () => {
    let state = emptyState()
    state.settings.groups = []
    const first = importTasks(state, [row({ path: '/r/main', name: 'main' })], repo, '/h', newId, 1)
    state = applyImport(state, first.tasks, first.group)
    const pick = [{ path: '/r/b', commonDir: '/r/main/.git', label: 'b' }]
    const report = await runImport('/r/main', pick, {
      preview: async () => preview([row({ path: '/r/main', existing: { taskId: first.tasks[0]!.id, name: 'main' } }), row({ path: '/r/b', name: 'b' })], { repo: 'shop' }),
      state: () => state, newId, now: () => 2, alive: () => true, apply: (tasks, group) => { state = applyImport(state, tasks, group) },
    })
    expect(report).toMatchObject({ group: 'shop', reused: true })
    expect(state.settings.groups.map((g) => g.name)).toEqual(['shop'])
    expect(new Set(state.tasks.map((t) => t.groupId)).size).toBe(1)
  })
  it('묶음 + 일감을 한 번에, 첫 일감 선택, 같은 폴더 일감은 다시 거름, 만들 것이 없으면 묶음도 안 만든다', () => {
    const s = emptyState()
    s.settings.groups = []
    const made = importTasks(s, [row({ path: '/r/a', name: 'a' }), row({ path: '/r/b', name: 'b' })], repo, '/h', newId, 1)
    expect(made.group?.name).toBe('shop')
    const after = applyImport(s, made.tasks, made.group)
    expect(after.settings.groups.map((g) => g.name)).toEqual(['shop'])
    expect(after.tasks.map((t) => [t.name, t.cwd, t.groupId])).toEqual([['a', '/r/a', made.group!.id], ['b', '/r/b', made.group!.id]])
    expect(after.activeTaskId).toBe(made.tasks[0]!.id)
    // 겹친 두 동작 — 두 번째는 같은 폴더라 거른다
    const twice = importTasks(after, [row({ path: '/r/a', name: 'a' })], repo, '/h', newId, 2)
    expect(applyImport(after, twice.tasks, twice.group)).toBe(after)
    const none = importTasks(s, [], repo, '/h', newId, 3)
    expect(none.group).toBeNull()
  })
  it('67 revision 기준은 가져오기에 바뀌고 이어 하기 후보 지우기에는 안 바뀐다', () => {
    const s = emptyState()
    const made = importTasks(s, [row({ path: '/r/a', sessions: [{ agent: 'codex', id: uuid(2), summary: '', at: 1 }] })], repo, '/h', newId, 1)
    const after = applyImport(s, made.tasks, made.group)
    expect(worktreeUseKey(after.tasks)).not.toBe(worktreeUseKey(s.tasks))
    const dropped = dropSessionHints(after, made.tasks[0]!.id, uuid(2))
    expect(dropped.tasks[0]!.sessionHints).toBeUndefined()
    expect(worktreeUseKey(dropped.tasks)).toBe(worktreeUseKey(after.tasks))
  })
  it('후보 하나 지우기 · 닫기(모두)', () => {
    const s = emptyState()
    const t = task(s, 'a', '/r/a', { sessionHints: [{ agent: 'claude', id: uuid(1), summary: '', at: 1 }, { agent: 'codex', id: uuid(2), summary: '', at: 1 }] })
    s.tasks = [t]
    expect(dropSessionHints(s, t.id, uuid(1)).tasks[0]!.sessionHints!.map((h) => h.id)).toEqual([uuid(2)])
    expect(dropSessionHints(s, t.id).tasks[0]!.sessionHints).toBeUndefined()
    expect(dropSessionHints(s, t.id, uuid(9))).toBe(s)
  })
  it('저장 파일 검증 — UUID 아닌 id · 모르는 에이전트 · 같은 에이전트 둘째는 버리고 요약은 160자', () => {
    const hints = parseSessionHints([
      { agent: 'claude', id: '$(rm -rf ~)', summary: 'x', at: 1 },
      { agent: 'gemini', id: uuid(1), summary: 'x', at: 1 },
      { agent: 'claude', id: uuid(2), summary: 'y'.repeat(300), at: 2 },
      { agent: 'claude', id: uuid(3), summary: 'z', at: 3 },
      { agent: 'codex', id: uuid(4), at: 'x' },
    ])
    expect(hints).toEqual([{ agent: 'claude', id: uuid(2), summary: 'y'.repeat(160), at: 2 }, { agent: 'codex', id: uuid(4), summary: '', at: 0 }])
    const s = emptyState()
    s.tasks = [{ ...task(s, 'a', '/r/a'), sessionHints: [{ agent: 'claude', id: uuid(2), summary: 'ok', at: 2 }] }]
    s.activeTaskId = s.tasks[0]!.id
    expect(normalizeState(JSON.parse(JSON.stringify(s)), newId).tasks[0]!.sessionHints).toEqual([{ agent: 'claude', id: uuid(2), summary: 'ok', at: 2 }])
  })
})

describe('미리보기 권한 ImportRoots', () => {
  it('고르지 않은 폴더는 거절, 고른 폴더는 별칭 경로로도 허용, 최근 20개만', async () => {
    const d = temp('tm-import-roots-')
    const folders = Array.from({ length: 21 }, (_, i) => { const p = join(d, `r${i}`); mkdirSync(p); return p })
    symlinkSync(folders[20]!, join(d, 'alias'))
    const roots = new ImportRoots()
    expect(await roots.allowed(folders[0])).toBeNull()
    for (const f of folders) await roots.add(f)
    expect(await roots.allowed(join(d, 'alias'))).toBe(folders[20])
    expect(await roots.allowed(folders[0])).toBeNull()
    expect(await roots.allowed(folders[1])).toBe(folders[1])
    expect(await roots.allowed(42)).toBeNull()
  })
})
