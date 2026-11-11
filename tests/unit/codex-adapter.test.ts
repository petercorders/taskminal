import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { ChildLike } from '../../src/main/chat/claude-adapter'
import { CodexSession } from '../../src/main/chat/codex-adapter'
import type { ChatEvent } from '../../src/shared/chat'

type Msg = { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown }

/** 받은 요청에 대본대로 답하는 가짜 app-server */
class FakeServer extends EventEmitter implements ChildLike {
  got: Msg[] = []
  killed = false
  loggedIn = true
  /** thread/resume 에 오류로 답한다 (지워진 스레드) */
  failResume = false
  threads = 0
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdin = Object.assign(new EventEmitter(), {
    write: (s: string) => {
      for (const l of s.split('\n').filter(Boolean)) this.onMsg(JSON.parse(l) as Msg)
      return true
    },
    end: () => {},
  })
  kill() {
    this.killed = true
    return true
  }
  out(o: unknown) {
    this.stdout.emit('data', JSON.stringify(o) + '\n')
  }
  private onMsg(m: Msg) {
    this.got.push(m)
    if (m.id === undefined || !m.method) return
    const reply = (result: unknown) => queueMicrotask(() => this.out({ id: m.id, result }))
    switch (m.method) {
      case 'initialize':
        return reply({ userAgent: 'fake' })
      case 'account/read':
        return reply(this.loggedIn ? { account: { type: 'chatgpt' }, requiresOpenaiAuth: true } : { account: null, requiresOpenaiAuth: true })
      case 'thread/start':
      case 'thread/resume':
      case 'thread/fork':
        if (m.method === 'thread/resume' && this.failResume) return queueMicrotask(() => this.out({ id: m.id, error: { code: -32600, message: 'thread not found' } }))
        return reply({ thread: { id: m.method === 'thread/resume' ? m.params!['threadId'] : `thr-${++this.threads}`, model: 'gpt-fake' } })
      case 'turn/start':
        return reply({ turn: { id: `turn-${this.got.filter((x) => x.method === 'turn/start').length}`, status: 'inProgress' } })
      case 'turn/interrupt':
        return reply({})
    }
  }
  sentMethods(): string[] {
    return this.got.filter((m) => m.method).map((m) => m.method!)
  }
  answers(): Msg[] {
    return this.got.filter((m) => m.id !== undefined && !m.method)
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

function setup(o: { sessionId?: string; forkAt?: string; loggedIn?: boolean; failResume?: boolean } = {}) {
  const servers: FakeServer[] = []
  const events: ChatEvent[] = []
  const saved: string[] = []
  const s = new CodexSession({
    bin: 'codex',
    env: {},
    cwd: '/tmp/work',
    permission: 'ask',
    ...(o.sessionId ? { sessionId: o.sessionId } : {}),
    ...(o.forkAt ? { forkAt: o.forkAt } : {}),
    spawn: (_b, args) => {
      expect(args).toEqual(['app-server'])
      const c = new FakeServer()
      if (o.loggedIn === false) c.loggedIn = false
      if (o.failResume) c.failResume = true
      servers.push(c)
      return c
    },
    saveImage: async (img, n) => {
      saved.push(img.name)
      return `/tmp/img/${n}.png`
    },
    onEvent: (e) => events.push(e),
    onExit: () => {},
  })
  return { s, servers, events, saved }
}
const done = (turnId: string) => ({ method: 'turn/completed', params: { threadId: 'thr-1', turn: { id: turnId, status: 'completed', durationMs: 10, error: null } } })
const approval = (id: number, command = 'touch a') => ({ id, method: 'item/commandExecution/requestApproval', params: { threadId: 'thr-1', turnId: 'turn-1', itemId: 'c1', command, cwd: '/tmp/work' } })

describe('CodexSession', () => {
  it('처음 보내기: initialize → initialized → account/read → thread/start → turn/start, 세션 이벤트', async () => {
    const { s, servers, events } = setup()
    expect(s.send('안녕')).toBe(true)
    expect(s.send('둘')).toBe(false) // 한 번에 하나
    await tick()
    await tick()
    expect(servers[0]!.sentMethods()).toEqual(['initialize', 'initialized', 'account/read', 'thread/start', 'turn/start'])
    const start = servers[0]!.got.find((m) => m.method === 'thread/start')!
    expect(start.params).toEqual({ cwd: '/tmp/work', approvalPolicy: 'untrusted', sandbox: 'workspace-write' })
    const turn = servers[0]!.got.find((m) => m.method === 'turn/start')!
    expect(turn.params).toEqual({ threadId: 'thr-1', input: [{ type: 'text', text: '안녕', text_elements: [] }], approvalPolicy: 'untrusted' })
    expect(events[0]).toEqual({ t: 'session', id: 'thr-1', model: 'gpt-fake' })
    servers[0]!.out(done('turn-1'))
    expect(events.at(-1)).toMatchObject({ t: 'turn_end', ok: true, anchor: 'turn-1' })
    expect(s.send('둘')).toBe(true)
    await tick()
    expect(servers).toHaveLength(1) // 같은 프로세스 · 같은 스레드
    expect(servers[0]!.sentMethods().filter((m) => m === 'thread/start')).toHaveLength(1)
  })

  it('로그인이 없으면 turn/start 를 보내지 않고 로그인 오류 · 프로세스를 끝낸다 → 다음 보내기가 다시 본다', async () => {
    const { s, servers, events } = setup({ loggedIn: false })
    s.send('안녕')
    await tick()
    await tick()
    expect(servers[0]!.sentMethods()).not.toContain('turn/start')
    expect(events).toEqual([{ t: 'error', kind: 'login', message: expect.any(String) }])
    expect(servers[0]!.killed).toBe(true)
    expect(s.busy).toBe(false)
    servers[0]!.emit('exit', 0, null)
    expect(events).toHaveLength(1) // 끝남이 크래시로 보이지 않는다
    s.send('다시')
    await tick()
    expect(servers).toHaveLength(2)
  })

  it('저장된 스레드면 thread/resume, forkAt 이 있으면 thread/fork(lastTurnId) — 한 번만', async () => {
    const a = setup({ sessionId: 'thr-old' })
    a.s.send('x')
    await tick()
    await tick()
    expect(a.servers[0]!.got.find((m) => m.method === 'thread/resume')!.params).toMatchObject({ threadId: 'thr-old', excludeTurns: true })
    const b = setup({ sessionId: 'thr-old', forkAt: 'turn-3' })
    b.s.send('x')
    await tick()
    await tick()
    expect(b.servers[0]!.got.find((m) => m.method === 'thread/fork')!.params).toMatchObject({ threadId: 'thr-old', lastTurnId: 'turn-3' })
    expect(b.events[0]).toMatchObject({ t: 'session', id: 'thr-1' })
  })

  it('fork(): 떠 있는 프로세스를 떼어 내고, 다음 보내기가 갈라진 스레드로', async () => {
    const { s, servers } = setup()
    s.send('x')
    await tick()
    await tick()
    servers[0]!.out(done('turn-1'))
    s.fork('thr-1', 'turn-1')
    expect(servers[0]!.killed).toBe(true)
    servers[0]!.emit('exit', 0, null) // 늦은 exit — 세대가 지나 버림
    s.send('y')
    await tick()
    await tick()
    expect(servers).toHaveLength(2)
    expect(servers[1]!.got.find((m) => m.method === 'thread/fork')!.params).toMatchObject({ threadId: 'thr-1', lastTurnId: 'turn-1' })
    s.fork(undefined, null)
    s.send('z')
    await tick()
    await tick()
    expect(servers[2]!.sentMethods()).toContain('thread/start')
  })

  it('승인: 카드 이벤트 → 답은 한 번만, deny 는 decline', async () => {
    const { s, servers, events } = setup()
    s.send('x')
    await tick()
    await tick()
    servers[0]!.out(approval(50))
    expect(events.at(-1)).toEqual({ t: 'permission', id: '50', tool: 'Bash', summary: 'touch a', why: '', danger: false })
    expect(s.answer('50', { how: 'allow' })).toBe(true)
    expect(s.answer('50', { how: 'allow' })).toBe(false)
    expect(servers[0]!.answers()).toEqual([{ id: 50, result: { decision: 'accept' } }])
    servers[0]!.out(approval(51, 'touch b'))
    s.answer('51', { how: 'deny', message: '하지 마' })
    expect(servers[0]!.answers().at(-1)).toEqual({ id: 51, result: { decision: 'decline' } })
  })

  it('늘 허락: 같은 명령의 다음 승인은 앱이 바로 accept, 위험 명령은 이번 한 번만', async () => {
    const { s, servers, events } = setup()
    s.send('x')
    await tick()
    await tick()
    servers[0]!.out(approval(60))
    s.answer('60', { how: 'always' })
    const n = events.length
    servers[0]!.out(approval(61))
    expect(events).toHaveLength(n) // 카드 없이
    expect(servers[0]!.answers().at(-1)).toEqual({ id: 61, result: { decision: 'accept' } })
    servers[0]!.out(approval(62, 'rm -rf build'))
    s.answer('62', { how: 'always' })
    servers[0]!.out(approval(63, 'rm -rf build'))
    expect(events.at(-1)).toMatchObject({ t: 'permission', id: '63', danger: true })
  })

  it('질문 답은 질문 id 로 (가린 질문 글이 와도 순서대로)', async () => {
    const { s, servers } = setup()
    s.send('x')
    await tick()
    await tick()
    servers[0]!.out({ id: 70, method: 'item/tool/requestUserInput', params: { threadId: 'thr-1', questions: [{ id: 'q1', header: '', question: '키 sk-ant-x?', options: [{ label: 'A', description: '' }] }] } })
    s.answer('70', { how: 'answer', answers: { '키 ‹가림›?': 'A' } })
    expect(servers[0]!.answers().at(-1)).toEqual({ id: 70, result: { answers: { q1: { answers: ['A'] } } } })
  })

  it('모르는 서버 요청에는 오류로 바로 답한다(codex 가 기다리지 않게)', async () => {
    const { s, servers } = setup()
    s.send('x')
    await tick()
    await tick()
    servers[0]!.out({ id: 80, method: 'item/tool/call', params: { threadId: 'thr-1' } })
    expect(servers[0]!.answers().at(-1)).toMatchObject({ id: 80, error: { code: -32601 } })
  })

  it('다른 스레드의 알림은 버린다', async () => {
    const { s, servers, events } = setup()
    s.send('x')
    await tick()
    await tick()
    const n = events.length
    servers[0]!.out({ method: 'item/completed', params: { threadId: 'thr-other', item: { type: 'agentMessage', id: 'm', text: '옛 글' } } })
    expect(events).toHaveLength(n)
  })

  it('멈춤: turn/interrupt(threadId, turnId) → interrupted 로 stopped', async () => {
    const { s, servers, events } = setup()
    s.send('x')
    await tick()
    await tick()
    expect(s.interrupt()).toBe(true)
    expect(servers[0]!.got.at(-1)).toMatchObject({ method: 'turn/interrupt', params: { threadId: 'thr-1', turnId: 'turn-1' } })
    servers[0]!.out({ method: 'turn/completed', params: { threadId: 'thr-1', turn: { id: 'turn-1', status: 'interrupted' } } })
    expect(events.at(-1)).toEqual({ t: 'stopped' })
    expect(s.busy).toBe(false)
  })

  it('그림은 파일로 저장해 localImage 경로로', async () => {
    const { s, servers, saved } = setup()
    s.send('봐', [{ name: 'shot.png', mime: 'image/png', data: 'AAAA' }])
    await tick()
    await tick()
    await tick()
    expect(saved).toEqual(['shot.png'])
    const turn = servers[0]!.got.find((m) => m.method === 'turn/start')!
    expect(turn.params!['input']).toEqual([
      { type: 'text', text: '봐', text_elements: [] },
      { type: 'localImage', path: '/tmp/img/1.png' },
    ])
  })

  it('턴 도중 프로세스가 끝나면 크래시 오류 · 옛 세대의 exit 는 버린다', async () => {
    const { s, servers, events } = setup()
    s.send('x')
    await tick()
    await tick()
    servers[0]!.stderr.emit('data', '\x1b[31mERROR\x1b[0m boom\n')
    servers[0]!.emit('exit', 1, null)
    expect(events.at(-1)).toEqual({ t: 'error', kind: 'crash', message: 'ERROR boom', code: 1 })
    servers[0]!.emit('exit', 1, null)
    expect(events.filter((e) => e.t === 'error')).toHaveLength(1)
  })

  it('허락 방식은 다음 턴의 approvalPolicy 로', async () => {
    const { s, servers } = setup()
    s.send('x')
    await tick()
    await tick()
    servers[0]!.out(done('turn-1'))
    s.setPermission('auto')
    s.send('y')
    await tick()
    expect(servers[0]!.got.filter((m) => m.method === 'turn/start').at(-1)!.params).toMatchObject({ approvalPolicy: 'never' })
  })

  it('리뷰: 스레드를 못 열면(이어 할 스레드가 없음) 오류 · 프로세스를 떼어 내고 다음 보내기가 처음부터 다시', async () => {
    const { s, servers, events } = setup({ sessionId: 'gone', failResume: true })
    s.send('x')
    for (let i = 0; i < 6; i++) await tick()
    expect(events.at(-1)).toMatchObject({ t: 'error', kind: 'other', message: 'thread not found' })
    expect(servers[0]!.killed).toBe(true)
    expect(servers[0]!.sentMethods()).not.toContain('turn/start')
    expect(s.busy).toBe(false)
    s.send('y')
    for (let i = 0; i < 6; i++) await tick()
    expect(servers).toHaveLength(2) // 새로 띄워 initialize 부터
    expect(servers[1]!.sentMethods()[0]).toBe('initialize')
  })
  it('리뷰: 턴 id 를 받기 전에 누른 멈춤은 턴 id 를 받으면 보낸다', async () => {
    const { s, servers } = setup()
    s.send('x')
    expect(s.interrupt()).toBe(true) // 아직 띄우는 중
    for (let i = 0; i < 6; i++) await tick()
    expect(servers[0]!.got.at(-1)).toMatchObject({ method: 'turn/interrupt', params: { threadId: 'thr-1', turnId: 'turn-1' } })
    expect(servers[0]!.sentMethods().filter((m) => m === 'turn/interrupt')).toHaveLength(1)
  })
})
