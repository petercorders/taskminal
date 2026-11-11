import { describe, expect, it } from 'vitest'
import { createTask, emptyState } from '../../src/shared/model'
import type { AppState } from '../../src/shared/types'
import { adjacentTask, nextAttention, shortPath, sidebarSections } from '../../src/renderer/sidebar-model'

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

describe('nextAttention (⇧⌘A)', () => {
  const att = { state: 'waiting' as const, attention: true, busy: true }
  it('사이드바 순서 → 탭 순서 → 화면 순서로, 주의 있는 pane 만', () => {
    const s = stateWith(['b', 'a'], [
      ['x', null],
      ['a1', 'a'],
      ['b1', 'b'],
    ]) // 보이는 순서: b1, a1, x
    const pane = (name: string) => s.tasks.find((t) => t.name === name)!.tabs[0]!.activePaneId
    const activity = { [pane('x')]: att, [pane('b1')]: att, [pane('a1')]: { ...att, attention: false } }
    const first = nextAttention(s, activity, null)!
    expect(first).toMatchObject({ paneId: pane('b1'), taskId: s.tasks.find((t) => t.name === 'b1')!.id })
    expect(nextAttention(s, activity, first.paneId)!.paneId).toBe(pane('x')) // a1 은 주의가 없어 건너뛴다
  })

  it('지금 보는 pane 다음 것, 끝이면 처음, 없으면 null', () => {
    const s = stateWith([], [['p', null], ['q', null], ['r', null]])
    const pane = (i: number) => s.tasks[i]!.tabs[0]!.activePaneId
    const activity = { [pane(0)]: att, [pane(2)]: att }
    expect(nextAttention(s, activity, pane(0))?.paneId).toBe(pane(2))
    expect(nextAttention(s, activity, pane(2))?.paneId).toBe(pane(0))
    expect(nextAttention(s, activity, pane(1))?.paneId).toBe(pane(2))
    expect(nextAttention(s, activity, null)?.paneId).toBe(pane(0))
    expect(nextAttention(s, {}, null)).toBeNull()
  })
})

// ─── 21단계 흐름 보기 ───
import { countBar, filterTasks, flowSections, lastLine, timeAgo, unreadTasks } from '../../src/renderer/sidebar-model'
import type { PaneActivity } from '../../src/shared/activity'

function flowState(): AppState {
  const s = emptyState()
  s.settings.groups = [{ id: 'g', name: '서버' }]
  const mk = (name: string, statusId: string, groupId: string | null = null) =>
    createTask({ name, cwd: `/code/${name}`, templateId: null, statusId, groupId, color: null }, s.settings, newId, 0)
  s.tasks = [mk('a', 'doing', 'g'), mk('b', 'wait'), mk('c', 'done'), mk('d', 'doing'), mk('e', 'wait')]
  return s
}
const paneOf = (s: AppState, name: string) => Object.keys(s.tasks.find((t) => t.name === name)!.panes)[0]!
const act = (state: PaneActivity['state'], extra: Partial<PaneActivity> = {}): PaneActivity => ({ state, busy: state === 'running', attention: false, ...extra })

describe('flowSections', () => {
  it('확인 필요 → 상태 순서대로, 확인 필요인 일감은 자기 상태 칸에서 빠진다', () => {
    const s = flowState()
    const activity = { [paneOf(s, 'b')]: act('waiting', { attention: true }) }
    const secs = flowSections(s, activity, new Set(), '')
    expect(secs.map((x) => [x.key, x.tasks.map((t) => t.name)])).toEqual([
      ['need', ['b']],
      ['doing', ['a', 'd']],
      ['wait', ['e']],
      ['done', ['c']],
    ])
  })
  it('없는 상태의 일감은 첫 상태 칸 · 마지막 상태(완료)의 일감은 확인 필요로 올리지 않는다', () => {
    const s = flowState()
    s.tasks[0]!.statusId = 'gone'
    const activity = { [paneOf(s, 'c')]: act('failed', { attention: true }) }
    const secs = flowSections(s, activity, new Set(), '')
    expect(secs.find((x) => x.key === 'doing')!.tasks.map((t) => t.name)).toEqual(['a', 'd'])
    expect(secs.find((x) => x.key === 'need')!.tasks).toEqual([])
    expect(secs.find((x) => x.key === 'done')!.tasks.map((t) => t.name)).toEqual(['c'])
  })
  it('안 본 끝남도 확인 필요', () => {
    const s = flowState()
    const d = s.tasks.find((t) => t.name === 'd')!
    expect(flowSections(s, {}, new Set([d.id]), '').find((x) => x.key === 'need')!.tasks.map((t) => t.name)).toEqual(['d'])
  })
  it('거르기: 이름 · 폴더 · 묶음 · 브랜치, 대소문자 무시', () => {
    const s = flowState()
    expect(filterTasks(s.tasks, '서버', s.settings.groups, {}).map((t) => t.name)).toEqual(['a'])
    expect(filterTasks(s.tasks, 'CODE/B', s.settings.groups, {}).map((t) => t.name)).toEqual(['b'])
    expect(filterTasks(s.tasks, 'feat', s.settings.groups, { '/code/e': 'feat/x' }).map((t) => t.name)).toEqual(['e'])
    expect(filterTasks(s.tasks, '  ', s.settings.groups, {})).toHaveLength(5)
    expect(flowSections(s, {}, new Set(), 'zzz').every((x) => x.tasks.length === 0)).toBe(true)
  })
})

describe('countBar · unreadTasks · lastLine · timeAgo', () => {
  it('막대: 확인 · 실행 · 끝남 · 조용 — 마지막 상태(완료) 일감은 세지 않는다', () => {
    const s = flowState()
    const activity = { [paneOf(s, 'a')]: act('running'), [paneOf(s, 'b')]: act('waiting', { attention: true }), [paneOf(s, 'd')]: act('done') }
    expect(countBar(s, activity, new Set())).toEqual({ need: 1, run: 1, done: 1, idle: 1 })
  })
  it('안 본 것: 그 일감을 마지막으로 본 뒤 끝난 pane 이 있으면, 지금 보는 일감은 아님', () => {
    const s = flowState()
    const a = s.tasks[0]!
    const b = s.tasks[1]!
    const activity = { [paneOf(s, 'a')]: act('done', { endedAt: 50 }), [paneOf(s, 'b')]: act('failed', { endedAt: 50 }) }
    s.activeTaskId = b.id
    expect([...unreadTasks(s, activity, { [a.id]: 10 })]).toEqual([a.id])
    expect([...unreadTasks(s, activity, { [a.id]: 60 })]).toEqual([])
  })
  it('마지막 한 줄: 기다림 · 실패 · 실행 · 끝남, 없으면 null', () => {
    const s = flowState()
    const t = s.tasks[0]!
    const p = paneOf(s, 'a')
    expect(lastLine(t, {})).toBeNull()
    expect(lastLine(t, { [p]: act('failed', { command: 'npm test', exitCode: 1 }) })).toEqual({ text: '✗ npm test · exit 1', tone: 'err' })
    expect(lastLine(t, { [p]: act('waiting', { attention: true, message: '허락이 필요해요 · Bash' }) })).toEqual({ text: '허락이 필요해요 · Bash', tone: 'wait' })
    expect(lastLine(t, { [p]: act('running', { command: 'npm run dev' }) })).toEqual({ text: '● npm run dev', tone: 'run' })
    expect(lastLine(t, { [p]: act('done', { command: 'ls' }) })).toEqual({ text: '✓ ls', tone: 'dim' })
  })
  it('몇 분 전', () => {
    expect(timeAgo(1000, 1000 + 20_000)).toBe('방금')
    expect(timeAgo(0, 5 * 60_000)).toBe('5분')
    expect(timeAgo(0, 3 * 3600_000)).toBe('3시간')
    expect(timeAgo(0, 50 * 3600_000)).toBe('2일')
  })
})

// 작은 고침(2026-11-11): 흐름 보기 상태 옮기기 ⌃⌘← / ⌃⌘→
import { stepStatus } from '../../src/renderer/sidebar-model'

describe('stepStatus', () => {
  it('설정 상태 순서로 다음 · 이전 상태 id', () => {
    const s = flowState()
    const a = s.tasks.find((t) => t.name === 'a')!.id // doing
    expect(stepStatus(s, a, 1)).toBe('wait')
    expect(stepStatus(s, a, -1)).toBeNull() // 첫 칸에서 이전은 없음
    const b = s.tasks.find((t) => t.name === 'b')!.id // wait
    expect(stepStatus(s, b, 1)).toBe('done')
    expect(stepStatus(s, b, -1)).toBe('doing')
  })
  it('끝에서는 돌지 않는다 — 완료에서 다음은 null', () => {
    const s = flowState()
    const c = s.tasks.find((t) => t.name === 'c')!.id // done
    expect(stepStatus(s, c, 1)).toBeNull()
    expect(stepStatus(s, c, -1)).toBe('wait')
  })
  it('모르는 상태는 첫 칸으로 보고 거기서 옮긴다 (흐름 보기와 같은 규칙)', () => {
    const s = flowState()
    s.tasks[0]!.statusId = 'gone'
    expect(stepStatus(s, s.tasks[0]!.id, 1)).toBe('wait')
    expect(stepStatus(s, s.tasks[0]!.id, -1)).toBeNull()
  })
  it('없는 일감 · 상태가 하나뿐이면 null', () => {
    const s = flowState()
    expect(stepStatus(s, 'nope', 1)).toBeNull()
    s.settings.statuses = [s.settings.statuses[0]!]
    expect(stepStatus(s, s.tasks[0]!.id, 1)).toBeNull()
  })
})
