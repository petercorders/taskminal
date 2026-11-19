// 70단계: 저장소째 옮겨 오기 — 미리보기 줄 · 세션 배정 · 묶음 · 다시 읽은 뒤 계획 · 일감 만들기(순수, main 과 renderer 가 같이 쓴다).
// 발견은 git 만(39 `worktree list --porcelain -z` · `list()`), 세션은 53 의 읽기. 다른 도구의 내부 파일은 보지 않는다.
import type { ChatAgent } from './chat'
import { expandHome } from './cwd'
import { createTask, type NewId } from './model'
import { pathInside } from './platform'
import type { AppState, Group, Id, SessionHint, Task } from './types'
import { openable, type ManagedWorktree, type MergeInfo, type WorktreeView } from './worktree-management'

/** 한 번에 만드는 일감 수 */
export const IMPORT_MAX = 100

export interface ImportRow {
  path: string
  commonDir: string
  head: string | null
  branch: string | null
  /** 줄 제목 — 브랜치 · 분리된 HEAD · bare 저장소 */
  label: string
  /** 만들 일감 이름 — 브랜치, 분리된 HEAD 면 폴더 이름 */
  name: string
  primary: boolean
  locked: boolean
  /** 67 의 병합 판정 — 기본 · bare 는 null */
  merge: MergeInfo | null
  /** 39 '일감으로 열기' 신원 검사 — 이 폴더를 일감 폴더로 쓰는 보관 안 된 로컬 일감 */
  existing: { taskId: string; name: string } | null
  /** 이 폴더 안쪽(더 안쪽 worktree 는 빼고)을 일감 폴더로 쓰는 일감 — 가져올 수는 있지만 기본으로 고르지 않는다(리뷰 6) */
  nearby: { taskId: string; name: string } | null
  /** 가져올 수 없는 이유 — null 이면 가져올 수 있다 */
  blocked: string | null
  /** 이 폴더(와 그 안쪽, 더 안쪽 worktree 는 빼고)의 최근 세션 — 에이전트마다 하나 */
  sessions: SessionHint[]
}

export interface ImportPreview {
  root: string
  commonDir: string
  /** 저장소 이름 — 묶음 이름 */
  repo: string
  /** renderer 가 일감 폴더의 '~' 를 펴는 데 쓴다 */
  home: string
  rows: ImportRow[]
  /** 53 세션 기록을 읽지 못했으면 — 세션 후보 없이 미리보기 */
  sessionsNote?: string
}

export interface RepoImportApi {
  /** main 이 폴더 고르기 대화상자를 연다 — 고른 폴더(realpath)는 미리보기 권한 목록에 오른다. 취소면 null */
  pick(): Promise<string | null>
  preview(root: string): Promise<ImportPreview>
}

const lastName = (path: string) => path.replace(/\/+$/, '').split('/').filter(Boolean).at(-1) ?? ''
const shortBranch = (branch: string | null) => branch?.replace(/^refs\/heads\//, '') ?? null

/** 기본 worktree 폴더 이름(bare 면 `.git` 을 뺀 이름) — 못 정하면 '저장소' */
export function repoName(view: Pick<WorktreeView, 'root' | 'entries'>): string {
  const primary = view.entries.find((e) => e.primary)
  const name = lastName(primary?.path ?? view.root).replace(/\.git$/, '').trim()
  return name || '저장소'
}

function blockedReason(entry: ManagedWorktree): string | null {
  if (openable(entry)) return null
  if (entry.bare) return 'bare 저장소라 작업 폴더가 없어요'
  if (entry.prunable) return `폴더가 없거나 등록을 복구해야 해요${entry.prunableReason ? ` — ${entry.prunableReason}` : ''}`
  if (entry.path === entry.commonDir) return 'Git 정보 폴더예요'
  if (entry.unknownAttributes.length) return '모르는 Git 속성이 있어 상태를 확인해야 해요'
  // 39 list() 의 15초 한도 — 바뀐 것이 아니라 확인을 못 한 것(리뷰 2)
  if (entry.reasons.some((r) => r.startsWith('전체 조회 시간 제한'))) return '저장소가 커서 시간 안에 상태를 확인하지 못했어요 — 다시 읽어 주세요'
  return '폴더 · 상태를 확인하지 못했어요 — 다시 읽어 주세요'
}

type Owner = { taskId: string; name: string }
/** 등록 목록 → 미리보기 줄. existing 은 39 신원 검사(main), nearby 는 안쪽 폴더의 일감, sessions 는 assignSessions 결과 */
export function importRows(
  view: WorktreeView,
  existing: (path: string) => Owner | null,
  sessions: ReadonlyMap<string, SessionHint[]>,
  nearby: (path: string) => Owner | null = () => null,
): ImportRow[] {
  return view.entries.map((entry) => {
    const branch = shortBranch(entry.branch)
    const blocked = blockedReason(entry)
    return {
      path: entry.path, commonDir: entry.commonDir, head: entry.head, branch: entry.branch,
      label: entry.bare ? 'bare 저장소' : branch ?? '분리된 HEAD',
      name: branch ?? (lastName(entry.path) || 'checkout'),
      primary: entry.primary, locked: entry.locked, merge: entry.merge ?? null,
      existing: blocked ? null : existing(entry.path),
      nearby: blocked ? null : nearby(entry.path),
      blocked,
      sessions: blocked ? [] : (sessions.get(entry.path) ?? []).map((h) => ({ ...h })),
    }
  })
}

/** p 를 담은 가장 깊은 폴더 — 같은 폴더 · 하위 폴더만(`/x/app` 과 `/x/app-2` 는 다름), 안쪽 worktree 것은 안쪽으로 */
export function deepestFolder(folders: readonly string[], p: string): string | null {
  let best: string | null = null
  for (const f of folders) if (pathInside(f, p) && (best === null || f.length > best.length)) best = f
  return best
}

export interface SessionLike { agent: ChatAgent; id: string; summary: string; updatedAt: number; cwd: string }

/**
 * 세션 → 그 cwd 를 담은 **가장 깊은** worktree(같은 폴더 · 하위 폴더만, `/x/app` 과 `/x/app-2` 는 다름 · 안쪽 worktree 의 세션은 바깥에 안 감).
 * worktree 마다 에이전트별 최신 하나. cwd 와 경로는 같은 꼴(main 이 realpath)이어야 한다.
 */
export function assignSessions(sessions: readonly SessionLike[], paths: readonly string[]): Map<string, SessionHint[]> {
  const best = new Map<string, Map<ChatAgent, SessionLike>>()
  for (const s of sessions) {
    const at = deepestFolder(paths, s.cwd)
    if (!at) continue
    const byAgent = best.get(at) ?? new Map<ChatAgent, SessionLike>()
    const old = byAgent.get(s.agent)
    if (!old || s.updatedAt > old.updatedAt || (s.updatedAt === old.updatedAt && s.id > old.id)) byAgent.set(s.agent, s)
    best.set(at, byAgent)
  }
  const out = new Map<string, SessionHint[]>()
  for (const [path, byAgent] of best) {
    out.set(path, [...byAgent.values()].sort((a, b) => b.updatedAt - a.updatedAt)
      .map((s) => ({ agent: s.agent, id: s.id, summary: s.summary, at: s.updatedAt })))
  }
  return out
}

type TaskLike = Pick<Task, 'id' | 'name' | 'cwd' | 'host' | 'archivedAt'>
const folderOf = (cwd: string, home: string) => {
  const p = expandHome(cwd.trim(), home)
  return p.length > 1 ? p.replace(/\/+$/, '') : p
}

/** renderer 의 지금 상태에서 같은 폴더(문자 그대로 · '~' 편 것)의 보관 안 된 로컬 일감 — main 이 본 뒤에 생긴 일감을 거른다 */
export function sameFolderTask(tasks: readonly TaskLike[], path: string, home: string): TaskLike | null {
  return tasks.find((t) => !t.host && t.archivedAt === undefined && folderOf(t.cwd, home) === path) ?? null
}

/**
 * 묶음 — 저장소 이름과 같은 이름(공백 · 대소문자 무시)의 묶음이 비었거나 이 저장소 worktree 안 폴더의 일감만 들고 있으면 그 묶음,
 * 아니면 `이름 (2)` · `(3)` … 중 처음으로 쓸 수 있는(없거나 이 저장소 것) 이름.
 */
export function importGroup(
  state: { settings: { groups: readonly Group[] }; tasks: ReadonlyArray<TaskLike & Pick<Task, 'groupId'>> },
  repo: string, paths: readonly string[], home: string,
): { reuse: Id } | { create: string } {
  const base = repo.trim() || '저장소'
  const ours = (g: Group) => state.tasks.filter((t) => t.groupId === g.id)
    .every((t) => !t.host && paths.some((p) => pathInside(p, folderOf(t.cwd, home))))
  for (let n = 1; n <= 1000; n++) {
    const name = n === 1 ? base : `${base} (${n})`
    const same = state.settings.groups.filter((g) => g.name.trim().toLowerCase() === name.toLowerCase())
    if (same.length === 0) return { create: name }
    const hit = same.find(ours)
    if (hit) return { reuse: hit.id }
  }
  return { create: `${base} (${Date.now()})` }
}

export interface ImportPick { path: string; commonDir: string; label: string }
export interface ImportSkip { path: string; label: string; reason: string }

/** 누른 순간의 사본(경로 · commonDir)을 다시 읽은 목록과 지금 상태에 맞춰 — 사라짐 · 막힘 · 이미 일감은 만들지 않는다 */
export function importPlan(picked: readonly ImportPick[], fresh: ImportPreview, tasks: readonly TaskLike[]): { create: ImportRow[]; skipped: ImportSkip[] } {
  const create: ImportRow[] = []
  const skipped: ImportSkip[] = []
  const seen = new Set<string>()
  for (const p of picked) {
    const skip = (reason: string) => skipped.push({ path: p.path, label: p.label, reason })
    if (seen.has(p.path)) continue
    seen.add(p.path)
    const row = fresh.rows.find((r) => r.path === p.path && r.commonDir === p.commonDir)
    if (!row) { skip('미리보기 뒤 사라졌어요 — 만들지 않았어요'); continue }
    if (row.blocked) { skip(`미리보기 뒤 바뀌었거나 다시 확인하지 못했어요 — ${row.blocked}. 만들지 않았어요`); continue }
    const has = row.existing ?? (() => { const t = sameFolderTask(tasks, row.path, fresh.home); return t ? { taskId: t.id, name: t.name } : null })()
    if (has) { skip(`이미 일감이 있어요 — ${has.name}`); continue }
    if (create.length >= IMPORT_MAX) { skip(`한 번에 ${IMPORT_MAX}개까지 가져와요 — 다시 가져오기로 나머지를`); continue }
    create.push(row)
  }
  return { create, skipped }
}

/**
 * 계획한 줄 → 새 일감들 + 묶음(새로 만들면). 39 열기와 같은 값: 템플릿 없음 · 상태 첫째 · 색 없음 · 설정의 새 일감 시작.
 * 묶음은 저장소의 **모든** worktree 경로로 정한다 — 이미 가져온 worktree 의 일감이 든 묶음을 재사용하게
 */
export function importTasks(
  state: AppState, rows: readonly ImportRow[], repo: { name: string; paths: readonly string[] }, home: string, newId: NewId, now: number,
): { tasks: Task[]; group: Group | null; groupName: string; reused: boolean } {
  const picked = importGroup(state, repo.name, repo.paths, home)
  const group: Group | null = 'create' in picked ? { id: newId(), name: picked.create } : null
  const groupId = 'create' in picked ? group!.id : picked.reuse
  const groupName = 'create' in picked ? picked.create : state.settings.groups.find((g) => g.id === picked.reuse)!.name
  const settings = group ? { ...state.settings, groups: [...state.settings.groups, group] } : state.settings
  const tasks = rows.map((row) => {
    const task = createTask({ name: row.name, cwd: row.path, templateId: null, statusId: settings.statuses[0]!.id, groupId, color: null, start: settings.newTaskStart }, settings, newId, now)
    return row.sessions.length ? { ...task, sessionHints: row.sessions.map((h) => ({ ...h })) } : task
  })
  return { tasks, group: tasks.length ? group : null, groupName, reused: !group }
}

/** reducer `task/import` — 묶음 + 일감을 한 번에(저장 한 번 · 67 revision 한 번). 같은 폴더의 보관 안 된 로컬 일감이 있는 것은 다시 거른다(겹친 두 동작) */
export function applyImport(state: AppState, tasks: readonly Task[], group: Group | null): AppState {
  const fresh: Task[] = []
  for (const t of tasks) {
    if (state.tasks.some((x) => x.id === t.id) || [...state.tasks, ...fresh].some((x) => !x.host && x.archivedAt === undefined && x.cwd === t.cwd)) continue
    fresh.push(t)
  }
  if (fresh.length === 0) return state
  const addGroup = group && !state.settings.groups.some((g) => g.id === group.id)
  return {
    ...state,
    settings: addGroup ? { ...state.settings, groups: [...state.settings.groups, { ...group }] } : state.settings,
    tasks: [...state.tasks, ...fresh],
    activeTaskId: fresh[0]!.id,
  }
}

/** reducer `task/hints-drop` — 이어 한 후보 하나(id) 또는 닫기(모두) */
export function dropSessionHints(state: AppState, taskId: Id, id?: string): AppState {
  const task = state.tasks.find((t) => t.id === taskId)
  if (!task?.sessionHints?.length) return state
  const left = id === undefined ? [] : task.sessionHints.filter((h) => h.id !== id)
  if (left.length === task.sessionHints.length) return state
  const { sessionHints: _drop, ...rest } = task
  const next: Task = left.length ? { ...rest, sessionHints: left } : rest
  return { ...state, tasks: state.tasks.map((t) => (t === task ? next : t)) }
}

// ─── 가져오기 실행: 누른 순간 사본 → 다시 읽기 → 계획 → (닫히지 않았으면) 한 동작 ───
export interface ImportReport {
  created: Array<{ path: string; name: string; taskId: string; hints: number }>
  skipped: ImportSkip[]
  group: string | null
  reused: boolean
}
export interface RunImportDeps {
  preview(root: string): Promise<ImportPreview>
  /** 지금 상태 — 다시 읽은 뒤에 읽는다 */
  state(): AppState
  newId: NewId
  now(): number
  /** 대화상자가 닫혔거나 다른 읽기가 시작됐으면 false — 만들지 않는다 */
  alive(): boolean
  apply(tasks: Task[], group: Group | null): void
}

/** 다시 읽기가 실패하면 던진다(아무것도 만들지 않음). 닫혔으면 null */
export async function runImport(root: string, picked: readonly ImportPick[], deps: RunImportDeps): Promise<ImportReport | null> {
  const copy = picked.map((p) => ({ ...p }))
  const fresh = await deps.preview(root)
  if (!deps.alive()) return null
  const state = deps.state()
  const plan = importPlan(copy, fresh, state.tasks)
  const made = importTasks(state, plan.create, { name: fresh.repo, paths: fresh.rows.map((r) => r.path) }, fresh.home, deps.newId, deps.now())
  if (made.tasks.length) deps.apply(made.tasks, made.group)
  return {
    created: made.tasks.map((t, i) => ({ path: plan.create[i]!.path, name: t.name, taskId: t.id, hints: t.sessionHints?.length ?? 0 })),
    skipped: plan.skipped,
    group: made.tasks.length ? made.groupName : null,
    reused: made.reused,
  }
}

/** 기본으로 고르는 줄 — 가져올 수 있고 · 일감 없고(안쪽 폴더 일감도) · 병합됨 아님(67 정리 대상) */
export const pickedByDefault = (row: ImportRow): boolean => !row.blocked && !row.existing && !row.nearby && row.merge?.state !== 'merged'
export const importable = (row: ImportRow): boolean => !row.blocked && !row.existing
