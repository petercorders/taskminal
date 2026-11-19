// 70단계: 저장소째 옮겨 오기의 main 쪽 — 같은 폴더 신원 검사(39 '일감으로 열기' 와 같이 쓴다) · 고른 폴더 권한 · 미리보기 만들기. 읽기만 한다.
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { DEADLINE_MS, withDeadline, type AgentSessionList } from '../shared/agent-sessions'
import { expandHome } from '../shared/cwd'
import { assignSessions, deepestFolder, importRows, repoName, type ImportPreview } from '../shared/repo-import'
import type { Task } from '../shared/types'
import type { WorktreeManagement } from './worktree-management'

type FolderTask = Pick<Task, 'id' | 'name' | 'cwd' | 'host' | 'archivedAt'>
export interface FolderOwner { id: string; name: string; cwd: string }

/**
 * 39 '일감으로 열기' · 70 가져오기의 같은 폴더 신원 — 보관 안 된 로컬 일감의 realpath(cwd) → 그 일감(처음 것).
 * realpath 를 기다린 뒤 지금 상태에서 그 일감이 아직 보관 안 된 로컬이고 cwd 가 같은지 다시 본다.
 */
export async function taskFolders(tasks: () => readonly FolderTask[], home: string): Promise<Map<string, FolderOwner>> {
  const before = tasks().filter((t) => !t.host && t.archivedAt === undefined)
  const reals = await Promise.all(before.map((t) => realpath(resolve(expandHome(t.cwd, home))).catch(() => '')))
  const now = tasks()
  const out = new Map<string, FolderOwner>()
  before.forEach((t, i) => {
    const real = reals[i]
    if (!real || out.has(real)) return
    const current = now.find((x) => x.id === t.id && !x.host && x.archivedAt === undefined)
    if (current?.cwd === t.cwd) out.set(real, { id: t.id, name: current.name, cwd: t.cwd })
  })
  return out
}

/** 폴더 고르기 대화상자에서 사용자가 고른 저장소 폴더(realpath) — 미리보기는 이 목록이나 지금 로컬 일감 폴더만. 최근 max 개 */
export class ImportRoots {
  private list: string[] = []
  constructor(private readonly max = 20) {}
  async add(path: string): Promise<string> {
    const real = await realpath(path)
    this.list = [...this.list.filter((p) => p !== real), real].slice(-this.max)
    return real
  }
  /** 고른 폴더면 그 realpath, 아니면 null */
  async allowed(path: unknown): Promise<string | null> {
    if (typeof path !== 'string' || !path || path.length > 4096 || path.includes('\0')) return null
    const real = await realpath(path).catch(() => '')
    return real && this.list.includes(real) ? real : null
  }
}

export interface PreviewDeps {
  worktrees: Pick<WorktreeManagement, 'list'>
  tasks(): readonly FolderTask[]
  home: string
  /** 53 의 세션 목록 — 한 번에 하나 · 캐시는 AgentSessions 가 */
  sessions(): Promise<AgentSessionList>
  sessionsMs?: number
}

/** 미리보기 — 39 `list()`(등록 · 폴더 · 상태 · 67 병합) + 39 신원 검사 + 53 세션(15초 한도, 못 읽으면 세션 없이) */
export async function buildImportPreview(d: PreviewDeps, root: string): Promise<ImportPreview> {
  const sessions = withDeadline(d.sessions(), d.sessionsMs ?? DEADLINE_MS, '세션 기록 읽기 시간 넘김').then((list) => ({ list, note: undefined as string | undefined }))
    .catch(() => ({ list: null, note: '세션 기록을 읽지 못했어요 — 이어 하기 후보 없이 가져와요' }))
  const [view, read] = await Promise.all([d.worktrees.list(root, []), sessions])
  const owners = await taskFolders(d.tasks, d.home)
  // 세션 cwd 는 기록에 적힌 그대로 — worktree 경로(realpath)와 같은 꼴로 맞춘다
  const cwds = [...new Set((read.list?.sessions ?? []).map((s) => s.cwd))]
  const reals = new Map(await Promise.all(cwds.map(async (c) => [c, await realpath(c).catch(() => c)] as const)))
  const paths = view.entries.filter((e) => !e.bare).map((e) => e.path)
  const assigned = assignSessions((read.list?.sessions ?? []).map((s) => ({ ...s, cwd: reals.get(s.cwd) ?? s.cwd })), paths)
  // 리뷰 6: 이 worktree 안쪽 폴더(더 안쪽 worktree 는 빼고)를 일감 폴더로 쓰는 일감 — 가져올 수는 있지만 기본으로 고르지 않는다
  const nearby = new Map<string, FolderOwner>()
  for (const [real, owner] of owners) {
    const at = deepestFolder(paths, real)
    if (at && at !== real && !nearby.has(at)) nearby.set(at, owner)
  }
  const pick = (map: Map<string, FolderOwner>) => (path: string) => { const o = map.get(path); return o ? { taskId: o.id, name: o.name } : null }
  const rows = importRows(view, pick(owners), assigned, pick(nearby))
  return { root: view.root, commonDir: view.commonDir, repo: repoName(view), home: d.home, rows, ...(read.note ? { sessionsNote: read.note } : {}) }
}
