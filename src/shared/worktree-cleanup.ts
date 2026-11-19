// 67단계: 병합된 worktree 정리 — 병합 판정 · 후보 · 확인 흐름 · 실행 순서(순수, main 과 renderer 가 같이 쓴다)
import {
  WORKTREE_USED_REASON,
  type ManagedWorktree, type MergeInfo, type MergeState, type WorktreeCleanItem, type WorktreeCleanResult,
  type WorktreeSnapshot, type WorktreeView,
} from './worktree-management'

/** refs/heads/x · refs/remotes/<원격>/x → x */
export const shortRef = (ref: string): string => ref.replace(/^refs\/(?:heads|remotes\/[^/]+)\//, '')

export interface MergeInput {
  head: string | null
  branch: string | null
  primary: boolean
  bare: boolean
  base: { ref: string; oid: string } | null
  /** 브랜치 reflog 의 맨 처음 줄이 'branch: Created from …' 이면 그 커밋, 아니면(기록 없음 · 만료) null */
  created: string | null
  /** HEAD 가 기준의 조상인가 — 비교하지 못했으면 null */
  ancestor: boolean | null
}

/** 조상 검사만으로는 방금 만든(커밋 없는) worktree 도 '병합됨' 이 된다 — 만든 지점과 HEAD 가 같으면 fresh */
export function classifyMerge(i: MergeInput): MergeInfo | null {
  if (i.primary || i.bare) return null
  if (i.base && i.branch === 'refs/heads/' + shortRef(i.base.ref)) return null
  const base = i.base?.ref ?? null
  const unknown = (reason: string): MergeInfo => ({ state: 'unknown', base, reason })
  if (!i.base) return unknown('기준 브랜치(origin/HEAD · main · master)를 찾지 못했어요')
  if (!i.branch || !i.head) return unknown('분리된 HEAD라 브랜치 기록으로 확인할 수 없어요')
  if (i.ancestor === null) return unknown('기준 브랜치와 비교하지 못했어요')
  if (!i.ancestor) return unknown(`${shortRef(i.base.ref)}에 없는 커밋이 있어요 — squash·rebase로 병합됐는지는 알 수 없어요`)
  if (i.created === null) return unknown('브랜치를 만든 기록(reflog)이 없어 새로 만든 브랜치인지 알 수 없어요')
  if (i.created === i.head) return { state: 'fresh', base, reason: '만든 뒤 커밋이 없어요' }
  return { state: 'merged', base, reason: `${shortRef(i.base.ref)}에 들어 있어요` }
}

export const MERGE_LABEL: Record<MergeState, string | null> = { merged: '병합됨', unknown: '병합 모름', fresh: null }

export interface CleanupCandidate extends WorktreeSnapshot {
  label: string
  /** 정리와 함께 보관할 연결 일감(이미 보관한 것 포함) */
  tasks: Array<{ id: string; name: string; archived: boolean }>
  last?: { at: number; subject: string }
}
export interface CleanupExcluded { path: string; label: string; reason: string }
export interface CleanupPreview { candidates: CleanupCandidate[]; excluded: CleanupExcluded[]; unknown: number; fresh: number }

const branchLabel = (entry: Pick<ManagedWorktree, 'branch'>) => entry.branch?.replace(/^refs\/heads\//, '') ?? '분리된 HEAD'

/** 병합됨 + '사용 중' 말고는 정리할 수 있음 + 연결 일감이 모두 그 폴더의 일감이고 명령이 돌지 않을 때만 후보 */
export function cleanupPreview(view: WorktreeView, busy: (taskId: string) => boolean = () => false): CleanupPreview {
  const out: CleanupPreview = { candidates: [], excluded: [], unknown: 0, fresh: 0 }
  for (const entry of view.entries) {
    const merge = entry.merge
    if (!merge) continue
    if (merge.state === 'unknown') { out.unknown++; continue }
    if (merge.state === 'fresh') { out.fresh++; continue }
    const label = branchLabel(entry)
    const tasks = entry.tasks ?? []
    const reason = entry.current ? '이 패널을 연 일감의 폴더예요'
      : !entry.cleanable ? entry.reasons.filter((r) => r !== WORKTREE_USED_REASON).join(' · ') || '정리할 수 없는 상태예요'
      : tasks.some((t) => !t.own) ? '다른 폴더의 일감이 이 폴더에서 pane을 쓰고 있어요'
      : entry.used && tasks.length === 0 ? '앱에서 사용 중이에요(실행 중인 셸 · 여는 중인 pane)'
      : tasks.some((t) => busy(t.id)) ? '연결 일감에서 명령이 돌고 있어요'
      : ''
    if (reason) { out.excluded.push({ path: entry.path, label, reason }); continue }
    out.candidates.push({
      path: entry.path, commonDir: entry.commonDir, head: entry.head, branch: entry.branch, label,
      tasks: tasks.map((t) => ({ id: t.id, name: t.name, archived: !!t.archived })),
      ...(merge.last ? { last: { ...merge.last } } : {}),
    })
  }
  return out
}

/** 연결 일감 카드(사이드바 · 전체 보기)의 칩 — 일감 폴더가 그 worktree 안인 일감만, 그때의 브랜치와 함께 */
export interface MergeBadge { state: 'merged' | 'unknown'; branch: string | null; reason: string }
export function mergeBadges(view: WorktreeView): Record<string, MergeBadge | null> {
  const out: Record<string, MergeBadge | null> = {}
  for (const entry of view.entries) {
    for (const task of entry.tasks ?? []) {
      if (!task.own) continue
      const m = entry.merge
      out[task.id] = m && m.state !== 'fresh' ? { state: m.state, branch: entry.branch?.replace(/^refs\/heads\//, '') ?? null, reason: m.reason } : null
    }
  }
  return out
}
/** 지금 브랜치(15c 파일 읽기)가 패널에서 읽은 때와 다르면 숨긴다 — 칩은 보기만, 정리는 늘 다시 읽는다 */
export const shownBadge = (badge: MergeBadge | null | undefined, branchNow: string | null | undefined): MergeBadge | null =>
  badge && badge.branch !== null && badge.branch === branchNow ? badge : null

// ─── 확인 흐름: 고르기 → 확인 대화상자(연 순간의 사본) → confirm 일 때만 실행 ───
export type CleanupFlow =
  | { kind: 'idle' }
  | { kind: 'preview'; picked: string[] }
  | { kind: 'asking'; items: CleanupCandidate[] }
  | { kind: 'running'; items: CleanupCandidate[] }
export type CleanupAction =
  | { type: 'open' }
  | { type: 'close' }
  | { type: 'toggle'; path: string }
  | { type: 'ask'; candidates: CleanupCandidate[] }
  | { type: 'cancel' }
  | { type: 'confirm' }
  | { type: 'done' }

const copy = (c: CleanupCandidate): CleanupCandidate => ({ ...c, tasks: c.tasks.map((t) => ({ ...t })), ...(c.last ? { last: { ...c.last } } : {}) })

export function cleanupStep(flow: CleanupFlow, action: CleanupAction): { flow: CleanupFlow; run?: CleanupCandidate[] } {
  switch (action.type) {
    case 'open': return { flow: flow.kind === 'idle' ? { kind: 'preview', picked: [] } : flow }
    case 'close': return { flow: flow.kind === 'running' ? flow : { kind: 'idle' } }
    case 'toggle':
      if (flow.kind !== 'preview') return { flow }
      return { flow: { kind: 'preview', picked: flow.picked.includes(action.path) ? flow.picked.filter((p) => p !== action.path) : [...flow.picked, action.path] } }
    case 'ask': {
      if (flow.kind !== 'preview') return { flow }
      const items = action.candidates.filter((c) => flow.picked.includes(c.path)).map(copy)
      return { flow: items.length ? { kind: 'asking', items } : flow }
    }
    case 'cancel': return { flow: flow.kind === 'asking' ? { kind: 'preview', picked: flow.items.map((c) => c.path) } : flow }
    case 'confirm':
      if (flow.kind !== 'asking') return { flow }
      return { flow: { kind: 'running', items: flow.items }, run: flow.items.map(copy) }
    case 'done': return { flow: flow.kind === 'running' ? { kind: 'idle' } : flow }
  }
}

// ─── 실행: 다시 읽기 → 같은 것만 → 연결 일감 보관 → main 에서 줄마다 다시 찾고 지우기 ───
export interface CleanupDeps {
  list(root: string): Promise<WorktreeView>
  busy(taskId: string): boolean
  /** 보관하고(셸을 끄고 상태를 main 에 먼저 보낸 뒤) 지금 보관 상태인 id 를 돌려준다 */
  archive(taskIds: string[]): string[] | Promise<string[]>
  clean(root: string, items: WorktreeCleanItem[]): Promise<WorktreeCleanResult[]>
}
export interface CleanupReportRow {
  path: string
  label: string
  state: WorktreeCleanResult['state']
  message: string
  /** 이 줄 때문에 보관 상태가 된 연결 일감 이름 */
  archived: string[]
}

const sameSnapshot = (a: WorktreeSnapshot, b: WorktreeSnapshot) => a.path === b.path && a.commonDir === b.commonDir && a.head === b.head && a.branch === b.branch
const sameTasks = (a: CleanupCandidate['tasks'], b: CleanupCandidate['tasks']) => {
  const x = a.map((t) => t.id).sort(), y = b.map((t) => t.id).sort()
  return x.length === y.length && x.every((id, i) => id === y[i])
}

export async function runCleanup(root: string, confirmed: readonly CleanupCandidate[], deps: CleanupDeps): Promise<CleanupReportRow[]> {
  const fresh = cleanupPreview(await deps.list(root), deps.busy)
  const rows: CleanupReportRow[] = []
  const go: CleanupCandidate[] = []
  for (const item of confirmed) {
    const now = fresh.candidates.find((c) => sameSnapshot(c, item))
    const skip = !now ? '확인한 뒤 경로·브랜치·HEAD가 바뀌었거나 더 이상 정리 후보가 아니에요. 정리하지 않았어요.'
      : !sameTasks(now.tasks, item.tasks) ? '확인한 뒤 연결 일감이 바뀌었어요. 정리하지 않았어요.' : ''
    if (skip) rows.push({ path: item.path, label: item.label, state: 'skipped', message: skip, archived: [] })
    else go.push(now!)
  }
  if (!go.length) return rows
  const wanted = [...new Set(go.flatMap((c) => c.tasks.map((t) => t.id)))]
  const archived = new Set(wanted.length ? await deps.archive(wanted) : [])
  const items: WorktreeCleanItem[] = []
  const started: CleanupCandidate[] = []
  for (const c of go) {
    if (c.tasks.some((t) => !archived.has(t.id))) {
      rows.push({ path: c.path, label: c.label, state: 'skipped', message: '연결 일감을 보관하지 못해 정리하지 않았어요.', archived: c.tasks.filter((t) => archived.has(t.id)).map((t) => t.name) })
      continue
    }
    items.push({ target: { path: c.path, commonDir: c.commonDir, head: c.head, branch: c.branch }, taskIds: c.tasks.map((t) => t.id) })
    started.push(c)
  }
  if (!items.length) return rows
  let results: WorktreeCleanResult[] | null = null
  try { results = await deps.clean(root, items) } catch { results = null }
  started.forEach((c, i) => {
    const r = results?.[i]
    const names = c.tasks.filter((t) => !t.archived).map((t) => t.name)
    rows.push(r && r.path === c.path
      ? { path: c.path, label: c.label, state: r.state, message: r.message, archived: names }
      : { path: c.path, label: c.label, state: 'unknown', message: '정리 결과를 확인하지 못했어요. 목록을 다시 읽어 확인해 주세요.', archived: names })
  })
  return rows
}

/** main 의 사용 경로 — 이 정리를 위해 **보관 상태인** 그 일감들의 저장된 폴더만 뺀다. 보관 안 된 일감 · 다른 보관 일감 · 원격은 39 그대로 */
export function usedTaskPaths(tasks: ReadonlyArray<{ id: string; host?: string; archivedAt?: number; cwd: string; panes: Record<string, { cwd: string }> }>, exclude: readonly string[]): string[] {
  const skip = new Set(exclude)
  return tasks.filter((t) => !t.host && !(skip.has(t.id) && t.archivedAt !== undefined))
    .flatMap((t) => [t.cwd, ...Object.values(t.panes).map((p) => p.cwd)])
}
