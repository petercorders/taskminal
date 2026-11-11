import { describe, expect, it } from 'vitest'
import { addChatTab, chatToTerminal, createTask, defaultSettings, normalizeState, setChatSession, splitActivePaneChat, tabLabel } from '../../src/shared/model'
import type { AppState } from '../../src/shared/types'

function ids() {
  let n = 0
  return () => `id${++n}`
}
function task() {
  return createTask({ name: 'A', cwd: '/tmp/a', statusId: 'doing', groupId: null, color: null, templateId: null }, defaultSettings(), ids(), 1)
}

describe('대화 pane 모델', () => {
  it('새 탭 · 오른쪽 나누기로 대화 pane', () => {
    const newId = (() => {
      let n = 100
      return () => `n${++n}`
    })()
    const t = addChatTab(task(), newId)
    const p = t.panes[t.tabs.at(-1)!.activePaneId]!
    expect(p).toMatchObject({ kind: 'chat', chat: { agent: 'claude' }, cwd: '/tmp/a' })
    expect(p.pendingCommand).toBeUndefined()
    expect(tabLabel(t, t.tabs.at(-1)!)).toBe('Claude 대화')
    const s = splitActivePaneChat(t, 'right', newId)
    const sp = s.panes[s.tabs.at(-1)!.activePaneId]!
    expect(sp.kind).toBe('chat')
    expect(Object.keys(s.panes)).toHaveLength(3)
  })
  it('세션 id 저장 — 같으면 같은 객체(저장 안 함), 터미널 pane 은 그대로', () => {
    const t = addChatTab(task(), ids())
    const pid = t.tabs.at(-1)!.activePaneId
    const a = setChatSession(t, pid, 's-1')
    expect(a.panes[pid]!.chat).toEqual({ agent: 'claude', sessionId: 's-1' })
    expect(setChatSession(a, pid, 's-1')).toBe(a)
    const term = t.tabs[0]!.activePaneId
    expect(setChatSession(t, term, 's-1')).toBe(t)
  })
  it('터미널로 전환: 같은 자리 새 pane id · 시작 명령 claude --resume', () => {
    const newId = (() => {
      let n = 200
      return () => `m${++n}`
    })()
    let t = addChatTab(task(), newId)
    const pid = t.tabs.at(-1)!.activePaneId
    t = setChatSession(t, pid, 'abc-1')
    const { task: next, paneId } = chatToTerminal(t, pid, newId)!
    expect(next.panes[pid]).toBeUndefined()
    expect(next.panes[paneId]).toEqual({ id: paneId, cwd: '/tmp/a', pendingCommand: 'claude --resume abc-1' })
    expect(next.tabs.at(-1)!.activePaneId).toBe(paneId)
    const fresh = addChatTab(task(), newId)
    const fp = fresh.tabs.at(-1)!.activePaneId
    const conv = chatToTerminal(fresh, fp, newId)!
    expect(conv.task.panes[conv.paneId]!.pendingCommand).toBe('claude')
    expect(chatToTerminal(fresh, fresh.tabs[0]!.activePaneId, newId)).toBeNull() // 터미널은 아님
  })
  it('저장 파일 검증: 대화 pane · 세션 id 를 지키고, 이상한 id 는 버린다', () => {
    const c = addChatTab(task(), ids())
    const t = setChatSession(c, c.tabs.at(-1)!.activePaneId, 'ok-1')
    const st: AppState = { version: 1, tasks: [t], activeTaskId: t.id, settings: defaultSettings() }
    const back = normalizeState(JSON.parse(JSON.stringify(st)), ids())
    const pane = Object.values(back.tasks[0]!.panes).find((p) => p.kind === 'chat')!
    expect(pane.chat).toEqual({ agent: 'claude', sessionId: 'ok-1' })
    const raw = JSON.parse(JSON.stringify(st))
    for (const p of Object.values(raw.tasks[0].panes) as { kind?: string; chat?: { sessionId: string } }[]) if (p.kind === 'chat') p.chat!.sessionId = '../../etc; rm'
    const bad = normalizeState(raw, ids())
    expect(Object.values(bad.tasks[0]!.panes).find((p) => p.kind === 'chat')!.chat).toEqual({ agent: 'claude' })
  })
})
