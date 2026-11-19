// 69단계: 에이전트가 일을 맡기기 — 보낸 이 머리 · 위임 브랜치 이름 · 맡긴 일감의 턴 멈춤 → 부모 알림. 순수.
import type { PaneActivity } from './activity'
import type { AgentKind } from './agent-hooks'
import { turnStop, type ChatEvent, type TurnStop } from './chat'
import { hasPane } from './layout'
import { tabShownLabel } from './model'
import type { AppState, Id } from './types'

/** 45단계 worker 의 브랜치 머리 — CLI 위임은 이 이름을 쓰지 않는다(45 와 브랜치가 겹치지 않게) */
export const WORKER_BRANCH_PREFIX = 'taskminal/worker-'
/** 요청 번호 — 39 의 worktree 생성 기록과 같은 모양 */
export const REQUEST_ID_RE = /^[\w-]{1,100}$/

const NAME_MAX = 80
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g
const HAS_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/
/** 머리 · 알림 글에 넣는 이름 — 줄바꿈 · 제어 글자는 빈칸, 80자 */
const clean = (s: string) => s.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX)

/** 새 브랜치 이름의 문제 — 없으면 null. 나머지 규칙(.. · @{ 등)은 git check-ref-format 이 본다 */
export function validDelegateBranch(branch: string): string | null {
  if (!branch || branch.length > 100) return '브랜치 이름은 1~100자로 적어 주세요'
  if (/[\s\0]/.test(branch) || HAS_CONTROL.test(branch)) return '브랜치 이름에 빈칸 · 줄바꿈을 넣지 않아요'
  if (branch.startsWith('-')) return '브랜치 이름은 - 로 시작하지 않아요'
  if (branch.startsWith(WORKER_BRANCH_PREFIX)) return `${WORKER_BRANCH_PREFIX}… 는 작업 흐름(worker)이 쓰는 이름이에요 — 다른 이름을 써 주세요`
  return null
}

// ─── 보낸 이 ──────────────────────────────────────────────────

/** 받는 쪽이 사람 말과 가리는 글 머리 — `[taskminal: 일감 › 탭 (pane) 에서 보냄]`. pane id 로 답을 보낼 수 있다 */
export function senderHeader(label: string, paneId: string): string {
  return `[taskminal: ${clean(label)} (${paneId}) 에서 보냄]`
}

/** 부른 pane(self)이 받는 pane 과 다를 때만 머리. self 가 없거나(앱 밖 터미널) 일감 안 pane 이 아니면 없음 */
export function senderOf(state: AppState, self: string | undefined, target: Id): string | undefined {
  if (!self || self === target) return undefined
  const task = state.tasks.find((t) => Object.hasOwn(t.panes, self))
  const tab = task?.tabs.find((t) => hasPane(t.layout, self))
  if (!task || !tab) return undefined
  return senderHeader(`${task.name} › ${tabShownLabel(task, tab)}`, self)
}

/** block = 대화(머리 줄 + 글), line = 터미널에서 도는 에이전트 TUI(같은 줄 — 줄바꿈이 보내기인지 줄 넣기인지 에이전트마다 다르다) */
export function withSender(text: string, sender: string | undefined, how: 'block' | 'line'): string {
  if (!sender) return text
  return how === 'block' ? `${sender}\n${text}` : `${sender} ${text}`
}

/** 이 터미널에서 지금 도는 에이전트 — 51 훅 상태, 훅이 없으면 실행 중 명령의 첫 낱말. 셸 프롬프트면 없음(셸에 머리를 보내면 명령으로 돈다) */
export function terminalAgent(a: PaneActivity | undefined): AgentKind | undefined {
  if (!a) return undefined
  if (a.agent) return a.agent.agent
  if (!a.busy || !a.command) return undefined
  const m = /^\s*(?:\S*\/)?(claude|codex)(?:\s|$)/.exec(a.command)
  return m ? (m[1] as AgentKind) : undefined
}

// ─── 부모 알림 ────────────────────────────────────────────────

/** pane 별 '이 턴을 아직 알리지 않음' — 없는 pane 은 열림으로 본다(창 새로 고침 뒤 처음 온 끝도 알린다) */
export type TurnOpen = Map<string, boolean>

/** 대화 사건 → 부모에 알릴 멈춤. 한 턴에 한 번 — 알린 뒤 닫고, 새 턴(user) · 허락 뒤 이어감(answered)에서 다시 연다 */
export function delegateSignal(open: TurnOpen, paneId: string, ev: ChatEvent): TurnStop | null {
  if (ev.t === 'user' || ev.t === 'answered') {
    open.set(paneId, true)
    return null
  }
  const stop = turnStop(ev)
  if (!stop || open.get(paneId) === false) return null
  open.set(paneId, false)
  return stop
}

const STOP_TEXT: Record<TurnStop, string> = { done: '턴이 끝났어요', fail: '실패했어요', wait: '허락 · 답을 기다려요', stopped: '멈췄어요' }

/**
 * 맡긴 일감의 pane 이 멈췄을 때 부모의 어느 pane 에 무엇을 알릴지 — 그 순간 상태에서 다시 찾는다.
 * 부모가 지워졌거나 보관됐거나 pane 이 없으면 null(조용히). 맡긴 pane 이 사라졌으면 부모의 활성 pane.
 */
export function parentNotice(state: AppState, paneId: string, stop: TurnStop): { paneId: Id; text: string } | null {
  const child = state.tasks.find((t) => Object.hasOwn(t.panes, paneId))
  const ref = child?.parent
  if (!child || !ref) return null
  const parent = state.tasks.find((t) => t.id === ref.taskId)
  if (!parent || parent.id === child.id || parent.archivedAt !== undefined) return null
  const asked = ref.paneId
  const at =
    asked && Object.hasOwn(parent.panes, asked) && parent.tabs.some((t) => hasPane(t.layout, asked))
      ? asked
      : parent.tabs.find((t) => t.id === parent.activeTabId)?.activePaneId
  return at ? { paneId: at, text: `맡긴 일 '${clean(child.name)}': ${STOP_TEXT[stop]}` } : null
}
