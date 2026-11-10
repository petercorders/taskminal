// 사이드바에 보일 칸 나누기. 순수 함수라 단위 시험한다.
import type { AppState, Group, Task } from '../shared/types'

export interface SidebarSection {
  /** 묶음 이름. 묶음이 하나도 쓰이지 않으면 null(제목 없는 한 칸) */
  title: string | null
  group: Group | null
  tasks: Task[]
}

/** 묶음은 설정 순서대로, 묶음 없는 일감은 맨 끝. 일감이 없는 묶음은 숨긴다. */
export function sidebarSections(state: AppState): SidebarSection[] {
  const known = new Set(state.settings.groups.map((g) => g.id))
  const grouped: SidebarSection[] = state.settings.groups
    .map((group) => ({ title: group.name, group, tasks: state.tasks.filter((t) => t.groupId === group.id) }))
    .filter((s) => s.tasks.length > 0)
  const loose = state.tasks.filter((t) => t.groupId === null || !known.has(t.groupId))
  if (loose.length === 0) return grouped
  if (grouped.length === 0) return [{ title: null, group: null, tasks: loose }]
  return [...grouped, { title: '묶음 없음', group: null, tasks: loose }]
}

/** 사이드바 둘째 줄용: 세 칸 넘는 경로는 끝 두 칸만 (`~/code/jjikgyebu/flutter` → `…/jjikgyebu/flutter`). */
export function shortPath(cwd: string): string {
  const trimmed = cwd.length > 1 ? cwd.replace(/\/+$/, '') : cwd
  const parts = trimmed.split('/').filter(Boolean)
  if (parts.length <= 3) return trimmed
  return `…/${parts.slice(-2).join('/')}`
}
