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

describe('issue.prepare 내부 생성 계약', () => {
  it('지정 ID의 빈 대화 일감을 만들고 포커스·기본 템플릿 명령을 실행하지 않는다', () => {
    const state = base()
    state.settings.defaultTemplateId = 'dangerous'
    state.settings.templates.push({ id: 'dangerous', name: '시작 명령', tabs: [{ layout: { pane: { command: 'do-not-run' } } }] })
    const req: UiRequest = { op: 'issue.prepare', taskId: 'issue-task', root: '/repo/issue', issue: { provider: 'github', id: '7', key: '#7', title: '요구사항', body: '외부 지시', url: 'https://github.com/demo/project/issues/7', state: 'open' } }
    const { e, next } = apply(state, req)
    expect(e.reply.ok).toBe(true)
    expect(e.seeTabs).toEqual([])
    expect(next.activeTaskId).toBe(state.activeTaskId)
    const created = next.tasks.find(task => task.id === 'issue-task')!
    expect(created.cwd).toBe('/repo/issue')
    expect(Object.values(created.panes)).toEqual([expect.objectContaining({ kind: 'chat', chat: { agent: 'claude' } })])
    expect(Object.values(created.panes).some(pane => pane.pendingCommand)).toBe(false)
    expect(created.notes?.[0]?.text).toContain('비신뢰 참고 자료')
    expect(apply(next, req).e.actions).toEqual([])
    expect(apply(next, { ...req, root: '/other' }).e.reply.ok).toBe(false)
  })
})

describe('위임 · 보낸 이 (69)', () => {
  it('delegate.source: 부른 pane 의 일감 · pane 폴더, 일감 밖이면 종료 2, 원격 · 없는 템플릿 이름은 쓰기 전에 거절', () => {
    const s = base()
    const self = firstPane(s, 0)
    expect(apply(s, { op: 'delegate.source', self }).e.reply).toEqual({ ok: true, data: { taskId: s.tasks[0]!.id, paneId: self, cwd: '/srv' } })
    expect(apply(s, { op: 'delegate.source' }).e.reply).toMatchObject({ ok: false, exit: 2 })
    expect(apply(s, { op: 'delegate.source', self: 'nowhere' }).e.reply).toMatchObject({ ok: false, exit: 2 })
    expect(apply(s, { op: 'delegate.source', self, template: '없는 템플릿' }).e.reply).toMatchObject({ ok: false, exit: 2 })
    const remote = { ...s, tasks: [{ ...s.tasks[0]!, host: 'dev' }, s.tasks[1]!] }
    expect(apply(remote, { op: 'delegate.source', self }).e.reply).toMatchObject({ ok: false, exit: 2, error: expect.stringContaining('원격') })
  })

  it('delegate.prepare: 정한 id 로 부모를 기록한 일감 · 보던 일감 그대로 · 첫 탭은 띄움, 같은 요청이면 그대로(existing), 다른 것과 겹치면 거절', () => {
    const s = base()
    const parent = { taskId: s.tasks[0]!.id, paneId: firstPane(s, 0) }
    const req: UiRequest = { op: 'delegate.prepare', taskId: 'delegated-1', name: ' 로그인 고침 ', cwd: '/srv-worktrees/feat-login', parent, status: '대기', self: parent.paneId }
    const { e, next } = apply(s, req)
    expect(e.reply).toEqual({ ok: true, data: { task: 'delegated-1', existing: false } })
    const made = next.tasks.find((t) => t.id === 'delegated-1')!
    expect(made).toMatchObject({ name: '로그인 고침', cwd: '/srv-worktrees/feat-login', parent, statusId: 'wait' })
    expect(next.activeTaskId).toBe(s.activeTaskId)
    expect(e.seeTabs).toEqual([made.activeTabId])
    const again = apply(next, req)
    expect(again.e.reply).toEqual({ ok: true, data: { task: 'delegated-1', existing: true } })
    expect(again.e.actions).toEqual([])
    expect(apply(next, { ...req, cwd: '/elsewhere' }).e.reply).toMatchObject({ ok: false })
    expect(apply(next, { ...req, parent: { taskId: s.tasks[1]!.id, paneId: firstPane(s, 1) } }).e.reply).toMatchObject({ ok: false })
    expect(apply(s, { ...req, taskId: firstPane(s, 1) }).e.reply).toMatchObject({ ok: false })
    expect(apply(s, { ...req, group: '없는 묶음' }).e.reply).toMatchObject({ ok: false })
  })

  it('pane resolve · chat new: 다른 pane 이 부르면 보낸 이 머리, 같은 pane · 앱 밖이면 없음. 터미널에서 도는 에이전트(runs)', () => {
    const s = base()
    const from = firstPane(s, 0)
    const to = firstPane(s, 1)
    const r = apply(s, { op: 'pane.resolve', pane: to, self: from }, { activity: { [to]: { state: 'running', busy: true, attention: false, command: 'claude' } } }).e.reply
    expect(r).toMatchObject({ ok: true, sender: expect.stringMatching(/^\[taskminal: 배포 › .+ \(id\d+\) 에서 보냄\]$/), target: { paneId: to, runs: 'claude' } })
    const plain = apply(s, { op: 'pane.resolve', pane: to, self: to }).e.reply
    expect(plain).not.toHaveProperty('sender')
    expect(plain).toMatchObject({ ok: true, target: { paneId: to } })
    expect((plain as { target: object }).target).not.toHaveProperty('runs')
    expect(apply(s, { op: 'pane.resolve', pane: to }).e.reply).not.toHaveProperty('sender')
    expect(apply(s, { op: 'chat.new', task: 'UX', agent: 'claude', where: 'tab', text: '일', self: from }).e.reply).toMatchObject({ ok: true, sender: expect.stringContaining('배포 ›') })
    expect(apply(s, { op: 'chat.new', task: 'UX', agent: 'claude', where: 'tab', text: '일' }).e.reply).not.toHaveProperty('sender')
  })
})
