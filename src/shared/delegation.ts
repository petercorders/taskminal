// 69단계: 에이전트가 일을 맡기기 — 보낸 이 머리 · 위임 브랜치 이름 · 맡긴 일감의 턴 멈춤 → 부모 알림. 순수.
import { turnStop, type ChatEvent, type TurnStop } from './chat'
import { hasPane } from './layout'
import { findPaneTask, tabShownLabel } from './model'
import type { AppState, Id, Task } from './types'
import { isWorktreeBranchText } from './worktree-management'

/** 45단계 worker 의 브랜치 머리 — CLI 위임은 이 이름을 쓰지 않는다(45 와 브랜치가 겹치지 않게) */
export const WORKER_BRANCH_PREFIX = 'taskminal/worker-'

const NAME_MAX = 80
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g
const HAS_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/
/** 머리 · 알림 글에 넣는 이름 — 줄바꿈 · 제어 글자는 빈칸, 80자 */
const clean = (s: string) => s.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX)

/** 새 브랜치 이름의 문제 — 없으면 null. 나머지 규칙(.. · @{ 등)은 git check-ref-format 이 본다 */
export function validDelegateBranch(branch: string): string | null {
  if (!branch || branch.length > 100) return '브랜치 이름은 1~100자로 적어 주세요'
  if (branch.startsWith('-')) return '브랜치 이름은 - 로 시작하지 않아요'
  if (!isWorktreeBranchText(branch) || HAS_CONTROL.test(branch)) return '브랜치 이름에 빈칸 · 줄바꿈을 넣지 않아요'
  if (branch.startsWith(WORKER_BRANCH_PREFIX)) return `${WORKER_BRANCH_PREFIX}… 는 작업 흐름(worker)이 쓰는 이름이에요 — 다른 이름을 써 주세요`
  return null
}

// ─── 보낸 이 ──────────────────────────────────────────────────

/** 받는 쪽이 사람 말과 가리는 글 머리 — `[taskminal: 일감 › 탭 (pane) 에서 보냄]`. pane id 로 답을 보낼 수 있다 */
export function senderHeader(label: string, paneId: string): string {
  return `[taskminal: ${clean(label)} (${paneId}) 에서 보냄]`
}

const paneTask = (state: AppState, paneId: Id): Task | undefined => {
  const id = findPaneTask(state, paneId)
  return id === null ? undefined : state.tasks.find((t) => t.id === id)
}

/** 부른 pane(self)이 받는 pane 과 다를 때만 머리. self 가 없거나(앱 밖 터미널) 일감 안 pane 이 아니면 없음 */
export function senderOf(state: AppState, self: string | undefined, target: Id): string | undefined {
  if (!self || self === target) return undefined
  const task = paneTask(state, self)
  const tab = task?.tabs.find((t) => hasPane(t.layout, self))
  if (!task || !tab) return undefined
  return senderHeader(`${task.name} › ${tabShownLabel(task, tab)}`, self)
}

/**
 * 대화에 보내는 글 — 머리 줄 + 글. `/` 로 시작하는 글은 대화의 명령(/compact 등)이라 그대로 둔다(머리를 붙이면 명령이 아니라 말이 된다).
 * 터미널 `pane send` 에는 쓰지 않는다 — 키 입력이라 받는 TUI 가 메뉴 · 허락 상태인지 알 수 없고, 머리 글자가 그 선택을 고를 수 있다(69 리뷰).
 */
export function withSender(text: string, sender: string | undefined): string {
  if (!sender || text.trimStart().startsWith('/')) return text
  return `${sender}\n${text}`
}

// ─── 부모 알림 ────────────────────────────────────────────────

/** pane 별 '이 턴을 아직 알리지 않음' — 없는 pane 은 열림으로 본다(창 새로 고침 뒤 처음 온 끝도 알린다) */
export type TurnOpen = Map<string, boolean>

/** 이 pane 이 맡긴 일감(부모가 기록된 일감)의 것인가 — 알림 표에는 이런 pane 만 넣는다(표가 끝없이 자라지 않게) */
export function isDelegatedPane(state: AppState, paneId: Id): boolean {
  return paneTask(state, paneId)?.parent !== undefined
}

/**
 * 대화 사건 → 부모에 알릴 멈춤. 한 턴에 한 번 — 알린 뒤 닫고, 새 턴(user) · 허락 뒤 이어감(answered) ·
 * 닫은 뒤 본 에이전트의 글 · 도구(오류 뒤 이어 간 턴 · 백그라운드 일 뒤 이어 간 턴)에서 다시 연다. 하위 에이전트의 도구(parent)는 열지 않는다.
 */
export function delegateSignal(open: TurnOpen, paneId: string, ev: ChatEvent): TurnStop | null {
  if (ev.t === 'user' || ev.t === 'answered' || ev.t === 'text' || (ev.t === 'tool' && ev.parent === undefined)) {
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
  const child = paneTask(state, paneId)
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
