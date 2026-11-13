import { execFile } from 'node:child_process'
import { lstat, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  isWorktreeOid, parseWorktrees, validWorktreeJournal,
  type CreateWorktree, type ManagedWorktree, type WorktreeCreateReceipt,
  type WorktreeCreateResult, type WorktreeJournalState, type WorktreeRemoveResult,
  type WorktreeSnapshot, type WorktreeView,
} from '../shared/worktree-management'

export interface WorktreeJournal {
  load(fallback: WorktreeJournalState): WorktreeJournalState
  save(value: WorktreeJournalState): void
}

export interface WorktreeGitOutput {
  code: number
  stdout: string
  timedOut?: boolean
  truncated?: boolean
}

/** A mutation runner must initiate its subprocess synchronously, before its first await. */
export type WorktreeGit = (cwd: string, args: readonly string[]) => Promise<WorktreeGitOutput>

export interface WorktreeManagementOptions {
  /** One durable owner (for example AtomicJournal) shared by all requests in the app. */
  journal: WorktreeJournal
  run?: WorktreeGit
  freshUsedCwds?: () => readonly string[] | Promise<readonly string[]>
  /** Main increments this revision whenever the authoritative task/pane cwd state changes. */
  usedRevision?: () => unknown
}

interface Repository {
  root: string
  commonDir: string
}

interface Registry extends Repository {
  entries: ManagedWorktree[]
}

const EMPTY: WorktreeJournalState = { version: 1, creates: [] }
const repositoryLocks = new Map<string, Promise<void>>()
const failure = () => new Error('Git 조회에 실패했어요. 결과를 확인하기 전에는 실행하지 않아요.')

/** Does not inherit environment variables that can redirect Git to another repository/index. */
export function makeWorktreeGit(bin = 'git'): WorktreeGit {
  return (cwd, args) => new Promise((resolveOutput) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
    Object.assign(env, { LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat' })
    // worktree remove invokes its own git status; command-line config also reaches that child.
    execFile(bin, ['--no-optional-locks', '-c', 'status.showUntrackedFiles=all', '-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
      env, encoding: 'utf8', timeout: args[0] === 'worktree' && args[1] === 'add' ? 120_000 : 15_000,
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout) => {
      const err = error as (NodeJS.ErrnoException & { killed?: boolean; code?: string | number }) | null
      resolveOutput({
        code: err ? typeof err.code === 'number' ? err.code : -1 : 0,
        stdout: String(stdout),
        timedOut: !!err?.killed && err.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        truncated: err?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      })
    })
  })
}

function absolutePath(value: unknown, expand = false): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0')) throw new Error('절대 경로를 확인해 주세요')
  const path = expand && (value === '~' || value.startsWith('~/')) ? join(homedir(), value.slice(2)) : value
  if (!isAbsolute(path)) throw new Error('절대 경로를 확인해 주세요')
  return resolve(path)
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('../'))
}

/** Resolve existing symlink ancestors even when the last cwd components have disappeared. */
async function canonicalLoose(value: string): Promise<string> {
  let current = absolutePath(value, true)
  const rest: string[] = []
  for (;;) {
    try { return resolve(await realpath(current), ...rest.reverse()) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(current)
      if (parent === current) throw error
      rest.push(basename(current))
      current = parent
    }
  }
}

async function absent(path: string): Promise<boolean> {
  try { await lstat(path); return false }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error }
}

async function locked<T>(key: string, job: () => Promise<T>): Promise<T> {
  const previous = repositoryLocks.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((done) => { release = done })
  const tail = previous.then(() => gate)
  repositoryLocks.set(key, tail)
  await previous
  try { return await job() }
  finally { release(); if (repositoryLocks.get(key) === tail) repositoryLocks.delete(key) }
}

function sameTarget(a: WorktreeSnapshot, b: WorktreeSnapshot): boolean {
  return a.path === b.path && a.commonDir === b.commonDir && a.head === b.head && a.branch === b.branch
}

function validateTarget(value: WorktreeSnapshot): void {
  if (!value || typeof value !== 'object' || !isWorktreeOid(value.head) ||
    (value.branch !== null && (typeof value.branch !== 'string' || value.branch.length > 4096 || !value.branch.startsWith('refs/heads/')))) {
    throw new Error('확인한 worktree 정보를 다시 읽어 주세요')
  }
  absolutePath(value.path)
  absolutePath(value.commonDir)
}

export class WorktreeManagement {
  private readonly run: WorktreeGit
  private storageError = ''

  constructor(private readonly options: WorktreeManagementOptions) {
    this.run = options.run ?? makeWorktreeGit()
    try { this.readJournal() }
    catch { this.storageError = '생성 기록을 읽지 못해 Git 쓰기를 중단했어요. 원본을 복구해 주세요.' }
  }

  private writable(): void {
    if (this.storageError) throw new Error(this.storageError)
  }

  private readJournal(): WorktreeJournalState {
    const value = this.options.journal.load(structuredClone(EMPTY))
    if (!validWorktreeJournal(value)) throw new Error('생성 기록 형식')
    return value
  }

  private record(receipt: WorktreeCreateReceipt): void {
    // Synchronous read/merge/save avoids dropping another repository's receipt between awaits.
    try {
      const state = this.readJournal()
      const index = state.creates.findIndex((item) => item.requestId === receipt.requestId)
      if (index < 0) {
        if (state.creates.length >= 1000) throw new Error('생성 기록 한도')
        state.creates.push(structuredClone(receipt))
      } else {
        const old = state.creates[index]
        if (old.commonDir !== receipt.commonDir || old.path !== receipt.path || old.branch !== receipt.branch || old.base !== receipt.base || old.baseOid !== receipt.baseOid) throw new Error('다른 생성 요청과 번호가 겹쳐요')
        state.creates[index] = structuredClone(receipt)
      }
      this.options.journal.save(state)
    } catch {
      this.storageError = '생성 기록을 저장하지 못해 후속 Git 쓰기를 중단했어요.'
      throw new Error(this.storageError)
    }
  }

  private async git(cwd: string, args: readonly string[]): Promise<string> {
    const result = await this.run(cwd, args)
    if (result.code !== 0 || result.timedOut || result.truncated) throw failure()
    return result.stdout
  }

  private async gitPath(cwd: string, args: readonly string[]): Promise<string> {
    const output = await this.git(cwd, args)
    // Git appends exactly one LF; a legal newline inside a path must not be trimmed.
    return realpath(absolutePath(output.endsWith('\n') ? output.slice(0, -1) : output))
  }

  private async repository(root: string): Promise<Repository> {
    const source = await realpath(absolutePath(root, true))
    if (!(await stat(source)).isDirectory()) throw failure()
    const commonDir = await this.gitPath(source, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    const bare = (await this.git(source, ['rev-parse', '--is-bare-repository'])).trim()
    if (bare !== 'true' && bare !== 'false') throw failure()
    return { root: bare === 'true' ? source : await this.gitPath(source, ['rev-parse', '--show-toplevel']), commonDir }
  }

  private async registry(root: string): Promise<Registry> {
    const repo = await this.repository(root)
    const records = parseWorktrees(await this.git(repo.root, ['worktree', 'list', '--porcelain', '-z']))
    if (records.length > 4096) throw new Error('worktree가 4096개를 넘어서 전체 상태를 확인할 수 없어요. 정리를 실행하지 않아요.')
    const entries: ManagedWorktree[] = []
    for (const record of records) {
      const entry: ManagedWorktree = {
        ...record, path: await canonicalLoose(record.path), commonDir: repo.commonDir,
        dirty: false, untracked: false, ignored: false, used: false, nested: false,
        unsafeIndex: false, statusKnown: false, canOpen: false, removable: false, reasons: [],
      }
      if (record.primary) entry.reasons.push('기본 worktree는 정리할 수 없어요')
      if (record.bare) entry.reasons.push('bare 저장소는 정리할 수 없어요')
      if (record.locked) entry.reasons.push('잠긴 worktree예요')
      if (record.prunable) entry.reasons.push('경로가 없거나 등록을 복구해야 해요')
      if (record.unknownAttributes.length) entry.reasons.push('모르는 Git 속성이 있어 상태를 확인해야 해요')
      try {
        if ((await lstat(record.path)).isSymbolicLink()) throw new Error('링크로 바뀐 경로')
        if (!(await stat(entry.path)).isDirectory()) throw new Error('폴더가 아님')
      } catch { entry.reasons.push('원래 폴더를 확인하지 못했어요') }
      entries.push(entry)
    }
    for (const entry of entries) {
      entry.nested = entries.some((other) => other !== entry && inside(entry.path, other.path)) || inside(entry.path, repo.commonDir)
      if (entry.nested) entry.reasons.push('다른 worktree나 공유 Git 정보가 이 폴더 안에 있어요')
      if (entries.some((other) => other !== entry && other.path === entry.path)) entry.reasons.push('여러 등록이 같은 실제 경로를 가리켜요')
    }
    return { ...repo, entries }
  }

  private async used(entry: ManagedWorktree, paths: readonly string[]): Promise<boolean> {
    for (const path of paths) if (inside(entry.path, await canonicalLoose(path))) return true
    return false
  }

  private async inspect(entry: ManagedWorktree, usedCwds: readonly string[]): Promise<void> {
    try {
      entry.used = await this.used(entry, usedCwds)
      if (entry.used) entry.reasons.push('이 앱의 일감이나 pane이 이 폴더를 사용 중이에요')
      if (entry.bare || entry.prunable || entry.path === entry.commonDir || entry.reasons.includes('원래 폴더를 확인하지 못했어요')) return
      const owner = await this.gitPath(entry.path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
      if (owner !== entry.commonDir) throw new Error('다른 저장소')
      const [statusText, indexText, sparse] = await Promise.all([
        this.git(entry.path, ['-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=traditional', '--ignore-submodules=none']),
        this.git(entry.path, ['ls-files', '-v', '-z']),
        this.run(entry.path, ['config', '--bool', '--get', 'core.sparseCheckout']),
      ])
      if (statusText && !statusText.endsWith('\0')) throw failure()
      entry.untracked = statusText.split('\0').some((line) => line.startsWith('?? '))
      entry.ignored = statusText.split('\0').some((line) => line.startsWith('!! '))
      entry.dirty = statusText.length > 0 && !statusText.split('\0').filter(Boolean).every((line) => line.startsWith('?? ') || line.startsWith('!! '))
      if ((indexText && !indexText.endsWith('\0')) || indexText.split('\0').filter(Boolean).some((line) => line.length < 3 || line[1] !== ' ')) throw failure()
      if (sparse.timedOut || sparse.truncated || ![0, 1].includes(sparse.code) ||
        (sparse.code === 0 && !['true', 'false'].includes(sparse.stdout.trim())) || (sparse.code === 1 && sparse.stdout)) throw failure()
      entry.unsafeIndex = sparse.stdout.trim() === 'true' || indexText.split('\0').some((line) => line[0] === 'S' || /^[a-z]/.test(line))
      entry.statusKnown = true
      entry.canOpen = true
      if (entry.dirty) entry.reasons.push('추적 파일에 변경이 있어요')
      if (entry.untracked) entry.reasons.push('추적하지 않는 파일이 있어요')
      if (entry.ignored) entry.reasons.push('Git이 무시하는 파일도 보존해야 해요')
      if (entry.unsafeIndex) entry.reasons.push('sparse·skip-worktree·assume-unchanged 상태라 정리하지 않아요')
      entry.removable = entry.reasons.length === 0 && !statusText
    } catch { entry.reasons.push('상태 미확인 — 정리할 수 없어요'); entry.removable = false }
  }

  async list(root: string, usedCwds: readonly string[] = []): Promise<WorktreeView> {
    const registry = await this.registry(root)
    // Keep every entry for nesting and ownership decisions; never truncate the safety registry.
    const deadline = Date.now() + 15_000
    let cursor = 0
    await Promise.all(Array.from({ length: Math.min(4, registry.entries.length) }, async () => {
      while (cursor < registry.entries.length) {
        const entry = registry.entries[cursor++]
        if (Date.now() >= deadline) entry.reasons.push('전체 조회 시간 제한 — 새로 읽어 주세요')
        else await this.inspect(entry, usedCwds)
      }
    }))
    return registry
  }

  private find(registry: Registry, target: WorktreeSnapshot): ManagedWorktree {
    const row = registry.entries.find((entry) => sameTarget(entry, target))
    if (!row || registry.commonDir !== target.commonDir) throw new Error('확인한 경로·브랜치·HEAD가 바뀌었어요. 목록을 다시 읽어 주세요.')
    return row
  }

  async open(root: string, target: WorktreeSnapshot): Promise<{ path: string }> {
    validateTarget(target)
    const entry = this.find(await this.registry(root), target)
    await this.inspect(entry, [])
    if (!entry.canOpen || entry.bare || entry.prunable || entry.unknownAttributes.length) throw new Error('이 checkout을 열 수 없어요. 경로와 등록을 확인해 주세요.')
    return { path: entry.path }
  }

  async create(root: string, input: CreateWorktree): Promise<WorktreeCreateResult> {
    this.writable()
    if (!input || typeof input.requestId !== 'string' || !/^[\w-]{1,100}$/.test(input.requestId) ||
      typeof input.branch !== 'string' || !input.branch || input.branch.length > 100 || /[\s\0]/.test(input.branch) || input.branch.startsWith('-') ||
      typeof input.base !== 'string' || !input.base.trim() || input.base.length > 256 || input.base.includes('\0')) throw new Error('요청 번호·브랜치·기준 커밋을 확인해 주세요')
    const path = await canonicalLoose(absolutePath(input.path))
    const initial = await this.repository(root)
    return locked(initial.commonDir, async () => {
      this.writable()
      const registry = await this.registry(root)
      if (registry.commonDir !== initial.commonDir) throw new Error('원본 저장소가 바뀌었어요')
      const previous = this.readJournal().creates.find((receipt) => receipt.requestId === input.requestId)
      if (previous) {
        if (previous.commonDir !== registry.commonDir || previous.path !== path || previous.branch !== input.branch || previous.base !== input.base) throw new Error('다른 요청에 이미 사용한 번호예요')
        return this.reconcileCreate(registry.root, previous, true)
      }
      if (!await absent(path) || registry.entries.some((entry) => inside(path, entry.path)) || inside(registry.commonDir, path) || inside(path, registry.commonDir)) throw new Error('이미 있거나 Git 정보와 겹치는 경로예요')
      if ((await this.git(registry.root, ['check-ref-format', '--branch', input.branch])).trim() !== input.branch) throw new Error('브랜치 이름을 확인해 주세요')
      const baseOid = (await this.git(registry.root, ['rev-parse', '--verify', '--end-of-options', input.base + '^{commit}'])).trim()
      if (!isWorktreeOid(baseOid)) throw new Error('기준 커밋을 확인하지 못했어요')
      const receipt: WorktreeCreateReceipt = {
        requestId: input.requestId, branch: input.branch, base: input.base,
        path, commonDir: registry.commonDir, baseOid, state: 'pending',
      }
      this.record(receipt) // Must succeed before git can create a branch or directory.
      try { await this.run(registry.root, ['worktree', 'add', '-b', input.branch, '--', path, baseOid]) }
      catch { /* A killed process or lost reply can still have created the checkout. */ }
      return this.reconcileCreate(registry.root, receipt, false)
    })
  }

  private async reconcileCreate(root: string, receipt: WorktreeCreateReceipt, existing: boolean): Promise<WorktreeCreateResult> {
    let state: WorktreeCreateResult['state'] = 'unknown'
    try {
      const registry = await this.registry(root)
      const row = registry.entries.find((entry) => entry.path === receipt.path)
      if (registry.commonDir === receipt.commonDir && row?.branch === 'refs/heads/' + receipt.branch && row.head === receipt.baseOid && !row.bare && !row.prunable) {
        const owner = await this.gitPath(row.path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
        const head = (await this.git(row.path, ['rev-parse', '--verify', 'HEAD'])).trim()
        if (owner === receipt.commonDir && head === receipt.baseOid) state = 'created'
      }
    } catch { /* Preserve pending/unknown and never blindly reissue worktree add. */ }
    try { this.record({ ...receipt, state }) }
    catch { state = 'unknown' }
    return {
      state, path: receipt.path, existing,
      message: state === 'created' ? '등록된 checkout과 기준 커밋을 확인했어요.' : '생성 결과를 확인해야 해요. 폴더·브랜치를 확인하기 전에는 같은 요청을 다시 실행하지 않아요.',
    }
  }

  async remove(root: string, confirmed: WorktreeSnapshot, usedCwds: readonly string[] = []): Promise<WorktreeRemoveResult> {
    this.writable()
    validateTarget(confirmed)
    const initial = await this.repository(root)
    return locked(initial.commonDir, async () => {
      this.writable()
      let registry = await this.registry(root)
      if (registry.commonDir !== initial.commonDir) throw new Error('원본 저장소가 바뀌었어요')
      let entry = this.find(registry, confirmed)
      const paths = [...usedCwds, registry.root, ...(await this.options.freshUsedCwds?.() ?? [])]
      await this.inspect(entry, paths)
      if (!entry.removable) throw new Error(entry.reasons.join(' · ') || '정리할 수 없는 worktree예요')
      // Repeat membership/HEAD/lock/nesting checks after the asynchronous status probes.
      registry = await this.registry(root)
      entry = this.find(registry, confirmed)
      const usedRevision = this.options.usedRevision?.()
      const finalPaths = [...usedCwds, registry.root, ...(await this.options.freshUsedCwds?.() ?? [])]
      const used = await this.used(entry, finalPaths)
      if (entry.reasons.length || used || usedRevision !== this.options.usedRevision?.()) throw new Error('대상이 바뀌었거나 앱이 사용 중이에요. 정리하지 않았어요.')
      // External writers are not fenced by this in-app mutex; Git repeats its ordinary clean check.
      try { await this.run(registry.root, ['worktree', 'remove', '--', entry.path]) }
      catch { /* Query real membership and filesystem state even when the command reply is lost. */ }
      return this.reconcileRemove(registry.root, entry.path)
    })
  }

  private async reconcileRemove(root: string, path: string): Promise<WorktreeRemoveResult> {
    try {
      const registered = (await this.registry(root)).entries.some((entry) => entry.path === path)
      const missing = await absent(path)
      if (!registered && missing) return { state: 'removed', path, message: '폴더와 worktree 등록이 제거된 것을 확인했어요. 브랜치는 보존했어요.' }
      if (registered && !missing) return { state: 'unchanged', path, message: 'worktree가 남아 있어요. 상태를 다시 확인해 주세요.' }
    } catch { /* An unavailable registry is an unknown result, not a successful deletion. */ }
    return { state: 'unknown', path, message: '정리 결과를 확인하지 못했어요. 등록과 폴더를 다시 확인해 주세요. 추가 삭제는 하지 않아요.' }
  }
}
