// 화면 상태의 주인. 순수 reducer — 새 id · 시각은 부르는 쪽이 만들어 넘긴다.
import { addTab, closeTab, renameTab, selectTab } from '../shared/model'
import type { AppState, Id, Task } from '../shared/types'

export type Action =
  | { type: 'loaded'; state: AppState }
  | { type: 'task/create'; task: Task }
  | { type: 'task/select'; id: Id }
  | { type: 'task/remove'; id: Id }
  | { type: 'tab/add'; taskId: Id; tabId: Id; paneId: Id }
  | { type: 'tab/select'; taskId: Id; tabId: Id }
  | { type: 'tab/close'; taskId: Id; tabId: Id }
  | { type: 'tab/rename'; taskId: Id; tabId: Id; title: string }

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
      const ids = [action.tabId, action.paneId]
      return updateTask(state, action.taskId, (t) => addTab(t, () => ids.shift()!))
    }
    case 'tab/select':
      return updateTask(state, action.taskId, (t) => selectTab(t, action.tabId))
    case 'tab/close':
      return updateTask(state, action.taskId, (t) => closeTab(t, action.tabId))
    case 'tab/rename':
      return updateTask(state, action.taskId, (t) => renameTab(t, action.tabId, action.title))
  }
}
