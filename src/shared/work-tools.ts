import { SHORTCUTS, type AppCommand } from './keymap'

/** 56단계: 옆 패널 도구 · 찾기 목록 한 곳 — 위 도구 줄 · 좁은 창 고르기 칸 · 사이드바 고르기 칸 · 패널 머리가 같은 이름(키 표 label)과 같은 꺼짐 규칙을 쓴다 */
export type WorkToolKind = 'files' | 'browser' | 'git' | 'worktree' | 'development' | 'issues' | 'workflow' | 'schedule' | 'accounts' | 'remote'
export interface WorkTool {
  kind: WorkToolKind
  command: AppCommand
  /** task: 이 일감 폴더에서 도는 이 Mac 도구 · app: 일감과 무관 */
  group: 'task' | 'app'
  /** 위 도구 줄에 단추로(아니면 '일감 도구 ▾' 메뉴) */
  direct: boolean
}
export const WORK_TOOLS: readonly WorkTool[] = [
  { kind: 'files', command: 'workspace-files', group: 'task', direct: true },
  { kind: 'browser', command: 'workspace-browser', group: 'task', direct: true },
  { kind: 'git', command: 'git-workflow', group: 'task', direct: true },
  { kind: 'worktree', command: 'worktrees', group: 'task', direct: false },
  { kind: 'development', command: 'development', group: 'task', direct: false },
  { kind: 'issues', command: 'issues', group: 'task', direct: false },
  { kind: 'workflow', command: 'workflows', group: 'task', direct: false },
  { kind: 'schedule', command: 'schedules', group: 'task', direct: false },
  { kind: 'accounts', command: 'accounts', group: 'app', direct: true },
  { kind: 'remote', command: 'remote-workspace', group: 'app', direct: true },
]

/** 찾기 네 곳 — '찾기 ▾' 메뉴 · 찾기 화면 머리의 바꾸기 줄 */
export type FindKind = 'conversation' | 'sessions' | 'history' | 'output'
export const FIND_TOOLS: readonly { kind: FindKind; command: AppCommand; short: string }[] = [
  { kind: 'conversation', command: 'conversation-search', short: '대화 기록' },
  { kind: 'sessions', command: 'agent-sessions', short: '에이전트 세션' },
  { kind: 'history', command: 'history', short: '명령 기록' },
  { kind: 'output', command: 'global-find', short: '모든 출력' },
]

const LABELS = new Map<string, string>(SHORTCUTS.map((s) => [s.command, s.label]))
export const commandLabel = (command: AppCommand): string => LABELS.get(command) ?? command
export const toolByKind = (kind: string): WorkTool | undefined => WORK_TOOLS.find((t) => t.kind === kind)
export const toolByCommand = (command: string): WorkTool | undefined => WORK_TOOLS.find((t) => t.command === command)

/** 막힌 이유 (안 막혔으면 null) — 숨기지 않고 꺼서 보이고 이 글을 title · 메뉴 머리 · 알림에 쓴다 */
export function toolBlocked(tool: WorkTool, task: { host?: string } | null): string | null {
  if (tool.group === 'app') return null
  if (!task) return '일감을 먼저 고르세요.'
  if (task.host) return '원격 일감에서는 이 Mac 의 파일 · 저장소 · 브라우저 도구를 쓸 수 없어요.'
  return null
}
