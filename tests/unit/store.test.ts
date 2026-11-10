import { describe, expect, it } from 'vitest'
import { createTask, emptyState } from '../../src/shared/model'
import type { AppState, Task } from '../../src/shared/types'
import { reducer } from '../../src/renderer/store'

let n = 0
const newId = () => `id${++n}`

const makeTask = (state: AppState, name: string): Task =>
  createTask(
    { name, cwd: '~', templateId: null, statusId: state.settings.statuses[0]!.id, groupId: null, color: null },
    state.settings,
    newId,
    0,
  )

const withTasks = (...names: string[]): AppState => {
  let s = emptyState()
  for (const name of names) s = reducer(s, { type: 'task/create', task: makeTask(s, name) })
  return s
}

describe('reducer', () => {
  it('loaded 는 상태를 통째로 바꾼다', () => {
    const next = withTasks('a')
    expect(reducer(emptyState(), { type: 'loaded', state: next })).toBe(next)
  })

  it('task/create 는 끝에 붙이고 활성 일감으로 만든다', () => {
    const s = withTasks('a', 'b')
    expect(s.tasks.map((t) => t.name)).toEqual(['a', 'b'])
    expect(s.activeTaskId).toBe(s.tasks[1]!.id)
  })

  it('task/select 는 있는 일감만 고른다', () => {
    const s = withTasks('a', 'b')
    const a = s.tasks[0]!.id
    expect(reducer(s, { type: 'task/select', id: a }).activeTaskId).toBe(a)
    expect(reducer(s, { type: 'task/select', id: 'nope' })).toBe(s)
  })

  it('task/remove: 활성 일감을 지우면 오른쪽, 없으면 왼쪽 일감이 활성', () => {
    const s = withTasks('a', 'b', 'c')
    const [a, b, c] = s.tasks.map((t) => t.id) as [string, string, string]
    const midActive = reducer(s, { type: 'task/select', id: b })
    expect(reducer(midActive, { type: 'task/remove', id: b }).activeTaskId).toBe(c)
    expect(reducer(s, { type: 'task/remove', id: c }).activeTaskId).toBe(b) // c 가 활성 · 맨 끝
    const onlyA = reducer(reducer(s, { type: 'task/remove', id: b }), { type: 'task/remove', id: c })
    expect(reducer(onlyA, { type: 'task/remove', id: a })).toMatchObject({ tasks: [], activeTaskId: null })
  })

  it('task/remove: 활성이 아닌 일감을 지우면 활성은 그대로, 없는 id 는 그대로', () => {
    const s = withTasks('a', 'b')
    const [a, b] = s.tasks.map((t) => t.id) as [string, string]
    expect(reducer(s, { type: 'task/remove', id: a }).activeTaskId).toBe(b)
    expect(reducer(s, { type: 'task/remove', id: 'nope' })).toBe(s)
  })
})

describe('reducer — 탭', () => {
  const add = (s: AppState, taskId: string, tabId: string) =>
    reducer(s, { type: 'tab/add', taskId, tabId, paneId: `${tabId}-pane` })
  const tabsOf = (s: AppState, i = 0) => s.tasks[i]!.tabs.map((t) => t.id)
  const activeOf = (s: AppState, i = 0) => s.tasks[i]!.activeTabId

  /** 일감 a(첫 탭 + t2 + t3) · 일감 b */
  const three = () => {
    let s = withTasks('a', 'b')
    const a = s.tasks[0]!.id
    s = add(add(s, a, 't2'), a, 't3')
    return { s, a, first: s.tasks[0]!.tabs[0]!.id }
  }

  it('tab/add: 끝에 붙고 활성, 새 pane 은 넘긴 id · 활성 pane 폴더', () => {
    const { s, a, first } = three()
    expect(tabsOf(s)).toEqual([first, 't2', 't3'])
    expect(activeOf(s)).toBe('t3')
    expect(s.tasks[0]!.panes['t3-pane']).toEqual({ id: 't3-pane', cwd: '~' })
    expect(s.tasks[0]!.tabs[2]!.activePaneId).toBe('t3-pane')
    expect(s.tasks[1]!.tabs).toHaveLength(1) // 다른 일감은 그대로
    expect(add(s, 'nope', 't9')).toBe(s)
    expect(a).toBe(s.tasks[0]!.id)
  })

  it('tab/close: 가운데 활성 → 오른쪽, 끝 활성 → 왼쪽, 비활성 → 그대로', () => {
    const { s, a, first } = three()
    const mid = reducer(s, { type: 'tab/select', taskId: a, tabId: 't2' })
    const afterMid = reducer(mid, { type: 'tab/close', taskId: a, tabId: 't2' })
    expect(tabsOf(afterMid)).toEqual([first, 't3'])
    expect(activeOf(afterMid)).toBe('t3')
    expect(afterMid.tasks[0]!.panes['t2-pane']).toBeUndefined()

    expect(activeOf(reducer(s, { type: 'tab/close', taskId: a, tabId: 't3' }))).toBe('t2')
    expect(activeOf(reducer(s, { type: 'tab/close', taskId: a, tabId: first }))).toBe('t3')
    expect(reducer(s, { type: 'tab/close', taskId: a, tabId: 'nope' })).toBe(s)
  })

  it('tab/select · tab/rename: 있는 일감 · 탭만', () => {
    const { s, a, first } = three()
    expect(activeOf(reducer(s, { type: 'tab/select', taskId: a, tabId: first }))).toBe(first)
    expect(reducer(s, { type: 'tab/select', taskId: a, tabId: 'nope' })).toBe(s)
    expect(reducer(s, { type: 'tab/select', taskId: 'nope', tabId: first })).toBe(s)
    const renamed = reducer(s, { type: 'tab/rename', taskId: a, tabId: 't2', title: ' 로그 ' })
    expect(renamed.tasks[0]!.tabs[1]!.title).toBe('로그')
    expect(reducer(s, { type: 'tab/rename', taskId: 'nope', tabId: 't2', title: 'x' })).toBe(s)
    // 바뀐 것이 없으면 같은 상태 — App 이 저장하지 않는다
    expect(reducer(s, { type: 'tab/select', taskId: a, tabId: 't3' })).toBe(s)
    expect(reducer(s, { type: 'tab/rename', taskId: a, tabId: 't2', title: ' ' })).toBe(s)
  })
})

describe('reducer — 분할', () => {
  const one = () => {
    const s = withTasks('a', 'b')
    const task = s.tasks[0]!
    return { s, a: task.id, tab: task.tabs[0]!.id, p1: task.tabs[0]!.activePaneId }
  }
  const tabOf = (s: AppState) => s.tasks[0]!.tabs[0]!

  it('pane/split: 활성 pane 옆에 넘긴 id 의 pane, 새 pane 이 활성 · 같은 폴더', () => {
    const { s, a, p1 } = one()
    const out = reducer(s, { type: 'pane/split', taskId: a, dir: 'right', paneId: 'n1' })
    expect(tabOf(out).layout).toEqual({ type: 'split', dir: 'right', ratio: 0.5, a: { type: 'pane', paneId: p1 }, b: { type: 'pane', paneId: 'n1' } })
    expect(tabOf(out).activePaneId).toBe('n1')
    expect(out.tasks[0]!.panes['n1']).toEqual({ id: 'n1', cwd: '~' })
    expect(reducer(s, { type: 'pane/split', taskId: 'nope', dir: 'right', paneId: 'n1' })).toBe(s)
  })

  it('pane/exited: 형제가 자리를 차지하고, 마지막 pane 이면 탭이 닫힌다, 모르는 pane 은 같은 상태', () => {
    const { s, a, p1 } = one()
    const two = reducer(s, { type: 'pane/split', taskId: a, dir: 'down', paneId: 'n1' })
    const back = reducer(two, { type: 'pane/exited', paneId: 'n1' })
    expect(tabOf(back).layout).toEqual({ type: 'pane', paneId: p1 })
    expect(tabOf(back).activePaneId).toBe(p1)
    expect(back.tasks[0]!.panes['n1']).toBeUndefined()
    const gone = reducer(back, { type: 'pane/exited', paneId: p1 })
    expect(gone.tasks[0]!.tabs).toEqual([])
    expect(gone.tasks[1]!.tabs).toHaveLength(1) // 다른 일감은 그대로
    expect(reducer(s, { type: 'pane/exited', paneId: 'ghost' })).toBe(s)
  })

  it('pane/focus · pane/ratio', () => {
    const { s, a, tab, p1 } = one()
    const two = reducer(s, { type: 'pane/split', taskId: a, dir: 'right', paneId: 'n1' })
    expect(tabOf(reducer(two, { type: 'pane/focus', taskId: a, paneId: p1 })).activePaneId).toBe(p1)
    expect(reducer(two, { type: 'pane/focus', taskId: a, paneId: 'n1' })).toBe(two)
    expect(tabOf(reducer(two, { type: 'pane/ratio', taskId: a, tabId: tab, path: [], ratio: 0.3 })).layout).toMatchObject({ ratio: 0.3 })
  })
})
