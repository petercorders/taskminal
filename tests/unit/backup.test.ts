import { describe, expect, it } from 'vitest'
import {
  backupName,
  backupReasonFor,
  diffStates,
  exportText,
  groupBackups,
  mergeState,
  parseBackupName,
  pruneBackups,
  restoreAll,
  restoreTask,
  type BackupEntry,
} from '../../src/shared/backup'
import { emptyState } from '../../src/shared/model'
import type { AppState, Task } from '../../src/shared/types'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const SEOUL = -540
// 2026-11-11 12:00 서울
const NOW = Date.UTC(2026, 10, 11, 3, 0, 0)

function task(id: string, panes: string[], extra: Partial<Task> = {}): Task {
  return {
    id,
    name: `일감 ${id}`,
    cwd: '/tmp',
    statusId: 'doing',
    groupId: null,
    color: null,
    tabs: panes.map((p, i) => ({ id: `${id}-tab${i}`, layout: { type: 'pane', paneId: p }, activePaneId: p })),
    activeTabId: panes.length ? `${id}-tab0` : null,
    panes: Object.fromEntries(panes.map((p) => [p, { id: p, cwd: '/tmp' }])),
    createdAt: 1,
    ...extra,
  }
}
function state(tasks: Task[]): AppState {
  return { ...emptyState(), tasks, activeTaskId: tasks[0]?.id ?? null }
}
let n = 0
const newId = () => `new${++n}`

describe('이름', () => {
  it('이름 ↔ 시각 · 이유', () => {
    const name = backupName(NOW + 123, 'delete')
    expect(name).toBe('state-20261111T030000123Z-delete.json')
    expect(parseBackupName(name)).toEqual({ name, at: NOW + 123, reason: 'delete' })
  })
  it.each(['../state-20261111T030000123Z-delete.json', 'state-20261111T030000123Z-evil.json', 'state-20261311T030000123Z-start.json', 'state.json', 'state-20261111T030000123Z-start.json.tmp'])('모르는 모양은 null: %s', (name) => {
    expect(parseBackupName(name)).toBeNull()
  })
})

describe('보존 규칙', () => {
  const e = (ageMs: number, reason: BackupEntry['reason'] = 'auto'): BackupEntry => ({ name: backupName(NOW - ageMs, reason), at: NOW - ageMs, reason })
  it('24시간 안은 모두 남긴다', () => {
    expect(pruneBackups([e(HOUR), e(2 * HOUR), e(23 * HOUR)], NOW, SEOUL)).toEqual([])
  })
  it('24시간 ~ 30일은 하루 하나 — 그날 마지막', () => {
    // 서울 11-09 의 09:00 · 18:00 · 20:00
    const at = (h: number) => Date.UTC(2026, 10, 9, h - 9)
    const list = [9, 18, 20].map((h) => ({ name: backupName(at(h), 'auto'), at: at(h), reason: 'auto' as const }))
    const drop = pruneBackups([e(HOUR), ...list], NOW, SEOUL)
    expect(drop.sort()).toEqual([list[0]!.name, list[1]!.name].sort())
  })
  it('30일이 지나면 지운다 — 버전 올리기 전은 90일', () => {
    const old = e(40 * DAY)
    const ver = e(40 * DAY + HOUR, 'version')
    const veryOld = e(91 * DAY, 'version')
    expect(pruneBackups([e(HOUR), old, ver, veryOld], NOW, SEOUL).sort()).toEqual([old.name, veryOld.name].sort())
  })
  it('가장 새 것은 오래돼도 남긴다', () => {
    expect(pruneBackups([e(100 * DAY)], NOW, SEOUL)).toEqual([])
  })
})

describe('묶음', () => {
  it('오늘 · 어제 · 이번 주 · 그 전 — 빈 것은 뺀다', () => {
    const mk = (ageMs: number) => ({ name: String(ageMs), at: NOW - ageMs, reason: 'auto' as const })
    const groups = groupBackups([mk(HOUR), mk(DAY), mk(3 * DAY), mk(20 * DAY)], NOW, SEOUL)
    expect(groups.map((g) => [g.title, g.items.length])).toEqual([
      ['오늘', 1],
      ['어제', 1],
      ['이번 주', 1],
      ['그 전', 1],
    ])
    expect(groupBackups([mk(HOUR)], NOW, SEOUL).map((g) => g.id)).toEqual(['today'])
  })
})

describe('백업할 이유', () => {
  const a = state([task('a', ['p1', 'p2']), task('b', ['p3'])])
  it('처음(직전 없음)은 없음', () => expect(backupReasonFor(null, a)).toBeNull())
  it('일감이 사라짐 = 지움', () => expect(backupReasonFor(a, state([a.tasks[0]!]))).toBe('delete'))
  it('탭이 사라짐 = 지움', () => expect(backupReasonFor(a, state([task('a', ['p1']), a.tasks[1]!]))).toBe('delete'))
  it('설정이 바뀜', () => expect(backupReasonFor(a, { ...a, settings: { ...a.settings, fontSize: 20 } })).toBe('settings'))
  it('묶음 접기 · 활성 일감만 바뀜은 이유가 아님', () => {
    const g = { ...a, settings: { ...a.settings, groups: [{ id: 'g', name: 'G' }] } }
    expect(backupReasonFor(g, { ...g, activeTaskId: 'b', settings: { ...g.settings, groups: [{ id: 'g', name: 'G', collapsed: true }] } })).toBeNull()
  })
  it('일감이 늘기만 하면 없음', () => expect(backupReasonFor(a, state([...a.tasks, task('c', ['p9'])]))).toBeNull())
})

describe('미리 보기 비교', () => {
  it('다시 생김 · 사라짐 · 바뀜 · 설정 · 템플릿', () => {
    const cur = state([task('a', ['p1']), task('c', ['p5'])])
    const snap = state([task('a', ['p1', 'p2']), task('b', ['p3'])])
    snap.settings = { ...snap.settings, fontSize: 18, templates: snap.settings.templates.slice(1) }
    const d = diffStates(cur, snap)
    expect(d.back.map((t) => t.id)).toEqual(['b'])
    expect(d.gone.map((t) => t.id)).toEqual(['c'])
    expect(d.changed).toEqual([{ id: 'a', name: '일감 a', tabs: 2, tabsNow: 1, nameNow: '일감 a' }])
    expect(d.settings).toEqual(expect.arrayContaining(['글자 크기', '템플릿']))
    expect(d.templates).toEqual({ back: [], gone: ['기본'] })
    expect(d.same).toBe(false)
  })
  it('같으면 same', () => {
    const s = state([task('a', ['p1'])])
    expect(diffStates(s, structuredClone(s)).same).toBe(true)
  })
})

describe('일감 하나 되살리기', () => {
  it('지운 일감을 원래 순서 자리에 · 그 일감을 연다 · 끝낼 셸 없음', () => {
    const snap = state([task('a', ['p1']), task('b', ['p2']), task('c', ['p3'])])
    const cur = state([task('a', ['p1']), task('c', ['p3'])])
    const r = restoreTask(cur, snap, 'b', newId)!
    expect(r.state.tasks.map((t) => t.id)).toEqual(['a', 'b', 'c'])
    expect(r.state.activeTaskId).toBe('b')
    expect(r.state.tasks[1]!.panes['p2']).toBeDefined() // 같은 id — 지킴이에 남은 셸이면 다시 붙는다
    expect(r.kill).toEqual([])
  })
  it('지금 있으면 그 자리에서 바꾸고 사라질 pane 을 알린다', () => {
    const snap = state([task('a', ['p1'])])
    const cur = state([task('x', ['p0']), task('a', ['p1', 'p9'])])
    const r = restoreTask(cur, snap, 'a', newId)!
    expect(r.state.tasks.map((t) => t.id)).toEqual(['x', 'a'])
    expect(Object.keys(r.state.tasks[1]!.panes)).toEqual(['p1'])
    expect(r.kill).toEqual(['p9'])
  })
  it('다른 일감과 겹치는 탭 · pane id 는 새 id', () => {
    const snap = state([task('b', ['p1'])])
    const cur = state([task('a', ['p1'])])
    cur.tasks[0]!.tabs[0]!.id = 'b-tab0'
    const r = restoreTask(cur, snap, 'b', () => 'fresh')!
    const b = r.state.tasks.find((t) => t.id === 'b')!
    expect(Object.keys(b.panes)).toEqual(['fresh'])
    expect(b.tabs[0]).toMatchObject({ id: 'fresh', layout: { type: 'pane', paneId: 'fresh' }, activePaneId: 'fresh' })
    expect(b.activeTabId).toBe('fresh')
  })
  it('지금 없는 상태 · 묶음은 백업 설정에서 가져온다', () => {
    const snap = state([task('b', ['p2'], { statusId: 'review', groupId: 'g1' })])
    snap.settings = { ...snap.settings, statuses: [...snap.settings.statuses, { id: 'review', name: '검토', color: '#fff' }], groups: [{ id: 'g1', name: '서버' }] }
    const r = restoreTask(state([]), snap, 'b', newId)!
    expect(r.state.settings.statuses.map((s) => s.id)).toContain('review')
    expect(r.state.settings.groups).toEqual([{ id: 'g1', name: '서버' }])
    expect(r.state.tasks[0]).toMatchObject({ statusId: 'review', groupId: 'g1' })
  })
  it('어디에도 없는 참조는 첫 상태 · 묶음 없음', () => {
    const snap = state([task('b', ['p2'], { statusId: 'gone', groupId: 'gone' })])
    const r = restoreTask(state([]), snap, 'b', newId)!
    expect(r.state.tasks[0]).toMatchObject({ statusId: 'doing', groupId: null })
  })
  it('백업에 없는 일감은 null', () => expect(restoreTask(state([]), state([]), 'zz', newId)).toBeNull())
})

describe('전체 되돌리기', () => {
  it('백업 그대로 · 지금만 있는 pane 은 끝낸다 · 둘 다 있는 pane 은 남긴다', () => {
    const cur = state([task('a', ['p1', 'p2']), task('c', ['p5'])])
    const snap = state([task('a', ['p1'])])
    const r = restoreAll(cur, snap)
    expect(r.state).toBe(snap)
    expect(r.kill.sort()).toEqual(['p2', 'p5'])
  })
})

describe('가져오기 합치기', () => {
  it('없는 일감 · 템플릿만 더하고 겹치는 id 는 새로', () => {
    const cur = state([task('a', ['p1'])])
    const inc = state([task('a', ['p1']), task('b', ['p1'])])
    inc.settings = { ...inc.settings, templates: [...inc.settings.templates, { id: 'tpl-x', name: 'X', tabs: [] }] }
    const r = mergeState(cur, inc, () => 'fresh')
    expect(r.added).toBe(1)
    expect(r.state.tasks.map((t) => t.id)).toEqual(['a', 'b'])
    expect(Object.keys(r.state.tasks[1]!.panes)).toEqual(['fresh'])
    expect(r.state.settings.templates.map((t) => t.id)).toContain('tpl-x')
    expect(r.state.activeTaskId).toBe(cur.activeTaskId)
  })
})

describe('내보내기', () => {
  it('명령 속 키를 가린다', () => {
    const s = state([task('a', ['p1'])])
    s.tasks[0]!.panes['p1']!.command = 'export ANTHROPIC_API_KEY=sk-ant-api03-' + 'x'.repeat(40)
    const text = exportText(s)
    expect(text).not.toContain('sk-ant-api03')
    expect(text).toContain('‹가림:Anthropic 키›')
    expect(JSON.parse(text).tasks[0].id).toBe('a')
  })
  it('따옴표 속 값도 가리고 JSON 이 깨지지 않는다', () => {
    const s = state([task('a', ['p1'])])
    s.tasks[0]!.panes['p1']!.command = 'curl -d "api_key=abcd1234" && PASSWORD="hunter22" x'
    const text = exportText(s)
    const back = JSON.parse(text) as { tasks: Array<{ panes: Record<string, { command: string }> }> }
    expect(back.tasks[0]!.panes['p1']!.command).toBe('curl -d "api_key=‹가림:비밀번호›" && PASSWORD="‹가림:비밀번호›" x')
  })
  it('내 종류도 가린다', () => {
    const s = state([task('a', ['p1'])])
    s.tasks[0]!.panes['p1']!.command = 'echo acme_' + 'Z'.repeat(32)
    const text = exportText(s, { custom: [{ name: 'ACME', pattern: 'acme_[A-Za-z0-9]{32}' }] })
    expect(text).not.toContain('Z'.repeat(32))
    expect(text).toContain('‹가림:ACME›')
  })
})
