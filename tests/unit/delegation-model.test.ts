import { describe, expect, it } from 'vitest'
import { turnStop, type ChatEvent } from '../../src/shared/chat'
import { delegateSignal, parentNotice, senderHeader, senderOf, terminalAgent, validDelegateBranch, withSender } from '../../src/shared/delegation'
import { createTask, emptyState, normalizeState, tabShownLabel } from '../../src/shared/model'
import type { AppState } from '../../src/shared/types'

let n = 0
const newId = () => `id${++n}`

function world(): AppState {
  const s = emptyState()
  const make = (name: string) => createTask({ name, cwd: `/r/${name}`, templateId: null, statusId: 'doing', groupId: null, color: null }, s.settings, newId, 0)
  const parent = make('부모')
  const child = make('자식')
  const other = make('남')
  child.parent = { taskId: parent.id, paneId: Object.keys(parent.panes)[0]! }
  s.tasks = [parent, child, other]
  s.activeTaskId = parent.id
  return s
}
const paneOf = (s: AppState, i: number) => Object.keys(s.tasks[i]!.panes)[0]!

describe('보낸 이 머리 (69)', () => {
  it('머리 형식 — 일감 › 탭 과 pane id, 줄바꿈 · 제어 글자는 빈칸으로, 이름은 80자', () => {
    expect(senderHeader('부모 › 대화', 'p1')).toBe('[taskminal: 부모 › 대화 (p1) 에서 보냄]')
    expect(senderHeader('가\n나\t\u0007다', 'p1')).toBe('[taskminal: 가 나 다 (p1) 에서 보냄]')
    expect(senderHeader('x'.repeat(200), 'p1')).toBe(`[taskminal: ${'x'.repeat(80)} (p1) 에서 보냄]`)
  })

  it('다른 pane 이 부르면 머리, 같은 pane · self 없음 · 일감 밖 pane 이면 없음', () => {
    const s = world()
    const from = paneOf(s, 0)
    const to = paneOf(s, 1)
    expect(senderOf(s, from, to)).toBe(`[taskminal: 부모 › ${tabShownLabel(s.tasks[0]!, s.tasks[0]!.tabs[0]!)} (${from}) 에서 보냄]`)
    expect(senderOf(s, to, to)).toBeUndefined()
    expect(senderOf(s, undefined, to)).toBeUndefined()
    expect(senderOf(s, 'nowhere', to)).toBeUndefined()
  })

  it('대화는 머리 줄 + 글, 터미널 TUI 는 같은 줄, 머리가 없으면 글 그대로', () => {
    expect(withSender('일해', '[H]', 'block')).toBe('[H]\n일해')
    expect(withSender('일해', '[H]', 'line')).toBe('[H] 일해')
    expect(withSender('일해', undefined, 'block')).toBe('일해')
    expect(withSender('일해', undefined, 'line')).toBe('일해')
  })

  it('터미널에서 도는 에이전트 — 51 훅 상태, 없으면 실행 중 명령의 첫 낱말. 셸 · 다른 명령은 없음', () => {
    expect(terminalAgent(undefined)).toBeUndefined()
    expect(terminalAgent({ state: 'running', busy: true, attention: false, agent: { agent: 'codex', phase: 'working', at: 0, shellBusy: false } })).toBe('codex')
    expect(terminalAgent({ state: 'running', busy: true, attention: false, command: 'claude --resume x' })).toBe('claude')
    expect(terminalAgent({ state: 'running', busy: true, attention: false, command: '/opt/bin/codex' })).toBe('codex')
    expect(terminalAgent({ state: 'running', busy: true, attention: false, command: 'claudette' })).toBeUndefined()
    expect(terminalAgent({ state: 'done', busy: false, attention: false, command: 'claude' })).toBeUndefined()
    expect(terminalAgent({ state: 'idle', busy: false, attention: false })).toBeUndefined()
  })
})

describe('위임 브랜치 이름 (69)', () => {
  it('공백 · NUL · - 머리 · 100자 넘음 · 45 의 worker 브랜치는 거절', () => {
    expect(validDelegateBranch('feat/69-x')).toBeNull()
    for (const bad of ['', 'a b', 'a\0b', '-x', 'x'.repeat(101), 'taskminal/worker-abc', 'a\nb']) expect(validDelegateBranch(bad), JSON.stringify(bad)).not.toBeNull()
  })
})

describe('맡긴 일감의 턴 멈춤 → 부모 알림 (69)', () => {
  const ev = (e: ChatEvent) => e

  it('turnStop — 턴 끝 · 오류 · 허락 · 질문 · 멈춤만, 68 의 하위 에이전트 · 도구 · 글은 멈춤이 아니다', () => {
    expect(turnStop(ev({ t: 'turn_end', ok: true, ms: 1, reason: 'x' }))).toBe('done')
    expect(turnStop(ev({ t: 'turn_end', ok: false, ms: 1, reason: 'x' }))).toBe('fail')
    expect(turnStop(ev({ t: 'error', kind: 'other', message: 'x' }))).toBe('fail')
    expect(turnStop(ev({ t: 'permission', id: 'a', tool: 'Bash', summary: '', why: '', danger: false }))).toBe('wait')
    expect(turnStop(ev({ t: 'question', id: 'a', questions: [] }))).toBe('wait')
    expect(turnStop(ev({ t: 'stopped' }))).toBe('stopped')
    expect(turnStop(ev({ t: 'agent', id: 'a', phase: 'end', status: 'done' }))).toBeNull()
    expect(turnStop(ev({ t: 'agent', id: 'a', phase: 'end', status: 'fail' }))).toBeNull()
    expect(turnStop(ev({ t: 'tool', id: 't', name: 'Bash', summary: '', parent: 'a' }))).toBeNull()
    expect(turnStop(ev({ t: 'text', text: '끝' }))).toBeNull()
  })

  it('한 턴에 한 번 — 오류 뒤 실패 턴 끝은 알리지 않고, 새 턴(user)에서 다시 연다', () => {
    const open = new Map<string, boolean>()
    expect(delegateSignal(open, 'c', ev({ t: 'user', text: '일', at: 0 }))).toBeNull()
    expect(delegateSignal(open, 'c', ev({ t: 'agent', id: 'a', phase: 'end', status: 'done' }))).toBeNull()
    expect(delegateSignal(open, 'c', ev({ t: 'error', kind: 'crash', message: 'x' }))).toBe('fail')
    expect(delegateSignal(open, 'c', ev({ t: 'turn_end', ok: false, ms: 1, reason: 'x' }))).toBeNull()
    expect(delegateSignal(open, 'c', ev({ t: 'user', text: '다시', at: 1 }))).toBeNull()
    expect(delegateSignal(open, 'c', ev({ t: 'turn_end', ok: true, ms: 1, reason: 'x' }))).toBe('done')
  })

  it('허락으로 멈춤 → 답 → 턴 끝은 두 번 알린다. 모르는 pane(창 새로 고침 뒤)은 열림으로 본다', () => {
    const open = new Map<string, boolean>()
    expect(delegateSignal(open, 'c', ev({ t: 'permission', id: 'q', tool: 'Bash', summary: '', why: '', danger: false }))).toBe('wait')
    expect(delegateSignal(open, 'c', ev({ t: 'answered', id: 'q', how: 'allow' }))).toBeNull()
    expect(delegateSignal(open, 'c', ev({ t: 'turn_end', ok: true, ms: 1, reason: 'x' }))).toBe('done')
    expect(delegateSignal(open, 'other', ev({ t: 'stopped' }))).toBe('stopped')
  })

  it('부모의 맡긴 pane 에 알린다 · 그 pane 이 없어졌으면 부모의 활성 pane', () => {
    const s = world()
    const child = paneOf(s, 1)
    expect(parentNotice(s, child, 'done')).toEqual({ paneId: paneOf(s, 0), text: "맡긴 일 '자식': 턴이 끝났어요" })
    expect(parentNotice(s, child, 'wait')?.text).toBe("맡긴 일 '자식': 허락 · 답을 기다려요")
    s.tasks[1]!.parent = { taskId: s.tasks[0]!.id, paneId: 'gone' }
    const active = s.tasks[0]!.tabs.find((t) => t.id === s.tasks[0]!.activeTabId)!.activePaneId
    expect(parentNotice(s, child, 'fail')).toEqual({ paneId: active, text: "맡긴 일 '자식': 실패했어요" })
  })

  it('부모가 지워졌거나 보관됐거나 부모가 없는 일감이면 null — 조용히', () => {
    const s = world()
    const child = paneOf(s, 1)
    expect(parentNotice(s, paneOf(s, 2), 'done')).toBeNull()
    expect(parentNotice(s, paneOf(s, 0), 'done')).toBeNull()
    expect(parentNotice({ ...s, tasks: [s.tasks[1]!, s.tasks[2]!] }, child, 'done')).toBeNull()
    expect(parentNotice({ ...s, tasks: [{ ...s.tasks[0]!, archivedAt: 5 }, s.tasks[1]!] }, child, 'done')).toBeNull()
    expect(parentNotice(s, 'nowhere', 'done')).toBeNull()
  })

  it('상태 파일: parent 를 읽고, 모양이 틀린 값은 버린다 (옛 상태는 그대로)', () => {
    const s = world()
    const raw = JSON.parse(JSON.stringify(s)) as { tasks: Array<Record<string, unknown>> }
    raw.tasks[2]!['parent'] = { taskId: 5 }
    const back = normalizeState(raw, newId)
    expect(back.tasks[1]!.parent).toEqual(s.tasks[1]!.parent)
    expect(back.tasks[0]!.parent).toBeUndefined()
    expect(back.tasks[2]!.parent).toBeUndefined()
    raw.tasks[1]!['parent'] = { taskId: s.tasks[0]!.id }
    expect(normalizeState(raw, newId).tasks[1]!.parent).toEqual({ taskId: s.tasks[0]!.id })
  })
})
