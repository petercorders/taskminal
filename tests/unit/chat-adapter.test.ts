import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { ClaudeSession, type ChildLike } from '../../src/main/chat/claude-adapter'
import { claudeArgs, type ChatEvent } from '../../src/shared/chat'

class FakeChild extends EventEmitter implements ChildLike {
  written: string[] = []
  killed = false
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  // 실제 stdin 처럼 EventEmitter — 받는 이가 없는 'error' 는 throw 한다
  stdin = Object.assign(new EventEmitter(), { write: (s: string) => (this.written.push(s), true), end: () => {} })
  kill() {
    this.killed = true
    return true
  }
  out(o: unknown) {
    this.stdout.emit('data', JSON.stringify(o) + '\n')
  }
  sent(): unknown[] {
    return this.written.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  }
}

function setup(sessionId?: string) {
  const children: FakeChild[] = []
  const calls: string[][] = []
  const events: ChatEvent[] = []
  let exits = 0
  const s = new ClaudeSession({
    bin: 'claude',
    env: {},
    cwd: '/tmp/proj',
    permission: 'ask',
    ...(sessionId ? { sessionId } : {}),
    spawn: (_b, args) => {
      calls.push(args)
      const c = new FakeChild()
      children.push(c)
      return c
    },
    onEvent: (e) => events.push(e),
    onExit: () => exits++,
  })
  return { s, children, calls, events, exits: () => exits }
}
const perm = (id: string, command = 'touch a') => ({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command } } })
const result = { type: 'result', subtype: 'success', is_error: false, duration_ms: 5, terminal_reason: 'completed' }

describe('ClaudeSession', () => {
  it('보내기는 처음에 띄우고, 턴이 열린 동안 두 번째 보내기는 막는다', () => {
    const { s, children } = setup()
    expect(s.send('하나')).toBe(true)
    expect(s.send('둘')).toBe(false)
    expect(children).toHaveLength(1)
    expect(children[0]!.sent()).toEqual([{ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '하나' }] } }])
    children[0]!.out(result)
    expect(s.send('둘')).toBe(true)
    expect(children).toHaveLength(1) // 같은 프로세스에 이어 보냄
  })
  it('쪼개져 온 줄도 한 줄로 읽는다', () => {
    const { s, children, events } = setup()
    s.send('x')
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '반가워요' }] } }) + '\n'
    children[0]!.stdout.emit('data', line.slice(0, 10))
    children[0]!.stdout.emit('data', line.slice(10))
    expect(events).toEqual([{ t: 'text', text: '반가워요' }])
  })
  it('허락 답은 한 번만 간다 · 원래 입력을 돌려준다', () => {
    const { s, children, events } = setup()
    s.send('x')
    children[0]!.out(perm('r1'))
    expect(s.answer('r1', { how: 'allow' })).toBe(true)
    expect(s.answer('r1', { how: 'deny' })).toBe(false)
    const answers = children[0]!.sent().filter((l) => (l as { type: string }).type === 'control_response')
    expect(answers).toEqual([{ type: 'control_response', response: { subtype: 'success', request_id: 'r1', response: { behavior: 'allow', updatedInput: { command: 'touch a' } } } }])
    expect(events.filter((e) => e.t === 'answered')).toEqual([{ t: 'answered', id: 'r1', how: 'allow' }])
  })
  it('거절은 이유와 함께, 질문 답은 answers 로', () => {
    const { s, children } = setup()
    s.send('x')
    children[0]!.out(perm('r1'))
    s.answer('r1', { how: 'deny', message: 'npm 으로 해 줘' })
    children[0]!.out({ type: 'control_request', request_id: 'q1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Q?' }] } } })
    s.answer('q1', { how: 'answer', answers: { 'Q?': 'B' } })
    const res = children[0]!.sent().filter((l) => (l as { type: string }).type === 'control_response') as { response: { response: unknown } }[]
    expect(res.map((r) => r.response.response)).toEqual([
      { behavior: 'deny', message: 'npm 으로 해 줘' },
      { behavior: 'allow', updatedInput: { questions: [{ question: 'Q?' }], answers: { 'Q?': 'B' } } },
    ])
  })
  it('이 명령만 늘 허락: 같은 명령은 카드 없이 허락, 다른 명령은 다시 묻는다', () => {
    const { s, children, events } = setup()
    s.send('x')
    children[0]!.out(perm('r1'))
    s.answer('r1', { how: 'always' })
    children[0]!.out(perm('r2'))
    children[0]!.out(perm('r3', 'rm b'))
    expect(events.filter((e) => e.t === 'permission').map((e) => e.t === 'permission' && e.id)).toEqual(['r1', 'r3'])
    expect(children[0]!.sent().filter((l) => (l as { type: string }).type === 'control_response')).toHaveLength(2)
  })
  it('턴 중에 프로세스가 끝나면 crash(종료 코드) · 열린 허락은 답할 수 없다', () => {
    const { s, children, events, exits } = setup()
    s.send('x')
    children[0]!.out(perm('r1'))
    children[0]!.stderr.emit('data', 'boom\n')
    children[0]!.emit('exit', 1, null)
    expect(events.at(-1)).toEqual({ t: 'error', kind: 'crash', message: 'boom', code: 1 })
    expect(s.answer('r1', { how: 'allow' })).toBe(false)
    expect(exits()).toBe(1)
    expect(s.busy).toBe(false)
  })
  it('다시 띄운 뒤 옛 프로세스의 늦은 줄 · exit 는 버린다(세대)', () => {
    const { s, children, events, exits } = setup()
    s.send('x')
    children[0]!.emit('exit', 0, null) // 끝남 → 다음 보내기에서 새로 띄움
    const before = events.length
    s.send('y')
    expect(children).toHaveLength(2)
    children[0]!.out({ type: 'assistant', message: { content: [{ type: 'text', text: '옛 줄' }] } })
    children[0]!.emit('exit', 1, null)
    expect(events.slice(before)).toEqual([])
    expect(exits()).toBe(1)
    expect(s.busy).toBe(true)
  })
  it('멈춤: interrupt 줄을 보내고, 그 뒤 끝나면 실패가 아니라 stopped', () => {
    const { s, children, events } = setup()
    expect(s.interrupt()).toBe(false) // 돌지 않을 때는 아무것도
    s.send('x')
    expect(s.interrupt()).toBe(true)
    expect(children[0]!.sent().at(-1)).toMatchObject({ type: 'control_request', request: { subtype: 'interrupt' } })
    children[0]!.emit('exit', 1, null)
    expect(events.at(-1)).toEqual({ t: 'stopped' })
  })
  it('세션이 있으면 --resume, init 의 session_id 를 기억해 다음 띄울 때 쓴다', () => {
    const a = setup('old-1')
    a.s.send('x')
    expect(a.calls[0]).toEqual(expect.arrayContaining(['--resume', 'old-1']))
    const b = setup()
    b.s.send('x')
    expect(b.calls[0]).not.toContain('--resume')
    b.children[0]!.out({ type: 'system', subtype: 'init', session_id: 'new-9' })
    b.children[0]!.emit('exit', 0, null)
    b.s.send('y')
    expect(b.calls[1]).toEqual(expect.arrayContaining(['--resume', 'new-9']))
  })
  it('허락 방식: 떠 있으면 set_permission_mode, 다음 띄울 때 인자', () => {
    const { s, children, calls } = setup()
    s.send('x')
    s.setPermission('auto')
    expect(children[0]!.sent().at(-1)).toMatchObject({ type: 'control_request', request: { subtype: 'set_permission_mode', mode: 'auto' } })
    children[0]!.emit('exit', 0, null)
    s.send('y')
    expect(calls[1]).toEqual(expect.arrayContaining(['--permission-mode', 'auto']))
  })

  it('리뷰: 끝난 프로세스의 stdin EPIPE 는 main 을 죽이지 않는다', () => {
    const { s, children } = setup()
    s.send('하나')
    expect(() => children[0]!.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).not.toThrow()
  })
  it('리뷰: 위험한 요청은 창이 늘 허락을 보내도 이번 한 번만', () => {
    const { s, children } = setup()
    s.send('하나')
    children[0]!.out(perm('r1', 'rm -rf build'))
    expect(s.answer('r1', { how: 'always' })).toBe(true)
    children[0]!.out(perm('r2', 'rm -rf build'))
    expect(children[0]!.sent().filter((l) => (l as { type: string }).type === 'control_response')).toHaveLength(1) // r2 는 저절로 허락되지 않는다
    expect(s.answer('r2', { how: 'allow' })).toBe(true)
  })
  it('리뷰: 질문 답의 키는 원래 질문 글 — 창이 가린 글을 키로 보내도 같은 자리로 맞춘다', () => {
    const { s, children } = setup()
    s.send('하나')
    const questions = [
      { question: '키 sk-ant-api03-원문 을 쓸까요?', options: [{ label: '예' }, { label: '아니오' }] },
      { question: '어디에?', options: [{ label: '여기' }] },
    ]
    children[0]!.out({ type: 'control_request', request_id: 'q1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions } } })
    s.answer('q1', { how: 'answer', answers: { '키 ‹가림› 을 쓸까요?': '예', '어디에?': '여기' } })
    const resp = children[0]!.sent().find((l) => (l as { type: string }).type === 'control_response') as { response: { response: { updatedInput: { answers: unknown } } } }
    expect(resp.response.response.updatedInput.answers).toEqual({ '키 sk-ant-api03-원문 을 쓸까요?': '예', '어디에?': '여기' })
  })
})

describe('ClaudeSession — 22단계', () => {
  it('claudeArgs: 세션과 forkAt 이 다 있을 때만 fork 인자 (세션 없이 --resume-session-at 만 가면 새 대화가 아니다)', () => {
    expect(claudeArgs('ask', 's1', 'u-1').slice(-5)).toEqual(['--resume', 's1', '--fork-session', '--resume-session-at', 'u-1'])
    expect(claudeArgs('ask', undefined, 'u-1')).not.toContain('--fork-session')
    expect(claudeArgs('ask', undefined, 'u-1')).not.toContain('--resume-session-at')
  })
  it('그림은 user 메시지의 base64 image 블록으로', () => {
    const { s, children } = setup()
    s.send('봐', [{ name: 'a.png', mime: 'image/png', data: 'AAAA' }])
    expect(children[0]!.sent()[0]).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '봐' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] },
    })
  })
  it('턴 끝에 마지막 assistant uuid 를 anchor 로', () => {
    const { s, children, events } = setup()
    s.send('x')
    children[0]!.out({ type: 'assistant', uuid: 'u-1', message: { content: [{ type: 'text', text: 'a' }] } })
    children[0]!.out({ type: 'assistant', uuid: 'u-2', message: { content: [{ type: 'text', text: 'b' }] } })
    children[0]!.out(result)
    expect(events.at(-1)).toMatchObject({ t: 'turn_end', anchor: 'u-2' })
  })
  it('fork(): 떠 있는 것을 끝내고 다음 띄우기에 --fork-session --resume-session-at, init 뒤에는 그냥 --resume', () => {
    const { s, children, calls } = setup('s-old')
    s.send('x')
    children[0]!.out(result)
    s.fork('s-old', 'u-9')
    expect(children[0]!.killed).toBe(true)
    s.send('y')
    expect(calls[1]).toEqual(expect.arrayContaining(['--resume', 's-old', '--fork-session', '--resume-session-at', 'u-9']))
    children[1]!.out({ type: 'system', subtype: 'init', session_id: 's-new' })
    children[1]!.out(result)
    children[1]!.emit('exit', 0, null)
    s.send('z')
    expect(calls[2]).toEqual(expect.arrayContaining(['--resume', 's-new']))
    expect(calls[2]).not.toContain('--fork-session')
  })
  it('fork(null): 갈라질 앞 턴이 없으면 새 세션(--resume 없음)', () => {
    const { s, calls } = setup('s-old')
    s.fork('s-old', null)
    s.send('x')
    expect(calls[0]).not.toContain('--resume')
  })
  it('여러 개 고르기 답은 label 을 ", " 로 이어 원래 질문 글에', () => {
    const { s, children } = setup()
    s.send('x')
    children[0]!.out({ type: 'control_request', request_id: 'q1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: '고르기', multiSelect: true, options: [] }] } } })
    s.answer('q1', { how: 'answer', answers: { 고르기: ['A', 'C'] } })
    const ans = children[0]!.sent().at(-1) as { response: { response: { updatedInput: { answers: Record<string, string> } } } }
    expect(ans.response.response.updatedInput.answers).toEqual({ 고르기: 'A, C' })
  })
})
