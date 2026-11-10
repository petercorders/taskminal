// 화면 상태의 주인. 순수 reducer — 새 id · 시각은 부르는 쪽이 만들어 넘긴다.
import { clampFontSize } from '../shared/keymap'
import type { SplitPath } from '../shared/layout'
import {
  addGroup,
  addStatus,
  addTab,
  closePane,
  closeTab,
  cycleActivePane,
  cycleTab,
  editTask,
  findPaneTask,
  focusPane,
  moveGroup,
  moveStatus,
  removeGroup,
  removeStatus,
  removeTemplate,
  renameGroup,
  renameTab,
  renameTemplate,
  selectTab,
  selectTabAt,
  setTabRatio,
  splitActivePane,
  toggleGroup,
  updateStatus,
  type TaskEdit,
} from '../shared/model'
import type { AppState, Id, Settings, SplitDir, Task } from '../shared/types'

/** 설정 창에서 바로 바꾸는 값 (상태 · 묶음 · 템플릿 목록은 따로) */
export type SettingsPatch = Partial<Omit<Settings, 'statuses' | 'groups' | 'templates'>>

export type Action =
  | { type: 'loaded'; state: AppState }
  | { type: 'task/create'; task: Task }
  | { type: 'task/select'; id: Id }
  | { type: 'task/remove'; id: Id }
  | { type: 'tab/add'; taskId: Id; tabId: Id; paneId: Id }
  | { type: 'tab/select'; taskId: Id; tabId: Id }
  | { type: 'tab/close'; taskId: Id; tabId: Id }
  | { type: 'tab/rename'; taskId: Id; tabId: Id; title: string }
  /** n번째 탭(1부터), 9 = 마지막 */
  | { type: 'tab/nth'; taskId: Id; n: number }
  | { type: 'tab/cycle'; taskId: Id; step: 1 | -1 }
  | { type: 'pane/cycle'; taskId: Id; step: 1 | -1 }
  | { type: 'settings/font'; size: number }
  | { type: 'pane/split'; taskId: Id; dir: SplitDir; paneId: Id }
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
  | { type: 'task/edit'; id: Id; patch: TaskEdit }

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
        const out = addTab(t, next)
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
    case 'pane/split':
      return updateTask(state, action.taskId, (t) => splitActivePane(t, action.dir, () => action.paneId))
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
    case 'task/edit':
      return editTask(state, action.id, action.patch)
  }
}
