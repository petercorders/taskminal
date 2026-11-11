import { describe, expect, it } from 'vitest'
import { handleCliUi, type CliCtx } from '../../src/renderer/cli-bridge'
import { reducer } from '../../src/renderer/store'
import { createTask, emptyState } from '../../src/shared/model'
import type { UiRequest } from '../../src/shared/cli'
import type { AppState } from '../../src/shared/types'

let n = 0
const newId = () => `id${++n}`

function base(): AppState {
  const s = emptyState()
  s.settings.groups = [{ id: 'g1', name: '찍계부' }]
  s.tasks = [
    createTask({ name: '배포', cwd: '/srv', templateId: null, statusId: 'doing', groupId: null, color: null }, s.settings, newId, 0),
    createTask({ name: 'UX', cwd: '/ux', templateId: null, statusId: 'doing', groupId: null, color: null }, s.settings, newId, 0),
  ]
  s.activeTaskId = s.tasks[1]!.id
  return s
}
const ctx = (state: AppState, over: Partial<CliCtx> = {}): CliCtx => ({ state, activity: {}, now: 1000, newId, mask: (x) => x, ...over })
const apply = (state: AppState, req: UiRequest, over: Partial<CliCtx> = {}) => {
  const e = handleCliUi(req, ctx(state, over))
  return { e, next: e.actions.reduce(reducer, state) }
}
const firstPane = (s: AppState, i: number) => Object.keys(s.tasks[i]!.panes)[0]!

describe('handleCliUi', () => {
  it('task move: 이름으로 상태 · 묶음, 답은 전 → 후', () => {
    const s = base()
    const { e, next } = apply(s, { op: 'task.move', task: '배포', status: '대기', group: '찍계부' })
    expect(e.reply).toEqual({ ok: true, text: '배포: 진행 중 → 대기 · 묶음 찍계부' })
    expect(next.tasks[0]).toMatchObject({ statusId: 'wait', groupId: 'g1' })
    expect(apply(s, { op: 'task.move', task: '배포', status: '없는상태' }).e.reply).toMatchObject({ ok: false, candidates: ['진행 중', '대기', '완료'] })
  })

  it('생략한 일감은 부른 터미널의 일감', () => {
    const s = base()
    const { next } = apply(s, { op: 'task.move', status: '완료', self: firstPane(s, 0) })
    expect(next.tasks[0]!.statusId).toBe('done')
    expect(next.tasks[1]!.statusId).toBe('doing')
  })

  it('task new: 보던 일감은 그대로, 첫 탭은 띄운다, 폴더는 부른 터미널의 폴더', () => {
    const s = base()
    const { e, next } = apply(s, { op: 'task.new', name: '새 일', self: firstPane(s, 0) })
    const made = next.tasks[2]!
    expect(made).toMatchObject({ name: '새 일', cwd: '/srv' })
    expect(next.activeTaskId).toBe(s.activeTaskId)
    expect(e.seeTabs).toEqual([made.activeTabId])
  })

  it('task note: 에이전트가 남김 · 시각', () => {
    const s = base()
    const { next } = apply(s, { op: 'task.note', task: 'UX', text: '  다음: 시험 고치기 ' })
    expect(next.tasks[1]!.notes).toEqual([{ id: expect.any(String), text: '다음: 시험 고치기', by: 'agent', at: 1000 }])
  })

  it('task remove: 실행 중이면 --force 가 있어야', () => {
    const s = base()
    const busy = { [firstPane(s, 0)]: { state: 'running' as const, busy: true, attention: false } }
    expect(handleCliUi({ op: 'task.remove', task: '배포', force: false }, ctx(s, { activity: busy })).reply).toMatchObject({ ok: false, error: expect.stringContaining('--force') })
    expect(handleCliUi({ op: 'task.remove', task: '배포', force: true }, ctx(s, { activity: busy })).remove).toBe(s.tasks[0]!.id)
  })

  it('pane split --cmd: 그 pane 옆에 시작 명령을 가진 pane · 그 탭을 띄운다', () => {
    const s = base()
    const p = firstPane(s, 0)
    const { e, next } = apply(s, { op: 'pane.split', pane: p, dir: 'down', cmd: 'npm test' })
    const id = (e.reply as { data: { pane: string } }).data.pane
    expect(next.tasks[0]!.panes[id]).toEqual({ id, cwd: '/srv', pendingCommand: 'npm test' })
    expect(e.seeTabs).toEqual([s.tasks[0]!.activeTabId])
  })

  it('명령이 만든 탭 · pane · 대화는 사용자가 보던 탭 · pane 을 바꾸지 않는다 (24 리뷰)', () => {
    let s = base()
    const was = (st: typeof s) => ({ tab: st.tasks[0]!.activeTabId, pane: st.tasks[0]!.tabs.find((t) => t.id === st.tasks[0]!.activeTabId)!.activePaneId })
    const before = was(s)
    for (const req of [
      { op: 'pane.split', pane: before.pane, dir: 'right' },
      { op: 'tab.new', task: '배포' },
      { op: 'chat.new', agent: 'claude', where: 'down', text: 'x', task: '배포' },
      { op: 'chat.new', agent: 'claude', where: 'tab', text: 'x', task: '배포' },
    ] as const) {
      const r = apply(s, req)
      expect(r.e.reply.ok, req.op).toBe(true)
      s = r.next
      expect(was(s), `${req.op} ${'where' in req ? req.where : ''}`).toEqual(before)
    }
  })

  it('tab new --title --cmd', () => {
    const s = base()
    const { e, next } = apply(s, { op: 'tab.new', task: 'UX', cmd: 'ls', title: '서버' })
    const tab = next.tasks[1]!.tabs[1]!
    expect(tab.title).toBe('서버')
    expect(next.tasks[1]!.panes[tab.activePaneId]).toMatchObject({ pendingCommand: 'ls', cwd: '/ux' })
    expect(e.reply).toMatchObject({ ok: true, text: expect.stringContaining("'서버'") })
    expect(e.seeTabs).toEqual([tab.id])
  })

  it('pane resolve: 대상 · 그 탭을 띄운다 · 시작 명령이 남았는지', () => {
    const s = base()
    const p = firstPane(s, 1)
    s.tasks[1]!.panes[p]!.pendingCommand = 'claude'
    const e = handleCliUi({ op: 'pane.resolve', pane: 'UX' }, ctx(s))
    expect(e.reply).toEqual({ ok: true, target: { paneId: p, label: 'UX › ux', kind: 'terminal', cwd: '/ux', pending: true } })
    expect(e.seeTabs).toEqual([s.tasks[1]!.activeTabId])
  })

  it('chat new 두 번 → chat panes --all 은 둘 (부른 pane 은 빼고)', () => {
    let s = base()
    const self = firstPane(s, 0)
    const ids: string[] = []
    for (const where of ['right', 'tab'] as const) {
      const r = apply(s, { op: 'chat.new', agent: 'claude', where, text: 'x', self })
      if (!r.e.reply.ok) throw new Error('fail')
      ids.push(r.e.reply.target!.paneId)
      expect(r.e.reply.target).toMatchObject({ kind: 'chat', chat: { agent: 'claude' } })
      s = r.next
    }
    const e = handleCliUi({ op: 'chat.panes', panes: [], all: true, self }, ctx(s))
    expect(e.reply.ok && e.reply.targets!.map((t) => t.paneId).sort()).toEqual([...ids].sort())
    const one = handleCliUi({ op: 'chat.panes', panes: [ids[0]!], all: false }, ctx(s))
    expect(one.reply.ok && one.reply.targets!.length).toBe(1)
    expect(handleCliUi({ op: 'chat.panes', panes: [self], all: false }, ctx(s)).reply).toMatchObject({ ok: false, error: expect.stringContaining('대화 pane 이 아니') })
  })

  it('notify: 부른 터미널이 그 일감이면 그 pane, 아니면 일감의 활성 pane', () => {
    const s = base()
    const self = firstPane(s, 0)
    expect(handleCliUi({ op: 'notify', text: 'x', self }, ctx(s)).notify).toEqual({ paneId: self, text: 'x' })
    expect(handleCliUi({ op: 'notify', task: 'UX', text: 'y', self }, ctx(s)).notify).toEqual({ paneId: firstPane(s, 1), text: 'y' })
  })

  it('list: 가린 명령 · ← 여기', () => {
    const s = base()
    const self = firstPane(s, 0)
    const e = handleCliUi({ op: 'list', self }, ctx(s, { activity: { [self]: { state: 'running', busy: true, attention: false, command: 'echo SECRET', startedAt: 0 } }, mask: (x) => x.replace('SECRET', '‹가림›') }))
    expect(e.reply.ok && e.reply.text).toContain('echo ‹가림›')
    expect(e.reply.ok && e.reply.text).toContain('← 여기')
  })
})
