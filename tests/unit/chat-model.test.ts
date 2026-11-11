import { describe, expect, it } from 'vitest'
import { addChatTab, branchChat, chatRewound, chatToTerminal, createTask, defaultSettings, normalizeState, setChatSession, splitActivePaneChat, tabLabel } from '../../src/shared/model'
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

  // ─── 22단계: 에이전트 · 되감기 · 나누기 ───
  const chatOf = (t: ReturnType<typeof task>, id: string) => t.panes[id]!.chat
  const save = (t: ReturnType<typeof task>) => {
    const st: AppState = { version: 1, tasks: [t], activeTaskId: t.id, settings: defaultSettings() }
    return normalizeState(JSON.parse(JSON.stringify(st)), ids()).tasks[0]!
  }
  it('Codex 대화 pane: 탭 이름 · 저장 · 되읽기에서 에이전트를 지킨다 · 모르는 에이전트는 claude', () => {
    const t = addChatTab(task(), ids(), 'codex')
    const pid = t.tabs.at(-1)!.activePaneId
    expect(tabLabel(t, t.tabs.at(-1)!)).toBe('Codex 대화')
    const s1 = setChatSession(t, pid, 'th-1')
    expect(chatOf(s1, pid)).toEqual({ agent: 'codex', sessionId: 'th-1' })
    expect(Object.values(save(s1).panes).find((p) => p.kind === 'chat')!.chat).toEqual({ agent: 'codex', sessionId: 'th-1' })
    const raw = JSON.parse(JSON.stringify({ version: 1, tasks: [s1], activeTaskId: s1.id, settings: defaultSettings() }))
    for (const p of Object.values(raw.tasks[0].panes) as { kind?: string; chat?: { agent: string } }[]) if (p.kind === 'chat') p.chat!.agent = 'gpt'
    expect(Object.values(normalizeState(raw, ids()).tasks[0]!.panes).find((p) => p.kind === 'chat')!.chat).toEqual({ agent: 'claude', sessionId: 'th-1' })
  })
  it('chatRewound: forkAt 을 남기고 재시작 뒤에도 남는다 · null 이면 세션을 지운다 · 새 세션이 뜨면 forkAt 이 지워진다', () => {
    const c = addChatTab(task(), ids(), 'codex')
    const pid = c.tabs.at(-1)!.activePaneId
    const t = setChatSession(c, pid, 'th-1')
    const r = chatRewound(t, pid, 'turn-1')
    expect(chatOf(r, pid)).toEqual({ agent: 'codex', sessionId: 'th-1', forkAt: 'turn-1' })
    expect(Object.values(save(r).panes).find((p) => p.kind === 'chat')!.chat).toEqual({ agent: 'codex', sessionId: 'th-1', forkAt: 'turn-1' })
    expect(chatOf(chatRewound(t, pid, null), pid)).toEqual({ agent: 'codex' })
    expect(chatOf(setChatSession(r, pid, 'th-1'), pid)).toEqual({ agent: 'codex', sessionId: 'th-1' }) // 같은 id 여도 forkAt 은 지운다
    expect(chatRewound(t, t.tabs[0]!.activePaneId, 'x')).toBe(t) // 터미널 pane 은 그대로
    expect(chatOf(chatRewound(t, pid, 'turn-0', 'th-0'), pid)).toEqual({ agent: 'codex', sessionId: 'th-0', forkAt: 'turn-0' }) // 리뷰: anchor 가 난 옛 세션
  })
  it('branchChat: 오른쪽에 같은 에이전트 · 같은 세션 + forkAt, 세션이 없으면 그대로', () => {
    const c = addChatTab(task(), ids(), 'codex')
    const pid = c.tabs.at(-1)!.activePaneId
    expect(branchChat(c, pid, 'np', 'turn-1')).toBe(c) // 세션 없음
    const t = setChatSession(c, pid, 'th-1')
    const b = branchChat(t, pid, 'np', 'turn-1')
    expect(b.panes['np']).toMatchObject({ kind: 'chat', chat: { agent: 'codex', sessionId: 'th-1', forkAt: 'turn-1' } })
    expect(chatOf(b, pid)).toEqual({ agent: 'codex', sessionId: 'th-1' })
    const tab = b.tabs.at(-1)!
    expect(tab.layout).toMatchObject({ type: 'split', dir: 'right', a: { paneId: pid }, b: { paneId: 'np' } })
    expect(tab.activePaneId).toBe('np')
    expect(branchChat(t, pid, 'np2', 'turn-0', 'th-0').panes['np2']).toMatchObject({ chat: { sessionId: 'th-0', forkAt: 'turn-0' } })
  })
  it('chatToTerminal: codex 는 `codex resume <id>` · 아직 안 보낸 되감기면 옛 세션 대신 새로', () => {
    const c = addChatTab(task(), ids(), 'codex')
    const pid = c.tabs.at(-1)!.activePaneId
    const t = setChatSession(c, pid, 'th-1')
    let n = 0
    const nid = () => `t${++n}`
    const a = chatToTerminal(t, pid, nid, '/bin/codex')!
    expect(a.task.panes[a.paneId]!.pendingCommand).toBe('/bin/codex resume th-1')
    const r = chatToTerminal(chatRewound(t, pid, 'turn-1'), pid, nid, '/bin/codex')!
    expect(r.task.panes[r.paneId]!.pendingCommand).toBe('/bin/codex')
  })
})
