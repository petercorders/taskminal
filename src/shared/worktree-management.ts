export interface WorktreeSnapshot {
  path: string
  commonDir: string
  head: string | null
  branch: string | null
}

export interface WorktreeRecord {
  path: string
  head: string | null
  branch: string | null
  primary: boolean
  bare: boolean
  locked: boolean
  prunable: boolean
  lockedReason?: string
  prunableReason?: string
  unknownAttributes: string[]
}

export interface ManagedWorktree extends WorktreeRecord, WorktreeSnapshot {
  dirty: boolean
  untracked: boolean
  ignored: boolean
  used: boolean
  nested: boolean
  unsafeIndex: boolean
  statusKnown: boolean
  canOpen: boolean
  removable: boolean
  reasons: string[]
  tasks?: Array<{ id: string; name: string }>
}

export interface WorktreeView {
  root: string
  commonDir: string
  entries: ManagedWorktree[]
}

export interface CreateWorktree {
  requestId: string
  branch: string
  base: string
  path: string
}

export interface WorktreeCreateReceipt extends CreateWorktree {
  commonDir: string
  baseOid: string
  state: 'pending' | 'created' | 'unknown' | 'failed'
}

export interface WorktreeJournalState {
  version: 1
  creates: WorktreeCreateReceipt[]
}

export interface WorktreeCreateResult {
  state: 'created' | 'unknown' | 'failed'
  path: string
  existing: boolean
  message: string
}

export interface WorktreeRemoveResult {
  state: 'removed' | 'unchanged' | 'unknown'
  path: string
  message: string
}

export interface WorktreeApi {
  list(root: string): Promise<WorktreeView>
  create(root: string, input: CreateWorktree): Promise<WorktreeCreateResult>
  open(root: string, target: WorktreeSnapshot): Promise<{ path: string; taskId?: string; cwd?: string }>
  remove(root: string, target: WorktreeSnapshot): Promise<WorktreeRemoveResult>
}

export const isWorktreeOid = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)

const pathText = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('/') && value.length <= 4096 && !value.includes('\0')

export function validWorktreeJournal(value: unknown): value is WorktreeJournalState {
  if (!value || typeof value !== 'object') return false
  const state = value as WorktreeJournalState
  if (state.version !== 1 || !Array.isArray(state.creates) || state.creates.length > 1000) return false
  const seen = new Set<string>()
  return state.creates.every((receipt) => {
    if (!receipt || typeof receipt !== 'object' || typeof receipt.requestId !== 'string' ||
      !/^[\w-]{1,100}$/.test(receipt.requestId) || seen.has(receipt.requestId)) return false
    seen.add(receipt.requestId)
    return pathText(receipt.path) && pathText(receipt.commonDir) &&
      typeof receipt.branch === 'string' && receipt.branch.length > 0 && receipt.branch.length <= 100 &&
      typeof receipt.base === 'string' && receipt.base.length > 0 && receipt.base.length <= 256 &&
      !receipt.base.includes('\0') && isWorktreeOid(receipt.baseOid) &&
      ['pending', 'created', 'unknown', 'failed'].includes(receipt.state)
  })
}

/** NUL-separated fields, with an empty field terminating each worktree record. */
export function parseWorktrees(raw: string): WorktreeRecord[] {
  if (!raw || !raw.endsWith('\0\0')) throw new Error('worktree 목록이 잘렸어요')
  const paths = new Set<string>()
  return raw.slice(0, -2).split('\0\0').map((block, index) => {
    const fields = block.split('\0')
    if (!fields[0].startsWith('worktree ') || fields.some((field) => !field)) throw new Error('worktree 목록 형식')
    const values = new Map<string, string | undefined>()
    for (const field of fields) {
      const space = field.indexOf(' ')
      const key = space < 0 ? field : field.slice(0, space)
      if (!key || values.has(key)) throw new Error('중복된 worktree 속성')
      values.set(key, space < 0 ? undefined : field.slice(space + 1))
    }
    const path = values.get('worktree')
    const bare = values.has('bare')
    const head = values.get('HEAD') ?? null
    const branch = values.get('branch') ?? null
    if (!pathText(path) || paths.has(path) || (!bare && !isWorktreeOid(head)) ||
      (bare && (head !== null || branch !== null || values.has('detached'))) ||
      (!bare && (values.has('detached') === (branch !== null))) ||
      (branch !== null && (!branch.startsWith('refs/heads/') || branch.length > 4096)) ||
      ['bare', 'detached'].some((key) => values.has(key) && values.get(key) !== undefined)) {
      throw new Error('worktree 경로·HEAD·브랜치를 확인하지 못했어요')
    }
    paths.add(path)
    const known = new Set(['worktree', 'HEAD', 'branch', 'bare', 'detached', 'locked', 'prunable'])
    return {
      path, head, branch, primary: index === 0, bare,
      locked: values.has('locked'), prunable: values.has('prunable'),
      lockedReason: values.get('locked'), prunableReason: values.get('prunable'),
      unknownAttributes: [...values.keys()].filter((key) => !known.has(key)),
    }
  })
}
