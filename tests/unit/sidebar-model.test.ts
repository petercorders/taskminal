import { describe, expect, it } from 'vitest'
import { createTask, emptyState } from '../../src/shared/model'
import type { AppState } from '../../src/shared/types'
import { shortPath, sidebarSections } from '../../src/renderer/sidebar-model'

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
