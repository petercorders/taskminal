// 화면 상태의 주인. 순수 reducer — 일감을 만드는 일(새 id · 시각)은 부르는 쪽이 createTask 로 하고 결과를 넘긴다.
import type { AppState, Id, Task } from '../shared/types'

export type Action =
  | { type: 'loaded'; state: AppState }
  | { type: 'task/create'; task: Task }
  | { type: 'task/select'; id: Id }
  | { type: 'task/remove'; id: Id }

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
  }
}
