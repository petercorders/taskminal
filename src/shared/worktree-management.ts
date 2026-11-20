import { isAbsolutePath } from './platform'

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

/** 67단계: 병합 판정 — merged(기준 브랜치의 조상이고 만든 뒤 커밋이 있었다) · unknown(기준 없음 · 조상 아님(squash 일 수도) · 기록 없음) · fresh(만든 뒤 커밋 없음) */
export type MergeState = 'merged' | 'unknown' | 'fresh'
export interface MergeInfo {
  state: MergeState
  /** 판정에 쓴 기준 ref(예: refs/remotes/origin/main) — 못 찾았으면 null */
  base: string | null
  reason: string
  /** 병합됨일 때만 — HEAD 커밋 시각(ms) · 제목(200자) */
  last?: { at: number; subject: string }
}

/** 39 의 '사용 중' 이유 — 67 정리 후보는 이 이유만 빼고 정리할 수 있는지 본다 */
export const WORKTREE_USED_REASON = '이 앱의 일감이나 pane이 이 폴더를 사용 중이에요'

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
  /** own: 일감 폴더가 이 worktree 안(아니면 pane 만) · archived: 보관한 일감 (67단계) */
  tasks?: Array<{ id: string; name: string; own?: boolean; archived?: boolean }>
  /** 67단계: '사용 중' 만 빼면 정리할 수 있다(변경 · 미추적 · 무시 · 잠금 · 기본 · 중첩 · 상태 미확인이 없다) */
  cleanable?: boolean
  /** 67단계: 패널을 연 저장소 뿌리를 담은 worktree */
  current?: boolean
  /** 67단계: 기본 · bare · 기준 브랜치 자신이면 null, 조회 시간 제한이면 없음 */
  merge?: MergeInfo | null
}

export interface WorktreeView {
  root: string
  commonDir: string
  entries: ManagedWorktree[]
}

/** 56단계: 환경 준비 대상 고르기용 — 워크트리마다 상태를 조사하지 않고 등록 목록만 */
export interface WorktreeTargets {
  root: string
  entries: Array<Pick<ManagedWorktree, 'path' | 'commonDir' | 'primary' | 'bare' | 'prunable'>>
}

/** 환경 준비로 채울 수 있는 워크트리 — 일감 폴더 자신 · bare · 등록 복구 필요 · 따로 둔 git 폴더(separate-git-dir 의 기본 항목)는 뺀다.
 *  일감이 링크된 워크트리에 있으면 기본 워크트리도 대상이다. */
export const prepareTarget = (entry: Pick<ManagedWorktree, 'path' | 'commonDir' | 'bare' | 'prunable'>, root: string): boolean =>
  entry.path !== root && entry.path !== entry.commonDir && !entry.bare && !entry.prunable

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
  /** 62단계: 만들기를 요청한 일감 폴더에 환경 설정(.taskminal/environment.json)이 있다 — 워크트리 관리 패널의 만들기 답에만, 있을 때만 실린다 */
  environment?: boolean
}

/** 62단계: 워크트리를 만든 직후 환경 준비 미리보기로 이어 갈 대상 — 만든 것이 확인됐고(created) 환경 설정이 있을 때만.
 *  결과를 모르거나 실패했으면 없는 폴더를 준비하게 되므로 잇지 않는다. 같은 요청을 다시 보내 확인된 것(existing)도 만든 흐름의 끝이라 잇는다 */
export const prepareAfterCreate = (result: Pick<WorktreeCreateResult, 'state' | 'path' | 'environment'>): string | null =>
  result.state === 'created' && result.environment === true ? result.path : null

export interface WorktreeRemoveResult {
  state: 'removed' | 'unchanged' | 'unknown'
  path: string
  message: string
}

/** 67단계: 병합된 것 정리 — 고른 대상(확인한 사본)과 그 대상을 위해 보관한 연결 일감 */
export interface WorktreeCleanItem {
  target: WorktreeSnapshot
  taskIds: string[]
}
export interface WorktreeCleanResult {
  state: 'removed' | 'unchanged' | 'unknown' | 'skipped'
  path: string
  message: string
}

export interface WorktreeApi {
  compare(root: string, input: import("./worktree-comparison").WorktreeComparisonRequest): Promise<import("./worktree-comparison").WorktreeComparison>
  list(root: string): Promise<WorktreeView>
  targets(root: string): Promise<WorktreeTargets>
  create(root: string, input: CreateWorktree): Promise<WorktreeCreateResult>
  open(root: string, target: WorktreeSnapshot): Promise<{ path: string; taskId?: string; cwd?: string }>
  remove(root: string, target: WorktreeSnapshot): Promise<WorktreeRemoveResult>
  clean(root: string, items: WorktreeCleanItem[]): Promise<WorktreeCleanResult[]>
}

/** 39 '일감으로 열기' 의 조건 — 상태를 확인했고(canOpen) bare · 등록 복구 필요 · 모르는 속성이 아니다. 70 가져오기가 같은 조건을 쓴다 */
export const openable = (entry: Pick<ManagedWorktree, 'canOpen' | 'bare' | 'prunable' | 'unknownAttributes'>): boolean =>
  entry.canOpen && !entry.bare && !entry.prunable && entry.unknownAttributes.length === 0

/** 확인한 대상과 같은 줄인가 — 경로 · 공유 Git 정보 · HEAD · 브랜치가 모두 같아야 한다 */
export const sameTarget = (a: WorktreeSnapshot, b: WorktreeSnapshot): boolean =>
  a.path === b.path && a.commonDir === b.commonDir && a.head === b.head && a.branch === b.branch

export const isWorktreeOid = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)

const pathText = (value: unknown): value is string =>
  typeof value === 'string' && isAbsolutePath(value) && value.length <= 4096 && !value.includes('\0')

// 생성 요청의 모양 — 39 화면 · 기록 파일 · 69 CLI 위임이 같은 규칙을 쓴다(69 리뷰)
export const isWorktreeRequestId = (v: unknown): v is string => typeof v === 'string' && /^[\w-]{1,100}$/.test(v)
export const isWorktreeBranchText = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 100 && !/[\s\0]/.test(v) && !v.startsWith('-')
export const isWorktreeBase = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 256 && !v.includes('\0')
export const isWorktreePathText = pathText

export function validWorktreeJournal(value: unknown): value is WorktreeJournalState {
  if (!value || typeof value !== 'object') return false
  const state = value as WorktreeJournalState
  if (state.version !== 1 || !Array.isArray(state.creates) || state.creates.length > 1000) return false
  const seen = new Set<string>()
  return state.creates.every((receipt) => {
    if (!receipt || typeof receipt !== 'object' || !isWorktreeRequestId(receipt.requestId) || seen.has(receipt.requestId)) return false
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
