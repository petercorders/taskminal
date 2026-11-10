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
