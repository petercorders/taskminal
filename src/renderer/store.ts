// 화면 상태의 주인. 순수 reducer — 새 id · 시각은 부르는 쪽이 만들어 넘긴다.
import { clampFontSize } from '../shared/keymap'
import type { SplitPath } from '../shared/layout'
import {
  addGroup,
  addStatus,
  addTab,
  addTemplate,
  addTemplateTabs,
  closePane,
  closeTab,
  cycleActivePane,
  cycleTab,
  editTask,
  findPaneTask,
  focusPane,
  markCommandSent,
  moveGroup,
  moveStatus,
  removeGroup,
  removeStatus,
  removeTemplate,
  renameGroup,
  renameTab,
  renameTemplate,
  replaceTemplate,
  selectTab,
  selectTabAt,
  setPaneCwd,
  setTabRatio,
  splitActivePane,
  toggleGroup,
  updateStatus,
  type SplitSpec,
  type QuickScope,
  dropQuick,
  putBackQuick,
  saveQuick,
  type TaskEdit,
  addChatTab,
  branchChat,
  chatRewound,
  chatToTerminal,
  setChatSession,
  splitActivePaneChat,
} from '../shared/model'
import type { QuickCommand } from '../shared/quick'
import type { ChatAgent } from '../shared/chat'
import type { AppState, Id, Settings, SplitDir, Task, Template } from '../shared/types'

/** 설정 창에서 바로 바꾸는 값 (상태 · 묶음 · 템플릿 목록은 따로) */
export type SettingsPatch = Partial<Omit<Settings, 'statuses' | 'groups' | 'templates'>>

export type Action =
  | { type: 'loaded'; state: AppState }
  /** 백업에서 되돌리기 · 가져오기 · 지운 일감 되살리기 (17단계) — 셸 정리는 부르는 쪽이 먼저 */
  | { type: 'state/replace'; state: AppState }
  | { type: 'task/create'; task: Task }
  | { type: 'task/select'; id: Id }
  | { type: 'task/remove'; id: Id }
  | { type: 'tab/add'; taskId: Id; tabId: Id; paneId: Id; spec?: SplitSpec }
  | { type: 'quick/save'; scope: QuickScope; qc: QuickCommand }
  | { type: 'quick/remove'; scope: QuickScope; id: Id }
  | { type: 'quick/restore'; scope: QuickScope; qc: QuickCommand; index: number }
  | { type: 'tab/select'; taskId: Id; tabId: Id }
  | { type: 'tab/close'; taskId: Id; tabId: Id }
  | { type: 'tab/rename'; taskId: Id; tabId: Id; title: string }
  /** n번째 탭(1부터), 9 = 마지막 */
  | { type: 'tab/nth'; taskId: Id; n: number }
  | { type: 'tab/cycle'; taskId: Id; step: 1 | -1 }
  | { type: 'pane/cycle'; taskId: Id; step: 1 | -1 }
  | { type: 'settings/font'; size: number }
  | { type: 'pane/split'; taskId: Id; dir: SplitDir; paneId: Id; spec?: SplitSpec }
  | { type: 'pane/focus'; taskId: Id; paneId: Id }
  | { type: 'pane/ratio'; taskId: Id; tabId: Id; path: SplitPath; ratio: number }
  /** 셸이 스스로 끝났다 → 그 pane 을 닫는다 (마지막 pane 이면 탭도). 우리가 끝낸 셸은 main 이 알리지 않는다. */
  | { type: 'pane/exited'; paneId: Id }
  | { type: 'settings/patch'; patch: SettingsPatch }
  | { type: 'status/add'; id: Id; name: string; color: string }
  | { type: 'status/update'; id: Id; name?: string; color?: string }
  | { type: 'status/move'; id: Id; step: 1 | -1 }
  | { type: 'status/remove'; id: Id }
  | { type: 'group/add'; id: Id; name: string }
  | { type: 'group/rename'; id: Id; name: string }
  | { type: 'group/move'; id: Id; step: 1 | -1 }
  | { type: 'group/remove'; id: Id }
  | { type: 'group/toggle'; id: Id }
  | { type: 'template/rename'; id: Id; name: string }
  | { type: 'template/remove'; id: Id }
  | { type: 'template/add'; template: Template }
  | { type: 'template/replace'; id: Id; name: string; tabs: Template['tabs'] }
  /** 탭 "+ ▾" — 템플릿의 탭을 붙인다. ids 는 부르는 쪽이 templateIdCount 개 만들어 넘긴다 */
  /** 템플릿은 id 를 만든 쪽이 본 그대로 싣는다 — 그 사이 편집기로 바뀐 템플릿을 다시 찾으면 id 수가 어긋난다 */
  | { type: 'tab/add-template'; taskId: Id; template: Template; ids: Id[] }
  /** 템플릿 시작 명령을 셸에 보냈다 → 다시 돌지 않게 */
  | { type: 'pane/command-sent'; paneId: Id }
  | { type: 'task/edit'; id: Id; patch: TaskEdit }
  /** 셸 안의 cd — OSC 7 · lsof 가 알려 준 폴더 */
  | { type: 'pane/cwd'; paneId: Id; cwd: string }
  // 대화 pane (21단계) — id 는 부르는 쪽이 만든다(같은 동작이 두 번 돌아도 같은 결과)
  | { type: 'chat/add-tab'; taskId: Id; tabId: Id; paneId: Id; agent?: ChatAgent }
  | { type: 'chat/split'; taskId: Id; paneId: Id; agent?: ChatAgent }
  | { type: 'chat/rewound'; paneId: Id; forkAt: string | null }
  | { type: 'chat/branch'; paneId: Id; newPaneId: Id; forkAt: string }
  | { type: 'chat/session'; paneId: Id; sessionId: string }
  | { type: 'chat/to-terminal'; paneId: Id; newPaneId: Id; bin: string }

/** 일감 하나를 바꾼다. 없는 일감이거나 바뀐 것이 없으면 같은 상태 객체 (저장을 건너뛰게). */
function updateTask(state: AppState, taskId: Id, change: (task: Task) => Task): AppState {
  const task = state.tasks.find((t) => t.id === taskId)
  if (!task) return state
  const next = change(task)
  return next === task ? state : { ...state, tasks: state.tasks.map((t) => (t === task ? next : t)) }
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'loaded':
    case 'state/replace':
      return action.state
    case 'task/create':
      return { ...state, tasks: [...state.tasks, action.task], activeTaskId: action.task.id }
    case 'task/select':
      return state.tasks.some((t) => t.id === action.id) ? { ...state, activeTaskId: action.id } : state
    case 'task/remove': {
      const i = state.tasks.findIndex((t) => t.id === action.id)
      if (i < 0) return state
      const tasks = state.tasks.filter((t) => t.id !== action.id)
      // 활성 일감을 지웠으면 오른쪽(같은 자리), 없으면 왼쪽
      const activeTaskId =
        state.activeTaskId === action.id ? (tasks[i]?.id ?? tasks[i - 1]?.id ?? null) : state.activeTaskId
      return { ...state, tasks, activeTaskId }
    }
    case 'tab/add': {
      // addTab 은 탭 id → pane id 순서로 두 번 묻는다. 그 약속이 바뀌면 조용히 undefined id 를 쓰지 않고 멈춘다.
      const ids = [action.tabId, action.paneId]
      const next = () => {
        const id = ids.shift()
        if (id === undefined) throw new Error('tab/add: addTab 이 id 를 두 개보다 많이 요청했습니다')
        return id
      }
      return updateTask(state, action.taskId, (t) => {
        const out = addTab(t, next, action.spec)
        if (ids.length > 0 || out.activeTabId !== action.tabId) throw new Error('tab/add: id 순서가 바뀌었습니다')
        return out
      })
    }
    case 'tab/select':
      return updateTask(state, action.taskId, (t) => selectTab(t, action.tabId))
    case 'tab/close':
      return updateTask(state, action.taskId, (t) => closeTab(t, action.tabId))
    case 'tab/rename':
      return updateTask(state, action.taskId, (t) => renameTab(t, action.tabId, action.title))
    case 'tab/nth':
      return updateTask(state, action.taskId, (t) => selectTabAt(t, action.n))
    case 'tab/cycle':
      return updateTask(state, action.taskId, (t) => cycleTab(t, action.step))
    case 'pane/cycle':
      return updateTask(state, action.taskId, (t) => cycleActivePane(t, action.step))
    case 'settings/font': {
      const fontSize = clampFontSize(action.size)
      return fontSize === state.settings.fontSize ? state : { ...state, settings: { ...state.settings, fontSize } }
    }
    case 'quick/save':
      return saveQuick(state, action.scope, action.qc)
    case 'quick/remove':
      return dropQuick(state, action.scope, action.id).state
    case 'quick/restore':
      return putBackQuick(state, action.scope, action.qc, action.index)
    case 'pane/split':
      return updateTask(state, action.taskId, (t) => splitActivePane(t, action.dir, () => action.paneId, action.spec))
    case 'pane/focus':
      return updateTask(state, action.taskId, (t) => focusPane(t, action.paneId))
    case 'pane/ratio':
      return updateTask(state, action.taskId, (t) => setTabRatio(t, action.tabId, action.path, action.ratio))
    case 'pane/exited': {
      const taskId = findPaneTask(state, action.paneId)
      return taskId ? updateTask(state, taskId, (t) => closePane(t, action.paneId)) : state
    }
    case 'settings/patch': {
      const cur = state.settings as unknown as Record<string, unknown>
      const changed = Object.entries(action.patch).some(([k, v]) => cur[k] !== v)
      return changed ? { ...state, settings: { ...state.settings, ...action.patch } } : state
    }
    case 'status/add':
      return addStatus(state, action.id, action.name, action.color)
    case 'status/update':
      return updateStatus(state, action.id, { ...(action.name !== undefined ? { name: action.name } : {}), ...(action.color !== undefined ? { color: action.color } : {}) })
    case 'status/move':
      return moveStatus(state, action.id, action.step)
    case 'status/remove':
      return removeStatus(state, action.id)
    case 'group/add':
      return addGroup(state, action.id, action.name)
    case 'group/rename':
      return renameGroup(state, action.id, action.name)
    case 'group/move':
      return moveGroup(state, action.id, action.step)
    case 'group/remove':
      return removeGroup(state, action.id)
    case 'group/toggle':
      return toggleGroup(state, action.id)
    case 'template/rename':
      return renameTemplate(state, action.id, action.name)
    case 'template/remove':
      return removeTemplate(state, action.id)
    case 'template/add':
      return addTemplate(state, action.template)
    case 'template/replace':
      return replaceTemplate(state, action.id, { name: action.name, tabs: action.tabs })
    case 'tab/add-template': {
      const ids = [...action.ids]
      return updateTask(state, action.taskId, (t) =>
        addTemplateTabs(t, action.template, () => {
          const id = ids.shift()
          if (id === undefined) throw new Error('tab/add-template: id 가 모자랍니다 (templateIdCount)')
          return id
        }),
      )
    }
    case 'pane/cwd': {
      const taskId = findPaneTask(state, action.paneId)
      return taskId ? updateTask(state, taskId, (t) => setPaneCwd(t, action.paneId, action.cwd)) : state
    }
    case 'pane/command-sent': {
      const taskId = findPaneTask(state, action.paneId)
      return taskId ? updateTask(state, taskId, (t) => markCommandSent(t, action.paneId)) : state
    }
    case 'task/edit':
      return editTask(state, action.id, action.patch)
    case 'chat/add-tab': {
      const ids = [action.tabId, action.paneId]
      return updateTask(state, action.taskId, (t) => addChatTab(t, () => ids.shift()!, action.agent))
    }
    case 'chat/split':
      return updateTask(state, action.taskId, (t) => splitActivePaneChat(t, 'right', () => action.paneId, action.agent))
    case 'chat/rewound': {
      const taskId = findPaneTask(state, action.paneId)
      return taskId ? updateTask(state, taskId, (t) => chatRewound(t, action.paneId, action.forkAt)) : state
    }
    case 'chat/branch': {
      const taskId = findPaneTask(state, action.paneId)
      return taskId ? updateTask(state, taskId, (t) => branchChat(t, action.paneId, action.newPaneId, action.forkAt)) : state
    }
    case 'chat/session': {
      const taskId = findPaneTask(state, action.paneId)
      return taskId ? updateTask(state, taskId, (t) => setChatSession(t, action.paneId, action.sessionId)) : state
    }
    case 'chat/to-terminal': {
      const taskId = findPaneTask(state, action.paneId)
      return taskId ? updateTask(state, taskId, (t) => chatToTerminal(t, action.paneId, () => action.newPaneId, action.bin)?.task ?? t) : state
    }
  }
}
