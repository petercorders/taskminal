import { describe, expect, it } from 'vitest'
import {
  addGroup,
  addStatus,
  defaultTaskCwd,
  editTask,
  emptyState,
  moveGroup,
  moveStatus,
  removeStatus,
  removeTemplate,
  renameGroup,
  renameTemplate,
  toggleGroup,
  updateStatus,
} from '../../src/shared/model'
import type { AppState, Task } from '../../src/shared/types'

const task = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  name: id,
  cwd: `/w/${id}`,
  statusId: 'doing',
  groupId: null,
  color: null,
  tabs: [],
  activeTabId: null,
  panes: {},
  createdAt: 1,
  ...over,
})

const state = (): AppState => {
  const s = emptyState()
  return {
    ...s,
    tasks: [task('a', { statusId: 'wait', groupId: 'g1' }), task('b', { createdAt: 5 })],
    settings: { ...s.settings, groups: [{ id: 'g1', name: '찍계부' }, { id: 'g2', name: '서버' }], defaultTemplateId: 'tpl-claude' },
  }
}

describe('상태 고치기', () => {
  it('추가: 끝에, 빈 이름은 "새 상태"', () => {
    const s = addStatus(addStatus(state(), 's1', ' 리뷰 중 ', '#c4a5ff'), 's2', '  ', '#fff')
    expect(s.settings.statuses.slice(-2)).toEqual([
      { id: 's1', name: '리뷰 중', color: '#c4a5ff' },
      { id: 's2', name: '새 상태', color: '#fff' },
    ])
  })

  it('이름 · 색 바꾸기, 빈 이름은 무시, 없는 상태 · 바뀐 것 없음은 같은 상태', () => {
    const s0 = state()
    const s = updateStatus(s0, 'wait', { name: '보류', color: '#123' })
    expect(s.settings.statuses.find((x) => x.id === 'wait')).toEqual({ id: 'wait', name: '보류', color: '#123' })
    expect(updateStatus(s0, 'wait', { name: '  ' }).settings.statuses.find((x) => x.id === 'wait')!.name).toBe('대기')
    expect(updateStatus(s0, 'nope', { name: 'x' })).toBe(s0)
    expect(updateStatus(s0, 'wait', { name: '대기' })).toBe(s0)
  })

  it('순서 옮기기: 한 칸씩, 끝에서는 그대로', () => {
    const s0 = state()
    expect(moveStatus(s0, 'wait', -1).settings.statuses.map((x) => x.id)).toEqual(['wait', 'doing', 'done'])
    expect(moveStatus(s0, 'wait', 1).settings.statuses.map((x) => x.id)).toEqual(['doing', 'done', 'wait'])
    expect(moveStatus(s0, 'doing', -1)).toBe(s0)
    expect(moveStatus(s0, 'done', 1)).toBe(s0)
  })

  it('지운 뒤 같은 이름으로 다시 추가하면 새 항목 — 옮겨진 일감은 그대로', () => {
    const s = addStatus(removeStatus(state(), 'wait'), 'new-wait', '대기', '#e5b567')
    expect(s.tasks[0]!.statusId).toBe('doing')
    expect(s.settings.statuses.map((x) => x.id)).toEqual(['doing', 'done', 'new-wait'])
  })
})

describe('묶음 고치기', () => {
  it('추가 · 이름 · 순서 · 접기', () => {
    let s = addGroup(state(), 'g3', ' 개인 ')
    expect(s.settings.groups.at(-1)).toEqual({ id: 'g3', name: '개인' })
    s = renameGroup(s, 'g3', '집')
    expect(s.settings.groups.at(-1)!.name).toBe('집')
    s = moveGroup(s, 'g3', -1)
    expect(s.settings.groups.map((g) => g.id)).toEqual(['g1', 'g3', 'g2'])
    s = toggleGroup(s, 'g1')
    expect(s.settings.groups[0]).toEqual({ id: 'g1', name: '찍계부', collapsed: true })
    s = toggleGroup(s, 'g1')
    expect(s.settings.groups[0]).toEqual({ id: 'g1', name: '찍계부' })
  })

  it('빈 이름 · 없는 묶음은 그대로', () => {
    const s0 = state()
    expect(renameGroup(s0, 'g1', ' ')).toBe(s0)
    expect(toggleGroup(s0, 'nope')).toBe(s0)
    expect(addGroup(s0, 'g3', '').settings.groups.at(-1)!.name).toBe('새 묶음')
  })
})

describe('템플릿 고치기', () => {
  it('이름 바꾸기 · 지우기 — 기본 템플릿을 지우면 기본은 없음', () => {
    let s = renameTemplate(state(), 'tpl-claude', 'Claude')
    expect(s.settings.templates.find((t) => t.id === 'tpl-claude')!.name).toBe('Claude')
    s = removeTemplate(s, 'tpl-claude')
    expect(s.settings.templates.map((t) => t.id)).toEqual(['tpl-basic'])
    expect(s.settings.defaultTemplateId).toBeNull()
    const keep = removeTemplate(state(), 'tpl-basic')
    expect(keep.settings.defaultTemplateId).toBe('tpl-claude')
  })
})

describe('editTask (우클릭 메뉴)', () => {
  it('이름 · 상태 · 묶음 · 색', () => {
    const s = editTask(state(), 'b', { name: ' 서버 ', statusId: 'done', groupId: 'g2', color: '#5b9cf5' })
    expect(s.tasks[1]).toMatchObject({ name: '서버', statusId: 'done', groupId: 'g2', color: '#5b9cf5' })
    expect(editTask(s, 'b', { groupId: null, color: null }).tasks[1]).toMatchObject({ groupId: null, color: null })
  })

  it('없는 상태 · 묶음 · 빈 이름 · 없는 일감 · 바뀐 것 없음은 같은 상태', () => {
    const s0 = state()
    expect(editTask(s0, 'b', { statusId: 'nope' })).toBe(s0)
    expect(editTask(s0, 'b', { groupId: 'nope' })).toBe(s0)
    expect(editTask(s0, 'b', { name: '  ' })).toBe(s0)
    expect(editTask(s0, 'zz', { name: 'x' })).toBe(s0)
    expect(editTask(s0, 'a', { statusId: 'wait' })).toBe(s0)
  })
})

describe('defaultTaskCwd (새 일감 기본 폴더)', () => {
  it('설정한 폴더 → 없으면 가장 나중에 만든 일감의 폴더 → 없으면 ~', () => {
    const s = state()
    expect(defaultTaskCwd({ ...s, settings: { ...s.settings, defaultCwd: ' ~/code ' } })).toBe('~/code')
    expect(defaultTaskCwd(s)).toBe('/w/b')
    expect(defaultTaskCwd(emptyState())).toBe('~')
  })
})
