import { describe, expect, it } from 'vitest'
import { createTask, emptyState, splitActivePaneChat } from '../../src/shared/model'
import type { AppState } from '../../src/shared/types'
import { activeInboxRows, chatInboxSignal, inboxRows, overviewSections, overviewTarget } from '../../src/renderer/overview-model'

function fixture(): AppState {
  const s = emptyState()
  let n = 0
  s.tasks = ['서버', '화면'].map((name) => createTask({ name, cwd: `/tmp/${name}`, templateId: null, statusId: s.settings.statuses[0]!.id, groupId: null, color: null }, s.settings, () => `id${++n}`, 0))
  return s
}

describe('전체 보기', () => {
  it('보관한 일감은 제외하고 사이드바 흐름과 같은 상태를 쓴다', () => {
    const s = fixture()
    s.tasks[1]!.archivedAt = 1
    const p = s.tasks[0]!.tabs[0]!.activePaneId
    const sections = overviewSections(s, { [p]: { state: 'waiting', busy: true, attention: true } }, {}, new Set(), '')
    expect(sections.find((x) => x.key === 'need')!.cards.map((c) => c.task.name)).toEqual(['서버'])
    expect(sections.flatMap((x) => x.cards)).toHaveLength(1)
  })
  it('브랜치·묶음·에이전트 이름을 대소문자 무시하고 찾는다', () => {
    const s = fixture()
    s.settings.groups = [{ id: 'g', name: 'Backend' }]
    s.tasks[0]!.groupId = 'g'
    s.tasks[0] = splitActivePaneChat(s.tasks[0]!, 'right', () => 'chat', 'codex')
    for (const q of ['BACKEND', 'feature/test', 'CODEX']) {
      expect(overviewSections(s, {}, { '/tmp/서버': 'feature/test' }, new Set(), q).flatMap((x) => x.cards).map((c) => c.task.name)).toEqual(['서버'])
    }
  })
  it('확인 필요 pane을 카드 기본 대상으로 골라 정확한 탭·pane을 돌려준다', () => {
    const s = fixture()
    s.tasks[0] = splitActivePaneChat(s.tasks[0]!, 'right', () => 'chat', 'claude')
    const task = s.tasks[0]!
    const shell = Object.keys(task.panes).find((p) => p !== 'chat')!
    const sections = overviewSections(s, { [shell]: { state: 'waiting', busy: true, attention: true } }, {}, new Set(), '')
    const card = sections.flatMap((x) => x.cards).find((x) => x.task.id === task.id)!
    expect(card.target).toEqual({ taskId: task.id, tabId: task.tabs[0]!.id, paneId: shell })
    expect(card.panes).toHaveLength(2)
    expect(card.panes.find((x) => x.paneId === 'chat')!.label).toContain('Claude')
  })
  it('대화 pane 줄은 어느 에이전트인지도 준다(로고) — 터미널 · 변경 줄에는 없다', () => {
    const s = fixture()
    s.tasks[0] = splitActivePaneChat(s.tasks[0]!, 'right', () => 'chat', 'codex')
    s.tasks[1] = splitActivePaneChat(s.tasks[1]!, 'right', () => 'chat2', 'claude')
    const cards = overviewSections(s, {}, {}, new Set(), '').flatMap((x) => x.cards)
    const panes = cards.flatMap((c) => c.panes)
    expect(panes.find((x) => x.paneId === 'chat')).toMatchObject({ agent: 'codex' })
    expect(panes.find((x) => x.paneId === 'chat')!.label).toContain('Codex')
    expect(panes.find((x) => x.paneId === 'chat2')).toMatchObject({ agent: 'claude' })
    const shells = panes.filter((x) => x.paneId !== 'chat' && x.paneId !== 'chat2')
    expect(shells).toHaveLength(2)
    for (const shell of shells) expect(shell).not.toHaveProperty('agent')
  })
  it('목록에서 고른 뒤 pane·탭·일감이 사라지면 다른 대상에 보내지 않는다', () => {
    const s = fixture()
    const t = s.tasks[0]!
    const target = { taskId: t.id, tabId: t.tabs[0]!.id, paneId: t.tabs[0]!.activePaneId }
    expect(overviewTarget(s, target)).toEqual(target)
    delete t.panes[target.paneId]
    expect(overviewTarget(s, target)).toBeNull()
    expect(overviewTarget(s, { ...target, taskId: 'missing' })).toBeNull()
  })
  it('설정상 완료인 일감은 안 읽음이 있어도 확인 필요로 옮기지 않는다', () => {
    const s = fixture()
    const t = s.tasks[0]!
    t.statusId = s.settings.statuses.at(-1)!.id
    const sections = overviewSections(s, {}, {}, new Set([t.id]), '')
    expect(sections.find((x) => x.key === 'need')!.cards).toHaveLength(0)
    expect(sections.find((x) => x.key === t.statusId)!.cards[0]!.unread).toBe(true)
  })
  it('목록에 없는 고아 pane은 상태 집계·이동 대상에서 제외한다', () => {
    const s = fixture()
    const t = s.tasks[0]!
    t.panes['orphan'] = { id: 'orphan', cwd: '/tmp' }
    const sections = overviewSections(s, { orphan: { state: 'waiting', busy: true, attention: true } }, {}, new Set(), '')
    expect(sections.find((x) => x.key === 'need')!.cards).toHaveLength(0)
    expect(sections.flatMap((x) => x.cards).find((c) => c.task.id === t.id)!.panes.map((p) => p.paneId)).not.toContain('orphan')
  })
  it('지난 알림 줄(66단계) — 지금 열 수 있는 pane 이면 그 탭을 찾고, 지운 일감 · 닫은 pane · 보관한 일감이면 열 대상이 없다', () => {
    const s = fixture()
    const [a, b] = s.tasks as [AppState['tasks'][number], AppState['tasks'][number]]
    const pane = a.tabs[0]!.activePaneId
    const e = (id: string, taskId: string, paneId: string) => ({ id, at: 1, kind: 'wait' as const, taskId, paneId, title: 't', body: 'b', read: false })
    b.archivedAt = 1
    const rows = inboxRows(s, [e('1', a.id, pane), e('2', a.id, 'gone'), e('3', 'deleted', 'x'), e('4', b.id, b.tabs[0]!.activePaneId)])
    expect(rows.map((r) => [r.taskName, r.target])).toEqual([
      ['서버', { taskId: a.id, tabId: a.tabs[0]!.id, paneId: pane }],
      ['서버', null],
      ['지운 일감', null],
      ['화면', null],
    ])
  })
})

describe('현재 행동', () => {
  it('다른 질문에 답해도 아직 열려 있는 질문으로 이동한다', () => {
    const s = fixture()
    const task = s.tasks[0] = splitActivePaneChat(s.tasks[0]!, 'right', () => 'chat', 'claude')
    const first = chatInboxSignal(undefined, { t: 'question', id: 'one', questions: [] })
    const second = chatInboxSignal(first, { t: 'question', id: 'two', questions: [] })
    const pending = chatInboxSignal(second, { t: 'answered', id: 'one', how: 'allow' })
    expect(activeInboxRows(s, {}, { chat: pending }, {})).toMatchObject([
      { kind: 'answer', taskId: task.id, target: { paneId: 'chat', tabId: task.tabs[0]!.id } },
    ])
    const settled = chatInboxSignal(pending, { t: 'answered', id: 'two', how: 'allow' })
    expect(activeInboxRows(s, {}, { chat: settled }, {})).toEqual([])
  })

  it('실패가 지나갔거나 보관한 일감과 닫힌 pane은 제외하고 최신 대상만 보여 준다', () => {
    const s = fixture()
    const [task, archived] = s.tasks as [AppState['tasks'][number], AppState['tasks'][number]]
    archived.archivedAt = 1
    const pane = task.tabs[0]!.activePaneId
    const failure = { state: 'failed', busy: false, attention: true } as const
    const activities = { [pane]: failure, [archived.tabs[0]!.activePaneId]: failure, gone: failure }
    expect(activeInboxRows(s, activities, {}, {})).toMatchObject([{ kind: 'investigate', taskId: task.id, target: { paneId: pane } }])
    expect(activeInboxRows(s, { [pane]: { ...failure, attention: false } }, {}, {})).toEqual([])
    delete task.panes[pane]
    expect(activeInboxRows(s, activities, {}, {})).toEqual([])
  })

  it('현재 완료된 대화와 로컬 Git 작업으로만 결과 검토를 제안하고 새 턴이 시작하면 없앤다', () => {
    const s = fixture()
    const task = s.tasks[0] = splitActivePaneChat(s.tasks[0]!, 'right', () => 'chat', 'codex')
    const completed = chatInboxSignal(undefined, { t: 'turn_end', ok: true, ms: 1, reason: 'done' })
    expect(activeInboxRows(s, {}, { chat: completed }, {})).toEqual([])
    const branches = { [task.cwd]: 'topic' }
    expect(activeInboxRows(s, {}, { chat: completed }, branches)).toMatchObject([{ kind: 'review', taskId: task.id }])
    const running = chatInboxSignal(completed, { t: 'user', text: '다시', at: 2 })
    expect(activeInboxRows(s, {}, { chat: running }, branches)).toEqual([])
  })

  it('리뷰 상태를 떠난 일감은 검토 후보에서 내려간다', () => {
    const s = fixture()
    const task = s.tasks[0]!
    s.settings.statuses.splice(1, 0, { id: 'review', name: '리뷰 예정', color: '#aaaaaa' })
    task.statusId = 'review'
    expect(activeInboxRows(s, {}, {}, { [task.cwd]: 'topic' })).toMatchObject([{ kind: 'review', taskId: task.id }])
    task.statusId = 'done'
    expect(activeInboxRows(s, {}, {}, { [task.cwd]: 'topic' })).toEqual([])
  })
})
