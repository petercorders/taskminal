// 빠른 명령 (20단계) — 일감마다 자주 쓰는 명령을 단추로. 순수 함수: 저장 파일 검증 · 단추 순서 · 실행 상태 · 어디서 실행할지.
// 실행은 셸에 글자로 입력한다(템플릿 시작 명령 · 명령 기록과 같은 길). 위험 명령 표는 19단계 danger.ts 하나를 함께 쓴다.
import type { PaneActivity } from './activity'
import { isDangerous } from './danger'
import { isObj } from './guards'

export const QUICK_WHERE = ['current', 'newTab', 'splitRight', 'splitDown', 'insert'] as const
export type QuickWhere = (typeof QUICK_WHERE)[number]
export const WHERE_LABEL: Record<QuickWhere, string> = {
  current: '지금 pane',
  newTab: '새 탭',
  splitRight: '오른쪽 분할',
  splitDown: '아래 분할',
  insert: '입력줄에 넣기만',
}

export interface QuickCommand {
  id: string
  label: string
  /** 셸에 그대로 입력하는 한 줄 (여러 줄은 && 로) */
  command: string
  where: QuickWhere
  /** 일감 폴더 기준 상대 경로 또는 절대 경로 — 새 탭 · 분할에서만 */
  cwd?: string
  /** 실행 전 물어봐요 */
  confirm?: true
  /** 템플릿에서 온 단추 (▤) — 템플릿 이름 */
  fromTemplate?: string
}

export const QUICK_BAR_MAX = 9
export const QUICK_LABEL_MAX = 40
export const QUICK_COMMAND_MAX = 2000
export const QUICK_LIST_MAX = 100

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max

function parseQuick(v: unknown): QuickCommand | null {
  if (!isObj(v)) return null
  if (!str(v['id'], 100) || !str(v['label'], QUICK_LABEL_MAX) || !str(v['command'], QUICK_COMMAND_MAX)) return null
  if (/[\r\n]/.test(v['command'] as string)) return null
  const where = v['where']
  if (!(QUICK_WHERE as readonly unknown[]).includes(where)) return null
  const out: QuickCommand = { id: v['id'] as string, label: v['label'] as string, command: v['command'] as string, where: where as QuickWhere }
  if (str(v['cwd'], 4096)) out.cwd = v['cwd'] as string
  if (v['confirm'] === true) out.confirm = true
  if (str(v['fromTemplate'], 200)) out.fromTemplate = v['fromTemplate'] as string
  return out
}

/** 틀린 항목 · 겹친 id 는 버린다(하나가 틀렸다고 나머지를 버리지 않는다) */
export function parseQuickList(v: unknown): QuickCommand[] {
  if (!Array.isArray(v)) return []
  const seen = new Set<string>()
  const out: QuickCommand[] = []
  for (const item of v.slice(0, QUICK_LIST_MAX)) {
    const q = parseQuick(item)
    if (!q || seen.has(q.id)) continue
    seen.add(q.id)
    out.push(q)
  }
  return out
}

/** 만들기 창 검사 — 저장 파일 검증이 버릴 값이면 그 이유 */
export function quickError(v: { label: string; command: string }): string | null {
  if (!v.label.trim()) return '이름이 비어 있어요'
  if (v.label.length > QUICK_LABEL_MAX) return `이름은 ${QUICK_LABEL_MAX}자까지예요`
  if (!v.command.trim()) return '명령이 비어 있어요'
  if (/[\r\n]/.test(v.command)) return '한 줄로 써 주세요 — 여러 명령은 && 로 이어요'
  if (v.command.length > QUICK_COMMAND_MAX) return '명령이 너무 길어요'
  return null
}

/** 새 단추의 '실행 전 물어봐요' 기본값 — 위험 명령(배포 · 지우기 · 올리기)이면 켜고 이유를 한 줄 */
export function quickDefaults(command: string): { confirm: boolean; reason?: string } {
  return isDangerous(command) ? { confirm: true, reason: '위험할 수 있는 명령(배포 · 지우기 · 올리기)이라 켜 두었어요' } : { confirm: false }
}

export type QuickSource = 'task' | 'template' | 'all'
export interface QuickButton {
  qc: QuickCommand
  source: QuickSource
  /** ⌥ 숫자 (1~9), 더 보기 안이면 null */
  key: number | null
  /** 실행 상태를 찾는 열쇠 — 일감 것과 모든 일감 것은 id 가 같아도 다르다 */
  runKey: string
}

/** 일감 것(저장 순서, 템플릿에서 온 것 포함) → 모든 일감 것. 앞 9개가 줄에, 나머지는 더 보기 */
export function quickButtons(task: { quickCommands?: QuickCommand[] | undefined }, all: readonly QuickCommand[]): { shown: QuickButton[]; more: QuickButton[] } {
  const list: Array<Omit<QuickButton, 'key'>> = [
    ...(task.quickCommands ?? []).map((qc) => ({ qc, source: (qc.fromTemplate ? 'template' : 'task') as QuickSource, runKey: `t:${qc.id}` })),
    ...all.map((qc) => ({ qc, source: 'all' as QuickSource, runKey: `a:${qc.id}` })),
  ]
  const withKey = list.map((b, i) => ({ ...b, key: i < QUICK_BAR_MAX ? i + 1 : null }))
  return { shown: withKey.slice(0, QUICK_BAR_MAX), more: withKey.slice(QUICK_BAR_MAX) }
}

/** 단추를 누른 기록 — 저장하지 않는 런타임 값. 시작 · 끝을 처음 본 순간에 굳힌다(같은 pane 의 다음 명령이 이 단추 결과를 덮지 않게) */
export interface QuickRun {
  paneId: string
  sentAt: number
  /** 보낸 뒤 처음 본 시작(OSC 133 C) */
  startedAt?: number
  /** 그 명령의 끝 — code null 은 끝을 놓침(다음 명령이 먼저 시작) */
  endedAt?: number
  code?: number | null
}

export type QuickState =
  | { kind: 'idle' }
  | { kind: 'running'; since: number }
  | { kind: 'done'; at: number }
  | { kind: 'failed'; code: number; at: number }
  | { kind: 'unknown' }

/**
 * pane 활동이 바뀔 때마다 — 보낸 뒤 첫 시작을 이 단추 것으로 잡고, 그 시작의 끝을 굳힌다. 바뀐 것이 없으면 같은 객체.
 * 같은 pane 에서 다음 명령이 시작됐는데 이 명령의 끝을 못 봤으면 끝을 놓친 것(code null).
 */
export function advanceRun(run: QuickRun, act: PaneActivity | undefined): QuickRun {
  if (run.endedAt !== undefined || act?.startedAt === undefined) return run
  if (run.startedAt === undefined) {
    if (act.startedAt < run.sentAt) return run
    return advanceRun({ ...run, startedAt: act.startedAt }, act)
  }
  if (act.startedAt > run.startedAt) return { ...run, endedAt: act.startedAt, code: null }
  if (act.startedAt === run.startedAt && !act.busy && act.endedAt !== undefined && act.endedAt >= run.startedAt)
    return { ...run, endedAt: act.endedAt, code: act.exitCode ?? 0 }
  return run
}

/** 단추 상태 — 굳힌 시작 · 끝에서. 아직 시작을 못 봤으면: 셸 통합이 있으면 보낸 때부터 실행 중, 없으면(bash 등) 결과를 모른다 */
export function quickStatus(run: QuickRun | undefined, integrated: boolean): QuickState {
  if (!run) return { kind: 'idle' }
  if (run.endedAt !== undefined) {
    if (run.code === null || run.code === undefined) return { kind: 'unknown' }
    return run.code !== 0 ? { kind: 'failed', code: run.code, at: run.endedAt } : { kind: 'done', at: run.endedAt }
  }
  if (run.startedAt !== undefined) return { kind: 'running', since: run.startedAt }
  return integrated ? { kind: 'running', since: run.sentAt } : { kind: 'unknown' }
}

/** 어디서 실행할지 — '지금 pane' 이 바쁘거나 · 셸 통합이 없어 프롬프트인지 모르거나 · 없으면 끼워 넣지 않고 새 탭 */
export function decideRun(where: QuickWhere, target: { busy: boolean; integrated: boolean } | null): { where: QuickWhere; fallback: boolean } {
  if (where !== 'current') return { where, fallback: false }
  if (!target || target.busy || !target.integrated) return { where: 'newTab', fallback: true }
  return { where, fallback: false }
}

/** 같은 id 면 그 자리에서 바꾸고, 없으면 끝에 */
export function upsertQuick(list: readonly QuickCommand[], qc: QuickCommand): QuickCommand[] {
  const i = list.findIndex((q) => q.id === qc.id)
  return i < 0 ? [...list, qc] : list.map((q, j) => (j === i ? qc : q))
}

export function removeQuick(list: readonly QuickCommand[], id: string): { list: QuickCommand[]; removed: QuickCommand | null; index: number } {
  const index = list.findIndex((q) => q.id === id)
  if (index < 0) return { list: [...list], removed: null, index: -1 }
  return { list: list.filter((_, j) => j !== index), removed: list[index]!, index }
}

/** 지우기 되돌리기 — 지운 자리에. 이미 같은 id 가 있으면 그대로 */
export function restoreQuick(list: QuickCommand[], qc: QuickCommand, index: number): QuickCommand[] {
  if (list.some((q) => q.id === qc.id)) return list
  const at = Math.max(0, Math.min(index, list.length))
  return [...list.slice(0, at), qc, ...list.slice(at)]
}
