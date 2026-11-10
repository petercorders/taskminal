import { describe, expect, it } from 'vitest'
import { createTask, emptyState } from '../../src/shared/model'
import type { AppState } from '../../src/shared/types'
import { adjacentTask, shortPath, sidebarSections } from '../../src/renderer/sidebar-model'

let n = 0
const newId = () => `id${++n}`

function stateWith(groups: string[], tasks: Array<[name: string, groupId: string | null]>): AppState {
  const s = emptyState()
  s.settings.groups = groups.map((g) => ({ id: g, name: g.toUpperCase() }))
  s.tasks = tasks.map(([name, groupId]) =>
    createTask({ name, cwd: '~', templateId: null, statusId: 'doing', groupId, color: null }, s.settings, newId, 0),
  )
  return s
}

const view = (s: AppState) => sidebarSections(s).map((sec) => [sec.title, sec.tasks.map((t) => t.name)])

describe('sidebarSections', () => {
  it('묶음은 설정 순서대로, 묶음 없는 일감은 맨 끝 "묶음 없음"', () => {
    const s = stateWith(['b', 'a'], [
      ['x', null],
      ['a1', 'a'],
      ['b1', 'b'],
      ['a2', 'a'],
    ])
    expect(view(s)).toEqual([
      ['B', ['b1']],
      ['A', ['a1', 'a2']],
      ['묶음 없음', ['x']],
    ])
  })

  it('일감이 없는 묶음은 숨긴다', () => {
    const s = stateWith(['a', 'empty'], [['a1', 'a']])
    expect(view(s)).toEqual([['A', ['a1']]])
  })

  it('묶음이 하나도 쓰이지 않으면 제목 없는 한 칸', () => {
    const s = stateWith(['a'], [
      ['x', null],
      ['y', null],
    ])
    expect(view(s)).toEqual([[null, ['x', 'y']]])
  })

  it('일감이 없으면 빈 목록', () => {
    expect(sidebarSections(emptyState())).toEqual([])
  })
})

describe('shortPath', () => {
  it('짧은 경로는 그대로, 긴 경로는 끝 두 칸만', () => {
    expect(shortPath('~')).toBe('~')
    expect(shortPath('~/code')).toBe('~/code')
    expect(shortPath('~/code/app')).toBe('~/code/app')
    expect(shortPath('~/code/jjikgyebu/flutter')).toBe('…/jjikgyebu/flutter')
    expect(shortPath('/tmp')).toBe('/tmp')
    expect(shortPath('/Users/me/a/b')).toBe('…/a/b')
    expect(shortPath('/Users/me/a/b/')).toBe('…/a/b')
  })
})

describe('adjacentTask', () => {
  it('사이드바에 보이는 순서(묶음 순)로 다음 · 이전, 끝에서 돈다', () => {
    const s = stateWith(['b', 'a'], [
      ['x', null],
      ['a1', 'a'],
      ['b1', 'b'],
    ]) // 보이는 순서: b1, a1, x
    const id = (name: string) => s.tasks.find((t) => t.name === name)!.id
    s.activeTaskId = id('b1')
    expect(adjacentTask(s, 1)).toBe(id('a1'))
    expect(adjacentTask(s, -1)).toBe(id('x'))
    s.activeTaskId = id('x')
    expect(adjacentTask(s, 1)).toBe(id('b1'))
  })

  it('일감이 없으면 null, 활성이 없으면 첫 일감', () => {
    expect(adjacentTask(emptyState(), 1)).toBeNull()
    const s = stateWith([], [['a', null], ['b', null]])
    s.activeTaskId = null
    expect(adjacentTask(s, 1)).toBe(s.tasks[0]!.id)
  })
})
