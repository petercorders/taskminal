import { describe, expect, it } from 'vitest'
import { addNote, addTab, createTask, emptyState, normalizeState, removeNote, setViewed, toggleNote } from '../../src/shared/model'
import { resumeCard, shouldShowResume, RESUME_LINES } from '../../src/shared/resume'
import type { HistoryEntry } from '../../src/shared/history'
import type { Task } from '../../src/shared/types'

let n = 0
const newId = () => `id${++n}`
const MIN = 60_000

function task(): Task {
  let t = createTask({ name: '배포', cwd: '/srv', templateId: null, statusId: 'doing', groupId: null, color: null }, emptyState().settings, newId, 0)
  t = addTab(t, newId)
  return t
}
const panes = (t: Task) => Object.keys(t.panes)
const entry = (t: Task, paneId: string, cmd: string, code: number, endedAt: number): HistoryEntry => ({ id: `h${++n}`, taskId: t.id, paneId, cmd, cwd: '/srv', startedAt: endedAt - 1000, endedAt, code, tail: [] })

describe('resumeCard', () => {
  const since = 100 * MIN
  const now = 140 * MIN

  it('맨 위 = 확인 필요, 올린 줄은 아래에서 빠진다 · 순서 실패 → 실행 중 → 에이전트 → 바뀐 파일 → 끝난 명령', () => {
    const t = task()
    const [p1, p2] = panes(t) as [string, string]
    const card = resumeCard({
      task: t,
      now,
      since,
      activity: { [p1]: { state: 'waiting', busy: false, attention: true, message: '계속할까요?' }, [p2]: { state: 'running', busy: true, attention: false, command: 'npm run dev', startedAt: now - 3 * MIN } },
      history: [entry(t, p2, 'make build', 2, since + MIN), entry(t, p2, 'ls', 0, since + 2 * MIN), entry(t, p2, 'old', 1, since - MIN)],
      chats: [{ paneId: p1, text: '시험 3개를 고쳤어요\n다음은 배포예요' }],
      changed: 4,
    })
    expect(card.top).toMatchObject({ kind: 'attention', text: expect.stringContaining('확인 필요'), sub: '계속할까요?', go: { to: 'pane', paneId: p1 }, button: '터미널 보기' })
    expect(card.facts.map((f) => f.kind)).toEqual(['failed', 'running', 'agent', 'changed', 'done'])
    expect(card.facts[0]).toMatchObject({ text: '실패 · make build', sub: expect.stringContaining('exit 2') })
    expect(card.facts[1]!.sub).toContain('3분 0초째')
    expect(card.facts[2]!.text).toBe('에이전트 · 다음은 배포예요')
    expect(card.facts[4]).toMatchObject({ text: '끝난 명령 1개', sub: '마지막 · ls' })
    expect(card.fresh).toBe(true)
    expect(card.awayMs).toBe(40 * MIN)
  })

  it('확인 필요가 없으면 맨 위 = 에이전트 인계 메모, 그다음 내 첫 할 일', () => {
    let t = task()
    t = addNote(t, { id: 'a', text: '사람 할 일', at: 1 })
    t = addNote(t, { id: 'b', text: '다음: 배포 확인', by: 'agent', at: since + MIN })
    const card = resumeCard({ task: t, now, since, activity: {}, history: [], chats: [] })
    expect(card.top).toMatchObject({ kind: 'note', text: '에이전트가 남김 · 다음: 배포 확인', button: '메모 열기' })
    expect(card.facts.map((f) => f.kind)).toEqual(['todo'])
    const quiet = resumeCard({ task: addNote(task(), { id: 'c', text: '내 일', at: 1 }), now, since, activity: {}, history: [], chats: [] })
    expect(quiet.top).toMatchObject({ kind: 'todo', text: '할 일 · 내 일' })
    expect(quiet.fresh).toBe(false) // 내 할 일만 있으면 새 사실이 아니다
  })

  it('확인 필요와 에이전트 메모가 함께면 맨 위는 확인 필요 · 메모는 아래', () => {
    let t = task()
    const p = panes(t)[0]!
    t = addNote(t, { id: 'n', text: '다음: 배포', by: 'agent', at: since + MIN })
    const card = resumeCard({ task: t, now, since, activity: { [p]: { state: 'waiting', busy: false, attention: true } }, history: [], chats: [] })
    expect(card.top!.kind).toBe('attention')
    expect(card.facts.map((f) => f.kind)).toEqual(['note'])
  })

  it('5줄 넘으면 외 n개', () => {
    const t = task()
    const p = panes(t)[0]!
    const hist = Array.from({ length: 8 }, (_, i) => entry(t, p, `fail${i}`, 1, since + i + 1))
    const card = resumeCard({ task: t, now, since, activity: {}, history: hist, chats: [] })
    expect(card.facts).toHaveLength(RESUME_LINES)
    expect(card.facts[0]!.text).toBe('실패 · fail7') // 최근 것부터
    expect(card.more).toBe(3) // 실패 8줄 중 5줄만 보이고 3줄은 '외 3개'
  })

  it('본 뒤 새 사실이 없으면 fresh 가 아니다 · 실행 중만으로도 아니다', () => {
    const t = task()
    const p = panes(t)[0]!
    const card = resumeCard({ task: t, now, since, activity: { [p]: { state: 'running', busy: true, attention: false } }, history: [entry(t, p, 'x', 0, since - 1)], chats: [{ paneId: p, text: '  ' }] })
    expect(card.fresh).toBe(false)
  })

  it('명령 · 알림 글은 가린다', () => {
    const t = task()
    const p = panes(t)[0]!
    const card = resumeCard({ task: t, now, since, activity: { [p]: { state: 'waiting', busy: false, attention: true, message: 'key sk-1' } }, history: [], chats: [], mask: (s) => s.replace('sk-1', '‹가림›') })
    expect(card.top!.sub).toBe('key ‹가림›')
  })
})

describe('shouldShowResume', () => {
  it('켜져 있고 · 본 적이 있고 · 기준 넘게', () => {
    const t = task()
    expect(shouldShowResume(t, 100 * MIN, 30 * MIN, true)).toBe(false) // 본 적 없음
    const seen = setViewed(t, 69 * MIN)
    expect(shouldShowResume(seen, 100 * MIN, 30 * MIN, true)).toBe(true)
    expect(shouldShowResume(seen, 98 * MIN, 30 * MIN, true)).toBe(false)
    expect(shouldShowResume(seen, 100 * MIN, 30 * MIN, false)).toBe(false)
  })
})

describe('일감 메모 모델', () => {
  it('덧붙이기 · 체크 · 지우기 · 저장 파일 검증', () => {
    let t = task()
    t = addNote(t, { id: 'a', text: '  하나  ', at: 1 })
    t = addNote(t, { id: 'b', text: '에이전트', by: 'agent', at: 2 })
    expect(addNote(t, { id: 'c', text: '   ', at: 3 })).toBe(t)
    t = toggleNote(t, 'a')
    expect(t.notes).toEqual([{ id: 'a', text: '하나', at: 1, done: true }, { id: 'b', text: '에이전트', by: 'agent', at: 2 }])
    expect(toggleNote(t, 'a').notes![0]).toEqual({ id: 'a', text: '하나', at: 1 })
    t = setViewed(t, 77)
    const s = emptyState()
    s.tasks = [t]
    const back = normalizeState(JSON.parse(JSON.stringify(s)), newId)
    expect(back.tasks[0]!.notes).toEqual(t.notes)
    expect(back.tasks[0]!.lastViewedAt).toBe(77)
    const bad = normalizeState({ ...JSON.parse(JSON.stringify(s)), tasks: [{ ...JSON.parse(JSON.stringify(t)), notes: [{ id: 'x' }, 'y', { id: 'z', text: 'ok', by: 'hacker', done: 'yes' }], lastViewedAt: 'soon' }] }, newId)
    expect(bad.tasks[0]!.notes).toEqual([{ id: 'z', text: 'ok', at: 0 }])
    expect(bad.tasks[0]!.lastViewedAt).toBeUndefined()
    expect(removeNote(removeNote(t, 'a'), 'b').notes).toBeUndefined()
  })
})
