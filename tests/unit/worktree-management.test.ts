import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseWorktrees, validWorktreeJournal, type WorktreeSnapshot, type WorktreeJournalState } from '../../src/shared/worktree-management'
import { WorktreeManagement, makeWorktreeGit, type WorktreeGit } from '../../src/main/worktree-management'
import { AtomicJournal } from '../../src/main/atomic-journal'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function git(root: string, ...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  return execFileSync('git', ['-c', 'commit.gpgSign=false', '-C', root, ...args], {
    encoding: 'utf8', env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' }, stdio: ['pipe', 'pipe', 'pipe'],
  })
}

function repository(separate = false) {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'tm-worktree-39-test-')))
  roots.push(temporary)
  const root = join(temporary, 'main'), journalFile = join(temporary, 'journal.json')
  mkdirSync(root)
  git(root, 'init', ...(separate ? ['--separate-git-dir', join(temporary, 'admin')] : []), '.')
  git(root, 'config', 'user.name', 'Worktree test')
  git(root, 'config', 'user.email', 'worktree-test@example.invalid')
  git(root, 'config', 'core.hooksPath', join(temporary, 'hooks'))
  writeFileSync(join(root, 'tracked.txt'), 'original\n')
  writeFileSync(join(root, '.gitignore'), 'ignored.txt\n')
  git(root, 'add', '.')
  git(root, 'commit', '-m', 'initial')
  const oid = git(root, 'rev-parse', 'HEAD').trim()
  const run = makeWorktreeGit()
  const journal = () => new AtomicJournal<WorktreeJournalState>(journalFile, validWorktreeJournal)
  const service = (options: { run?: WorktreeGit; freshUsedCwds?: () => readonly string[] | Promise<readonly string[]>; usedRevision?: () => unknown } = {}) => new WorktreeManagement({ journal: journal(), ...options })
  return { temporary, root, oid, run, journalFile, service }
}

async function linked(f: ReturnType<typeof repository>, name = 'linked') {
  const path = join(f.temporary, name)
  git(f.root, 'worktree', 'add', '-b', name, path, f.oid)
  const row = (await f.service().list(f.root)).entries.find((entry) => entry.path === path)!
  expect(row).toBeDefined()
  return row
}

const snapshot = (row: WorktreeSnapshot): WorktreeSnapshot => ({ path: row.path, commonDir: row.commonDir, head: row.head, branch: row.branch })

describe('worktree porcelain -z parser', () => {
  it('preserves spaces and newlines and identifies the primary bare record', () => {
    const rows = parseWorktrees('worktree /tmp/bare source\0bare\0\0worktree /tmp/a\nb\0HEAD ' + 'a'.repeat(40) + '\0detached\0locked reason\ncontinued\0\0')
    expect(rows[0]).toMatchObject({ path: '/tmp/bare source', bare: true, primary: true })
    expect(rows[1]).toMatchObject({ path: '/tmp/a\nb', primary: false, locked: true, lockedReason: 'reason\ncontinued' })
  })
  it.each([
    'worktree /tmp/a\0HEAD ' + 'a'.repeat(40) + '\0',
    'worktree /tmp/a\0HEAD nope\0\0',
    'worktree /tmp/a\0HEAD ' + 'a'.repeat(40) + '\0HEAD ' + 'b'.repeat(40) + '\0\0',
    'HEAD ' + 'a'.repeat(40) + '\0worktree /tmp/a\0\0',
  ])('rejects incomplete or ambiguous records', (raw) => {
    expect(() => parseWorktrees(raw)).toThrow()
  })
  it('retains all records beyond 64 and treats unknown attributes conservatively', () => {
    const raw = Array.from({ length: 100 }, (_, i) => `worktree /tmp/w-${i}\0HEAD ${'a'.repeat(40)}\0detached\0future reason\0\0`).join('')
    const rows = parseWorktrees(raw)
    expect(rows).toHaveLength(100)
    expect(rows[99].unknownAttributes).toEqual(['future'])
  })
})

describe('real Git worktree management', () => {
  it('identifies separate-git-dir primary and linked repository identity and opens only registered checkouts', async () => {
    const f = repository(true), row = await linked(f)
    const view = await f.service().list(row.path)
    // Without core.worktree, Git itself reports the separate admin directory as its primary entry.
    expect(view.entries[0]).toMatchObject({ primary: true, path: join(f.temporary, 'admin'), commonDir: join(f.temporary, 'admin'), canOpen: false, removable: false })
    expect(view.entries[1]).toMatchObject({ path: row.path, primary: false, canOpen: true, removable: true })
    expect(await f.service().open(f.root, snapshot(row))).toEqual({ path: row.path })
    await expect(f.service().open(f.root, { ...snapshot(row), commonDir: f.root })).rejects.toThrow()
    await expect(f.service().remove(f.root, snapshot(view.entries[0]))).rejects.toThrow()
    expect(existsSync(join(f.root, 'tracked.txt'))).toBe(true)
  })

  it('creates from an explicit pinned base once, preserving receipts across service restart and different aliases', async () => {
    const f = repository(), path = join(f.temporary, 'new tree\nline')
    const source = await linked(f, 'source')
    git(f.root, 'commit', '--allow-empty', '-m', 'new HEAD')
    let writes = 0
    const run: WorktreeGit = async (cwd, args) => { if (args[0] === 'worktree' && args[1] === 'add') writes++; return f.run(cwd, args) }
    const input = { requestId: 'one', branch: 'feature/base', base: f.oid, path, transient: 'not-journaled' }
    const service = f.service({ run })
    const results = await Promise.all([service.create(f.root, input), service.create(source.path, input)])
    expect(results.map((result) => result.state)).toEqual(['created', 'created'])
    expect(writes).toBe(1)
    expect(git(path, 'rev-parse', 'HEAD').trim()).toBe(f.oid)
    const alias = join(f.temporary, 'alias')
    symlinkSync(f.root, alias)
    expect((await f.service({ run }).create(alias, input)).state).toBe('created')
    expect(writes).toBe(1)
    await expect(service.create(f.root, { ...input, branch: 'other' })).rejects.toThrow()
    const receipt = JSON.parse(readFileSync(f.journalFile, 'utf8'))
    expect(receipt.creates[0]).toMatchObject({ state: 'created', baseOid: f.oid, commonDir: join(f.root, '.git') })
    expect(receipt.creates[0]).not.toHaveProperty('transient')
  })

  it('journals before git and reconciles a lost successful reply without repeating add', async () => {
    const f = repository(), path = join(f.temporary, 'lost')
    let writes = 0
    const run: WorktreeGit = async (cwd, args) => {
      if (args[0] === 'worktree' && args[1] === 'add') {
        expect(JSON.parse(readFileSync(f.journalFile, 'utf8')).creates[0].state).toBe('pending')
        writes++
        await f.run(cwd, args)
        return { code: -1, stdout: '', timedOut: true }
      }
      return f.run(cwd, args)
    }
    const input = { requestId: 'lost', branch: 'lost', base: f.oid, path }
    expect((await f.service({ run }).create(f.root, input)).state).toBe('created')
    expect((await f.service({ run }).create(f.root, input)).state).toBe('created')
    expect(writes).toBe(1)
  })

  it('supports a bare source while protecting the primary metadata entry', async () => {
    const f = repository(), bare = join(f.temporary, 'bare.git'), path = join(f.temporary, 'from-bare')
    git(f.root, 'clone', '--bare', '--no-local', f.root, bare)
    git(bare, 'config', 'core.hooksPath', join(f.temporary, 'hooks'))
    const service = f.service()
    const view = await service.list(bare)
    expect(view.entries[0]).toMatchObject({ bare: true, primary: true, head: null, path: bare, canOpen: false, removable: false })
    expect((await service.create(bare, { requestId: 'bare', branch: 'from-bare', base: f.oid, path })).state).toBe('created')
    expect(git(path, 'rev-parse', 'HEAD').trim()).toBe(f.oid)
  })

  it('refuses creation before any Git write if the durable receipt cannot be saved', async () => {
    const f = repository(), path = join(f.temporary, 'not-written')
    let writes = 0
    const service = new WorktreeManagement({
      journal: { load: () => ({ version: 1, creates: [] }), save: () => { throw new Error('disk full') } },
      run: (cwd, args) => { if (args[0] === 'worktree' && args[1] === 'add') writes++; return f.run(cwd, args) },
    })
    await expect(service.create(f.root, { requestId: 'disk', branch: 'disk', base: f.oid, path })).rejects.toThrow()
    expect(writes).toBe(0)
    expect(existsSync(path)).toBe(false)
  })

  it('merges durable receipts from concurrent different repositories without dropping either request', async () => {
    const a = repository(), b = repository()
    const sharedJournal = () => new AtomicJournal<WorktreeJournalState>(a.journalFile, validWorktreeJournal)
    const first = new WorktreeManagement({ journal: sharedJournal() })
    const second = new WorktreeManagement({ journal: sharedJournal() })
    const results = await Promise.all([
      first.create(a.root, { requestId: 'a', branch: 'a', base: a.oid, path: join(a.temporary, 'a') }),
      second.create(b.root, { requestId: 'b', branch: 'b', base: b.oid, path: join(b.temporary, 'b') }),
    ])
    expect(results.map((result) => result.state)).toEqual(['created', 'created'])
    expect(JSON.parse(readFileSync(a.journalFile, 'utf8')).creates.map((receipt: { requestId: string }) => receipt.requestId).sort()).toEqual(['a', 'b'])
  })

  it('does not overwrite a global request id used by a concurrent different repository', async () => {
    const a = repository(), b = repository()
    const sharedJournal = () => new AtomicJournal<WorktreeJournalState>(a.journalFile, validWorktreeJournal)
    let writes = 0
    const run: WorktreeGit = (cwd, args) => { if (args[0] === 'worktree' && args[1] === 'add') writes++; return a.run(cwd, args) }
    const first = new WorktreeManagement({ journal: sharedJournal(), run })
    const second = new WorktreeManagement({ journal: sharedJournal(), run })
    const results = await Promise.allSettled([
      first.create(a.root, { requestId: 'same', branch: 'a', base: a.oid, path: join(a.temporary, 'a') }),
      second.create(b.root, { requestId: 'same', branch: 'b', base: b.oid, path: join(b.temporary, 'b') }),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(writes).toBe(1)
    expect(JSON.parse(readFileSync(a.journalFile, 'utf8')).creates).toHaveLength(1)
  })

  it('never automatically reissues a pending or unknown creation when nothing is registered', async () => {
    const f = repository(), input = { requestId: 'uncertain', branch: 'uncertain', base: f.oid, path: join(f.temporary, 'uncertain') }
    let writes = 0
    const run: WorktreeGit = async (cwd, args) => {
      if (args[0] === 'worktree' && args[1] === 'add') { writes++; return { code: -1, stdout: '', timedOut: true } }
      return f.run(cwd, args)
    }
    expect((await f.service({ run }).create(f.root, input)).state).toBe('unknown')
    expect((await f.service({ run }).create(f.root, input)).state).toBe('unknown')
    expect(writes).toBe(1)
  })

  it('preserves corrupt journals and refuses all Git writes', async () => {
    const f = repository(), row = await linked(f)
    writeFileSync(f.journalFile, 'broken')
    const service = f.service()
    await expect(service.create(f.root, { requestId: 'bad', branch: 'bad', base: f.oid, path: join(f.temporary, 'bad') })).rejects.toThrow()
    await expect(service.remove(f.root, snapshot(row))).rejects.toThrow()
    expect(readFileSync(f.journalFile, 'utf8')).toBe('broken')
    expect(existsSync(row.path)).toBe(true)
  })

  it.each(['tracked', 'untracked', 'ignored'])('blocks %s content even with status.showUntrackedFiles=no', async (kind) => {
    const f = repository(), row = await linked(f)
    git(f.root, 'config', 'status.showUntrackedFiles', 'no')
    const file = join(row.path, kind === 'tracked' ? 'tracked.txt' : kind === 'ignored' ? 'ignored.txt' : 'private.txt')
    writeFileSync(file, 'keep me')
    const current = (await f.service().list(f.root)).entries.find((entry) => entry.path === row.path)!
    expect(current[kind === 'tracked' ? 'dirty' : kind as 'untracked' | 'ignored']).toBe(true)
    await expect(f.service().remove(f.root, snapshot(row))).rejects.toThrow()
    expect(readFileSync(file, 'utf8')).toBe('keep me')
  })

  it.each(['--assume-unchanged', '--skip-worktree'])('blocks hidden tracked modifications with %s', async (flag) => {
    const f = repository(), row = await linked(f)
    git(row.path, 'update-index', flag, 'tracked.txt')
    writeFileSync(join(row.path, 'tracked.txt'), 'hidden')
    const current = (await f.service().list(f.root)).entries.find((entry) => entry.path === row.path)!
    expect(current.unsafeIndex).toBe(true)
    await expect(f.service().remove(f.root, snapshot(row))).rejects.toThrow()
    expect(readFileSync(join(row.path, 'tracked.txt'), 'utf8')).toBe('hidden')
  })

  it('blocks sparse checkout even when tracked contents are currently clean', async () => {
    const f = repository(), row = await linked(f)
    git(f.root, 'config', 'core.sparseCheckout', 'true')
    await expect(f.service().remove(f.root, snapshot(row))).rejects.toThrow()
    expect(existsSync(row.path)).toBe(true)
  })

  it('blocks locked entries, changed HEAD or branch, and unregistered paths', async () => {
    const f = repository(), row = await linked(f)
    git(f.root, 'worktree', 'lock', '--reason', 'keep\nreason', row.path)
    expect((await f.service().list(f.root)).entries[1]).toMatchObject({ locked: true, lockedReason: 'keep\nreason' })
    await expect(f.service().remove(f.root, snapshot(row))).rejects.toThrow()
    git(f.root, 'worktree', 'unlock', row.path)
    git(row.path, 'commit', '--allow-empty', '-m', 'moved')
    await expect(f.service().remove(f.root, snapshot(row))).rejects.toThrow()
    const current = (await f.service().list(f.root)).entries[1]
    git(row.path, 'checkout', '-b', 'changed-branch')
    await expect(f.service().remove(f.root, snapshot(current))).rejects.toThrow()
    await expect(f.service().remove(f.root, { ...snapshot(current), path: f.temporary })).rejects.toThrow()
    expect(existsSync(join(row.path, 'tracked.txt'))).toBe(true)
  })

  it('blocks task/pane descendants through aliases and samples current paths immediately before remove', async () => {
    const f = repository(), row = await linked(f)
    const alias = join(f.temporary, 'linked-alias')
    symlinkSync(row.path, alias)
    await expect(f.service().remove(f.root, snapshot(row), [join(alias, 'no-longer-present', 'cwd')])).rejects.toThrow()
    let count = 0
    const service = f.service({ freshUsedCwds: () => ++count === 1 ? [] : [row.path] })
    await expect(service.remove(f.root, snapshot(row))).rejects.toThrow()
    expect(count).toBe(2)
    expect(existsSync(row.path)).toBe(true)
  })

  it('blocks a registered nested checkout, including ignored contents inside it', async () => {
    const f = repository(), row = await linked(f)
    const child = join(row.path, 'nested')
    git(f.root, 'worktree', 'add', '-b', 'nested', child, f.oid)
    writeFileSync(join(child, 'ignored.txt'), 'nested secret')
    const listed = (await f.service().list(f.root)).entries.find((entry) => entry.path === row.path)!
    expect(listed.nested).toBe(true)
    await expect(f.service().remove(f.root, snapshot(row))).rejects.toThrow()
    expect(readFileSync(join(child, 'ignored.txt'), 'utf8')).toBe('nested secret')
  })

  it('fails closed when the main used-path revision changes during the final async probe', async () => {
    const f = repository(), row = await linked(f)
    let revision = 0, probes = 0, removes = 0
    let usedPaths: string[] = []
    const service = f.service({
      usedRevision: () => revision,
      freshUsedCwds: () => {
        const snapshot = [...usedPaths]
        if (++probes !== 2) return snapshot
        return new Promise<string[]>((done) => queueMicrotask(() => {
          usedPaths = [row.path]
          revision++
          done(snapshot)
        }))
      },
      run: (cwd, args) => { if (args[0] === 'worktree' && args[1] === 'remove') removes++; return f.run(cwd, args) },
    })
    await expect(service.remove(f.root, snapshot(row))).rejects.toThrow()
    expect(removes).toBe(0)
    expect(existsSync(row.path)).toBe(true)
  })

  it('does not follow a replacement symlink or remove another repository', async () => {
    const f = repository(), row = await linked(f), other = repository()
    const moved = row.path + '-moved'
    git(f.root, 'worktree', 'move', row.path, moved)
    symlinkSync(other.root, row.path)
    await expect(f.service().remove(f.root, snapshot(row))).rejects.toThrow()
    expect(existsSync(join(other.root, 'tracked.txt'))).toBe(true)
    expect(existsSync(moved)).toBe(true)
  })

  it('rechecks HEAD after asynchronous probes and blocks unknown/truncated status output', async () => {
    const f = repository(), row = await linked(f)
    let changed = false
    const run: WorktreeGit = async (cwd, args) => {
      const result = await f.run(cwd, args)
      if (cwd === row.path && args.includes('status') && !changed) {
        changed = true
        git(row.path, 'commit', '--allow-empty', '-m', 'race')
      }
      return result
    }
    await expect(f.service({ run }).remove(f.root, snapshot(row))).rejects.toThrow()
    const current = (await f.service().list(f.root)).entries[1]
    const truncated: WorktreeGit = (cwd, args) => args.includes('status') ? Promise.resolve({ code: 0, stdout: '', truncated: true }) : f.run(cwd, args)
    await expect(f.service({ run: truncated }).remove(f.root, snapshot(current))).rejects.toThrow()
    expect(existsSync(row.path)).toBe(true)
  })

  it('uses only no-force worktree remove, preserves the branch, and reconciles lost replies', async () => {
    const f = repository(), row = await linked(f)
    let removeArgs: readonly string[] = []
    const run: WorktreeGit = async (cwd, args) => {
      if (args[0] === 'worktree' && args[1] === 'remove') {
        removeArgs = args
        await f.run(cwd, args)
        return { code: -1, stdout: '', timedOut: true }
      }
      return f.run(cwd, args)
    }
    expect((await f.service({ run }).remove(f.root, snapshot(row))).state).toBe('removed')
    expect(removeArgs).toEqual(['worktree', 'remove', '--', row.path])
    expect(existsSync(row.path)).toBe(false)
    expect(git(f.root, 'rev-parse', '--verify', 'refs/heads/linked').trim()).toBe(f.oid)
  })

  it('keeps Git own removal check strict when an untracked file appears after preflight and user config hides untracked files', async () => {
    const f = repository(), row = await linked(f)
    git(f.root, 'config', 'status.showUntrackedFiles', 'no')
    const file = join(row.path, 'late-private.txt')
    const run: WorktreeGit = async (cwd, args) => {
      if (args[0] === 'worktree' && args[1] === 'remove') writeFileSync(file, 'keep late data')
      return f.run(cwd, args)
    }
    expect((await f.service({ run }).remove(f.root, snapshot(row))).state).toBe('unchanged')
    expect(readFileSync(file, 'utf8')).toBe('keep late data')
  })

  it('never compensates with filesystem removal when Git leaves an unmanaged directory', async () => {
    const f = repository(), row = await linked(f)
    const run: WorktreeGit = async (cwd, args) => {
      if (args[0] === 'worktree' && args[1] === 'remove') {
        await f.run(cwd, args)
        mkdirSync(row.path)
        writeFileSync(join(row.path, 'survivor'), 'keep')
        return { code: 1, stdout: '' }
      }
      return f.run(cwd, args)
    }
    expect((await f.service({ run }).remove(f.root, snapshot(row))).state).toBe('unknown')
    expect(readFileSync(join(row.path, 'survivor'), 'utf8')).toBe('keep')
  })
})
