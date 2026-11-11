import { describe, expect, it } from 'vitest'
import { archiveTask, unarchiveTask, visibleTasks, archiveSuggestions, searchArchive, recentlyDeleted, ARCHIVE_SUGGEST_MS, RECENT_DELETED_MS } from '../../src/shared/archive'
import { emptyState, normalizeState } from '../../src/shared/model'
import type { AppState, Task } from '../../src/shared/types'

const DAY = 24 * 3600 * 1000
function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    name: `일감 ${id}`,
    cwd: `/tmp/${id}`,
    statusId: 'doing',
    groupId: null,
    color: null,
    tabs: [
      { id: `${id}-t1`, layout: { type: 'split', dir: 'right', ratio: 0.5, a: { type: 'pane', paneId: `${id}-p1` }, b: { type: 'pane', paneId: `${id}-c1` } }, activePaneId: `${id}-p1` },
    ],
    activeTabId: `${id}-t1`,
    panes: {
      [`${id}-p1`]: { id: `${id}-p1`, cwd: `/tmp/${id}/a` },
      [`${id}-c1`]: { id: `${id}-c1`, cwd: `/tmp/${id}`, kind: 'chat', chat: { agent: 'claude', sessionId: 's1' } },
    },
    createdAt: 1000,
    ...over,
  } as Task
}
function state(tasks: Task[], active: string | null = tasks[0]?.id ?? null): AppState {
  return { ...emptyState(), tasks, activeTaskId: active }
}

describe('archiveTask · unarchiveTask', () => {
  it('보관하면 archivedAt 이 붙고, 활성이면 다음 보이는 일감으로 옮긴다', () => {
    const s = archiveTask(state([task('a'), task('b'), task('c')], 'b'), 'b', 500)
    expect(s.tasks.find((t) => t.id === 'b')!.archivedAt).toBe(500)
    expect(s.activeTaskId).toBe('c')
    const s2 = archiveTask(s, 'c', 600)
    expect(s2.activeTaskId).toBe('a') // 오른쪽 보이는 것이 없으면 왼쪽
  })
  it('이미 보관됐거나 없는 일감은 그대로(같은 객체)', () => {
    const s = archiveTask(state([task('a')]), 'a', 1)
    expect(archiveTask(s, 'a', 2)).toBe(s)
    expect(archiveTask(s, 'zz', 2)).toBe(s)
  })
  it('되살리면 터미널 pane 만 새 id · 대화 pane 은 그대로 · 탭 활성 pane 도 따라간다 · 그 일감이 활성', () => {
    let n = 0
    const s = archiveTask(state([task('a'), task('b')]), 'a', 1)
    const r = unarchiveTask(s, 'a', () => `new${++n}`)!
    const t = r.tasks.find((x) => x.id === 'a')!
    expect(t.archivedAt).toBeUndefined()
    expect(Object.keys(t.panes).sort()).toEqual(['a-c1', 'new1'])
    expect(t.panes['new1']).toMatchObject({ id: 'new1', cwd: '/tmp/a/a' })
    expect(t.tabs[0]!.activePaneId).toBe('new1')
    expect(JSON.stringify(t.tabs[0]!.layout)).toContain('"new1"')
    expect(JSON.stringify(t.tabs[0]!.layout)).toContain('"a-c1"')
    expect(r.activeTaskId).toBe('a')
  })
  it('보관되지 않은 일감을 되살리기는 null (두 번 눌러도 한 번)', () => {
    expect(unarchiveTask(state([task('a')]), 'a', () => 'x')).toBeNull()
    expect(unarchiveTask(state([task('a')]), 'nope', () => 'x')).toBeNull()
  })
})

describe('visibleTasks · archiveSuggestions · searchArchive', () => {
  it('보관 일감은 보이는 목록에서 빠진다', () => {
    const s = archiveTask(state([task('a'), task('b')]), 'a', 1)
    expect(visibleTasks(s).map((t) => t.id)).toEqual(['b'])
  })
  it('보관 제안 = 마지막 상태이고 마지막으로 본 때(없으면 만든 때)가 7일 넘음, 이미 보관한 것은 빼고', () => {
    const now = 100 * DAY
    const s = state([
      task('old', { statusId: 'done', lastViewedAt: now - ARCHIVE_SUGGEST_MS - 1 }),
      task('fresh', { statusId: 'done', lastViewedAt: now - DAY }),
      task('doing', { statusId: 'doing', createdAt: 0 }),
      task('made', { statusId: 'done', createdAt: 0 }),
      task('gone', { statusId: 'done', createdAt: 0, archivedAt: 5 }),
    ])
    expect(archiveSuggestions(s, now).map((t) => t.id)).toEqual(['old', 'made'])
  })
  it('찾기는 이름 · 폴더 · 메모에서, 대소문자 가리지 않음, 빈 글이면 전부(보관 일감만, 최근 보관 먼저)', () => {
    const s = state([
      task('a', { archivedAt: 1, name: 'NAS 배포' }),
      task('b', { archivedAt: 3, cwd: '/Users/me/jjik' }),
      task('c', { archivedAt: 2, notes: [{ id: 'n', text: '정산 응답 칸', at: 1 }] }),
      task('d', { name: 'nas 보이는 것' }),
    ])
    expect(searchArchive(s, '').map((t) => t.id)).toEqual(['b', 'c', 'a'])
    expect(searchArchive(s, 'nas').map((t) => t.id)).toEqual(['a'])
    expect(searchArchive(s, 'JJIK').map((t) => t.id)).toEqual(['b'])
    expect(searchArchive(s, '정산').map((t) => t.id)).toEqual(['c'])
  })
})

describe('normalizeState — 25단계 칸', () => {
  it('archivedAt · host · remoteTmux 를 읽고 이상한 값은 버린다', () => {
    const raw = {
      tasks: [
        { ...task('a'), archivedAt: 123, host: 'nas', remoteTmux: false },
        { ...task('b'), archivedAt: 'x', host: '-oProxyCommand=sh', remoteTmux: false },
        { ...task('c'), host: 'peter@10.0.0.1', remoteTmux: true },
      ],
    }
    const s = normalizeState(raw, () => 'n')
    expect(s.tasks.map((t) => [t.archivedAt, t.host, t.remoteTmux])).toEqual([
      [123, 'nas', false],
      [undefined, undefined, undefined],
      [undefined, 'peter@10.0.0.1', undefined],
    ])
  })
})

describe('recentlyDeleted', () => {
  it('지금 없는 일감만 · 가장 새 백업의 모습 · 30일 밖은 뺀다 · 같은 일감은 한 번', () => {
    const now = 40 * DAY
    const cur = state([task('keep')])
    const older = { name: 'b1', at: now - 5 * DAY, state: state([task('keep'), task('x', { name: '옛 이름' })]) }
    const newer = { name: 'b2', at: now - 1 * DAY, state: state([task('keep'), task('x', { name: '새 이름' }), task('y')]) }
    const tooOld = { name: 'b0', at: now - RECENT_DELETED_MS - 1, state: state([task('z')]) }
    const r = recentlyDeleted([older, tooOld, newer], cur, now)
    expect(r.map((d) => [d.task.id, d.task.name, d.backup])).toEqual([
      ['x', '새 이름', 'b2'],
      ['y', '일감 y', 'b2'],
    ])
  })
})
