import { describe, expect, it } from 'vitest'
import { createTask, emptyState, splitActivePaneChat } from '../../src/shared/model'
import type { AppState } from '../../src/shared/types'
import { overviewSections, overviewTarget } from '../../src/renderer/overview-model'

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
})
