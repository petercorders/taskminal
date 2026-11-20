import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { ChatManager, type Sink } from '../../src/main/chat/chat-manager'
import { AgentBinFinder } from '../../src/main/chat/find-bin'
import type { ChildLike } from '../../src/main/chat/claude-adapter'
import { agentGuide } from '../../src/shared/agent-guide'
import type { ChatEvent } from '../../src/shared/chat'

const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'

class FakeChild extends EventEmitter implements ChildLike {
  written: string[] = []
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  ok = true
  stdin = { write: (s: string) => (this.written.push(s), this.ok), end: () => {} }
  kill() {
    return true
  }
}

function setup(found = true, saved: ChatEvent[] = [], permission: 'ask'|'auto' = 'ask', agentGuide?: () => boolean, readLive = false) {
  const sent: unknown[][] = []
  const stored: ChatEvent[] = []
  const children: FakeChild[] = []
  const envs: Record<string, string>[] = []
  const args: string[][] = []
  const replaced: { p: string; ev: ChatEvent[] }[] = []
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => (release = r))
  const sink: Sink = { send: (...a) => sent.push(a), isDestroyed: () => false }
  const m = new ChatManager({
    store: {
      append: async (_p, ev) => void stored.push(...ev),
      read: async () => readLive ? [...saved, ...stored] : [...saved],
      remove: async () => void stored.splice(0),
      replace: async (p, ev) => void replaced.push({ p, ev: [...ev] }),
      saveImage: async () => '/img',
    },
    redactOptions: () => ({}),
    spawn: (_b, _a, o) => {
      args.push(_a)
      envs.push(o.env)
      const c = new FakeChild()
      children.push(c)
      return c
    },
    findBin: async () => {
      await gate
      return found ? { bin: '/x/claude', path: '/login/path' } : null
    },
    permission: () => permission,
    ...(agentGuide ? { agentGuide } : {}),
    channel: 'chat:event',
    now: () => 7,
  })
  return { m, sink, sent, stored, children, envs, args, release, replaced }
}

describe('ChatManager', () => {
  it('사용자 글은 claude 로는 원문, 창 · 디스크로는 가린 사본', async () => {
    const t = setup()
    t.release()
    expect(await t.m.send(t.sink, 'p1', `키 ${KEY}`, '/tmp', { agent: 'claude' })).toBe('ok')
    expect(t.children[0]!.written.join('')).toContain(KEY)
    expect(JSON.stringify(t.sent)).not.toContain(KEY)
    expect(t.sent[0]).toEqual(['chat:event', 'p1', { t: 'user', text: expect.stringContaining('‹가림'), at: 7 }, 1])
    expect(t.stored[0]).toMatchObject({ t: 'user' }) // 디스크 쪽 가리기는 ChatStore 가 한다(chat-store 시험)
    expect(t.envs[0]!['PATH']).toBe('/login/path')
  })
  it('실행 파일을 찾는 사이 두 번째 보내기는 busy', async () => {
    const t = setup()
    const first = t.m.send(t.sink, 'p1', 'a', '/tmp', { agent: 'claude' })
    expect(await t.m.send(t.sink, 'p1', 'b', '/tmp', { agent: 'claude' })).toBe('busy')
    t.release()
    expect(await first).toBe('ok')
    expect(await t.m.send(t.sink, 'p1', 'c', '/tmp', { agent: 'claude' })).toBe('busy') // 턴이 열려 있다
  })
  it('claude 가 없으면 missing 오류 이벤트, 다음 보내기가 다시 찾는다', async () => {
    const t = setup(false)
    t.release()
    expect(await t.m.send(t.sink, 'p1', 'a', '/tmp', { agent: 'claude' })).toBe('missing')
    expect(t.sent.map((s) => (s[2] as ChatEvent).t)).toEqual(['user', 'error'])
    expect(t.m.size).toBe(0)
  })
  it('창이 닫히면 그 창의 대화를 끝낸다', async () => {
    const t = setup()
    t.release()
    await t.m.send(t.sink, 'p1', 'a', '/tmp', { agent: 'claude' })
    t.m.closeSink(t.sink)
    expect(t.m.size).toBe(0)
  })
})

describe('ChatManager — 리뷰 반영', () => {
  it('실행 파일을 찾는 사이 pane 을 닫으면 띄우지 않는다', async () => {
    const t = setup()
    const p = t.m.send(t.sink, 'p1', 'a', '/tmp', { agent: 'claude' })
    t.m.close('p1', true)
    t.release()
    expect(await p).toBe('busy')
    expect(t.children).toHaveLength(0)
    expect(t.m.size).toBe(0)
  })
  it('닫은(지운) 뒤 늦게 온 exit 는 대화 파일을 다시 만들지 않는다', async () => {
    const t = setup()
    t.release()
    await t.m.send(t.sink, 'p1', 'a', '/tmp', { agent: 'claude' })
    t.m.close('p1', true)
    t.children[0]!.emit('exit', null, 'SIGTERM')
    expect(t.stored).toEqual([])
  })
  it('stdin 에 못 쓰면 사용자 글을 기록하지 않는다(턴이 열린 채 남지 않게)', async () => {
    const t = setup()
    t.release()
    await t.m.send(t.sink, 'p1', 'a', '/tmp', { agent: 'claude' })
    t.children[0]!.stdout.emit('data', JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1 }) + '\n')
    t.children[0]!.ok = false
    t.children[0]!.stdin.write = () => {
      throw new Error('destroyed')
    }
    const before = t.stored.length
    expect(await t.m.send(t.sink, 'p1', 'b', '/tmp', { agent: 'claude' })).toBe('busy')
    expect(t.stored.length).toBe(before)
  })
  it('앱이 턴 도중 끝나 열린 턴이 남은 기록은 다시 그릴 때 멈춤으로 닫는다', async () => {
    const t = setup(true, [{ t: 'user', text: 'a', at: 1 }, { t: 'text', text: '하는 중' }])
    const h = await t.m.history('p1')
    expect(h.events.at(-1)).toEqual({ t: 'stopped' })
    expect(h.upTo).toBe(1)
    expect(t.stored).toEqual([{ t: 'stopped' }])
    // 끝난 턴은 그대로
    const done = setup(true, [{ t: 'user', text: 'a', at: 1 }, { t: 'turn_end', ok: true, ms: 1, reason: 'completed' }])
    expect((await done.m.history('p1')).events).toHaveLength(2)
  })
})

describe('ChatManager — 하위 에이전트 (68단계)', () => {
  it('프로세스 없이 다시 열 때 끝 알림이 없는 하위 작업을 멈춤으로 닫는다 — 한 번만', async () => {
    const saved: ChatEvent[] = [
      { t: 'user', text: 'a', at: 1 },
      { t: 'tool', id: 'A1', name: 'Agent', summary: '뒤에서' },
      { t: 'agent', id: 'A1', phase: 'start', bg: true },
      { t: 'tool', id: 'A2', name: 'Agent', summary: '끝남' },
      { t: 'agent', id: 'A2', phase: 'start' },
      { t: 'agent', id: 'A2', phase: 'end', status: 'done', summary: 's' },
      { t: 'turn_end', ok: true, ms: 1, reason: 'completed' },
    ]
    const t = setup(true, saved)
    const h = await t.m.history('p1')
    expect(h.events.slice(saved.length)).toEqual([{ t: 'agent', id: 'A1', phase: 'end', status: 'stopped' }])
    expect(t.stored).toEqual([{ t: 'agent', id: 'A1', phase: 'end', status: 'stopped' }])
    expect(h.upTo).toBe(1)
    // 디스크에 닫힌 것이 쓰인 기록을 다시 읽으면 더 쓰지 않는다
    const again = setup(true, [...saved, ...t.stored])
    await again.m.history('p1')
    expect(again.stored).toEqual([])
  })
  it('턴 도중 끝난 기록은 멈춤 뒤에 하위 작업도 닫는다 · 프로세스가 떠 있으면 건드리지 않는다', async () => {
    const open: ChatEvent[] = [
      { t: 'user', text: 'a', at: 1 },
      { t: 'tool', id: 'A1', name: 'Agent', summary: 'd' },
      { t: 'agent', id: 'A1', phase: 'start' },
    ]
    const t = setup(true, open)
    expect(t.stored).toEqual([])
    await t.m.history('p1')
    expect(t.stored).toEqual([{ t: 'stopped' }, { t: 'agent', id: 'A1', phase: 'end', status: 'stopped' }])
    const live = setup(true, open)
    live.release()
    expect(await live.m.send(live.sink, 'p1', 'b', '/tmp', { agent: 'claude' })).toBe('ok')
    const before = live.stored.length
    await live.m.history('p1')
    expect(live.stored.length).toBe(before)
  })
})

describe('ChatManager — 하위 에이전트 되감기 (68 리뷰)', () => {
  it('되감아 남긴 기록에 끝을 못 받은 하위 작업이 있으면 멈춤으로 닫아 돌려준다(화면 · 디스크 둘 다)', async () => {
    const saved: ChatEvent[] = [
      { t: 'session', id: 's1' },
      { t: 'user', text: '하나', at: 1 },
      { t: 'tool', id: 'G', name: 'Agent', summary: '뒤' },
      { t: 'agent', id: 'G', phase: 'start', bg: true },
      { t: 'turn_end', ok: true, ms: 1, reason: 'completed', anchor: 'u1' },
      { t: 'user', text: '둘', at: 2 },
      { t: 'agent', id: 'G', phase: 'end', status: 'done', summary: '뒤늦게 끝남' },
      { t: 'turn_end', ok: true, ms: 1, reason: 'completed', anchor: 'u2' },
    ]
    const t = setup(true, saved)
    const r = await t.m.rewind('p1', 5, 2, { agent: 'claude', sessionId: 's1' })
    const close: ChatEvent = { t: 'agent', id: 'G', phase: 'end', status: 'stopped' }
    expect(r!.events).toEqual([...saved.slice(0, 5), close])
    expect(t.replaced).toEqual([{ p: 'p1', ev: saved.slice(0, 5) }])
    expect(t.stored).toEqual([close])
    expect(r!.upTo).toBe(1)
  })
})

describe('ChatManager — 되감기 · 나누기 (22단계)', () => {
  const saved: ChatEvent[] = [
    { t: 'session', id: 's1' },
    { t: 'user', text: '하나', at: 1 },
    { t: 'turn_end', ok: true, ms: 1, reason: 'completed', anchor: 'u1' },
    { t: 'user', text: '둘', at: 2 },
    { t: 'text', text: '답' },
    { t: 'turn_end', ok: true, ms: 1, reason: 'completed', anchor: 'u2' },
  ]
  it('되감기: 그 메시지 앞까지 잘라 쓰고 앞 턴 anchor · 되감은 글', async () => {
    const t = setup(true, saved)
    const r = await t.m.rewind('p1', 3, 2, { agent: 'claude', sessionId: 's1' })
    expect(r).toMatchObject({ forkAt: 'u1', sessionId: 's1', refill: '둘', masked: false })
    expect(r!.events).toHaveLength(3)
    expect(t.replaced).toEqual([{ p: 'p1', ev: saved.slice(0, 3) }])
  })
  it('확인 띠가 열린 사이 그 메시지가 사라졌으면(시각이 없으면) 버린다', async () => {
    const t = setup(true, saved)
    expect(await t.m.rewind('p1', 3, 99, { agent: 'claude' })).toBeNull()
    expect(t.replaced).toEqual([])
  })
  it('리뷰: 저장 파일 앞이 잘려 창의 번호가 어긋나도 보낸 시각으로 찾는다', async () => {
    const t = setup(true, saved)
    expect(await t.m.rewind('p1', 40, 2, { agent: 'claude' })).toMatchObject({ forkAt: 'u1', refill: '둘' })
    expect(t.replaced).toEqual([{ p: 'p1', ev: saved.slice(0, 3) }])
    expect(await t.m.branch('p1', 'p2', 0, 1)).toEqual({ forkAt: 'u1', sessionId: 's1' })
  })
  it('리뷰: 기록을 읽는 사이 보내기가 시작되면 되감지 않는다(그 턴을 잘라 내지 않게)', async () => {
    const t = setup(true, saved)
    t.release()
    const r = t.m.rewind('p1', 3, 2, { agent: 'claude', sessionId: 's1' })
    void t.m.send(t.sink, 'p1', '끼어든 글', '/tmp', { agent: 'claude' })
    expect(await r).toBeNull()
    expect(t.replaced).toEqual([])
  })
  it('리뷰: 한 번 갈라진 뒤 앞 턴으로 되감으면 그 anchor 가 난 옛 세션에서 가른다', async () => {
    const t = setup(true, [...saved, { t: 'session', id: 's2' }, { t: 'user', text: '셋', at: 3 }, { t: 'turn_end', ok: true, ms: 1, reason: 'completed', anchor: 'v1' }])
    expect(await t.m.rewind('p1', 3, 2, { agent: 'claude', sessionId: 's2' })).toMatchObject({ forkAt: 'u1', sessionId: 's1' })
  })
  it('도는 중에는 되감지 않는다', async () => {
    const t = setup(true, saved)
    t.release()
    await t.m.send(t.sink, 'p1', 'a', '/tmp', { agent: 'claude' })
    expect(await t.m.rewind('p1', 3, 2, { agent: 'claude' })).toBeNull()
  })
  it('나누기: 그 턴 끝까지를 새 pane 기록으로 · 그 턴 anchor', async () => {
    const t = setup(true, saved)
    expect(await t.m.branch('p1', 'p2', 1, 1)).toEqual({ forkAt: 'u1', sessionId: 's1' })
    expect(t.replaced).toEqual([{ p: 'p2', ev: saved.slice(0, 3) }])
    expect(await t.m.branch('p1', 'p3', 1, 5)).toBeNull()
  })
  it('codex 대화는 codex 실행 파일을 찾아 app-server 로 띄운다', async () => {
    const t = setup()
    const asked: string[] = []
    const m = new ChatManager({
      store: { append: async () => {}, read: async () => [], remove: async () => {}, replace: async () => {}, saveImage: async () => '/img' },
      redactOptions: () => ({}),
      spawn: (bin, args) => {
        asked.push(bin, ...args)
        return new FakeChild()
      },
      findBin: async (agent) => ({ bin: `/x/${agent}`, path: '' }),
      permission: () => 'ask',
      channel: 'chat:event',
    })
    expect(await m.send(t.sink, 'p1', 'a', '/tmp', { agent: 'codex' })).toBe('ok')
    expect(asked).toEqual(['/x/codex', 'app-server'])
  })
})

describe('AgentBinFinder', () => {
  it('codex: TASKMINAL_CODEX_BIN 가짜 · 로그인 셸에서 command -v codex', async () => {
    expect(await new AgentBinFinder({ TASKMINAL_CODEX_BIN: '/fake-codex', PATH: '/p' }, async () => '').codex()).toEqual({ bin: '/fake-codex', path: '/p' })
    const cmds: string[] = []
    const f = new AgentBinFinder({ SHELL: '/bin/zsh' }, async (_f, args) => (cmds.push(args[1]!), '/opt/bin/codex\n__TASKMINAL_PATH__/p'))
    expect(await f.codex()).toEqual({ bin: '/opt/bin/codex', path: '/p' })
    expect(cmds[0]).toMatch(/^command -v codex;/)
  })
  it('가짜(TASKMINAL_CLAUDE_BIN)가 먼저', async () => {
    expect(await new AgentBinFinder({ TASKMINAL_CLAUDE_BIN: '/fake', PATH: '/p' }, async () => '').claude()).toEqual({ bin: '/fake', path: '/p' })
  })
  it('로그인 셸 출력에서 경로와 PATH, 찾으면 기억 · 못 찾으면 다시', async () => {
    let calls = 0
    let out = 'stuff from zshrc\n__TASKMINAL_PATH__/a:/b'
    const f = new AgentBinFinder({ SHELL: '/bin/zsh' }, async () => (calls++, out))
    expect(await f.claude()).toBeNull()
    out = 'motd\n/Users/me/.local/bin/claude\n__TASKMINAL_PATH__/a:/b'
    expect(await f.claude()).toEqual({ bin: '/Users/me/.local/bin/claude', path: '/a:/b' })
    await f.claude()
    expect(calls).toBe(3) // 못 찾은 첫 번은 -lc · -ilc 두 번, 찾은 뒤에는 기억
  })
  it('리뷰: 로그인 셸(-lc)에서 못 찾으면 대화형(-ilc)으로 한 번 더 — .zshrc 의 PATH', async () => {
    const flags: string[] = []
    const f = new AgentBinFinder({ SHELL: '/bin/zsh' }, async (_f, args) => {
      flags.push(args[0]!)
      return args[0] === '-ilc' ? 'zshrc noise\nclaude: aliased to x\n/Users/me/.nvm/bin/claude\n__TASKMINAL_PATH__/nvm:/b' : '__TASKMINAL_PATH__/b'
    })
    expect(await f.claude()).toEqual({ bin: '/Users/me/.nvm/bin/claude', path: '/nvm:/b' })
    expect(flags).toEqual(['-lc', '-ilc'])
  })
})

describe('workflow ownership',()=>{
 it('rejects ordinary sends and preserves ASK despite global auto changes',async()=>{
  const t=setup(true,[],'auto');t.release();t.m.claim('owned')
  expect(await t.m.send(t.sink,'owned','ordinary','/tmp',{agent:'claude'})).toBe('busy')
  expect(await t.m.send(t.sink,'owned','workflow','/tmp',{agent:'claude'},[],true)).toBe('ok')
  expect(t.args[0]![t.args[0]!.indexOf('--permission-mode')+1]).toBe('default')
  t.m.setPermission('auto')
  expect(t.children[0]!.written.at(-1)).toContain('"mode":"default"')
 })
})

describe('에이전트에게 Taskminal 명령 알려 주기 (58b)', () => {
  /** 띄운 프로세스가 받은 안내 — 없으면 undefined */
  const guideOf = (args: string[]) => (args.includes('--append-system-prompt') ? args[args.indexOf('--append-system-prompt') + 1] : undefined)

  it('켜면 claude 인자에 --append-system-prompt 와 안내가 있고, 끄면 없다', async () => {
    const on = setup(true, [], 'ask', () => true)
    on.release()
    expect(await on.m.send(on.sink, 'p1', 'a', '/tmp', { agent: 'claude' })).toBe('ok')
    expect(guideOf(on.args[0]!)).toBe(agentGuide())
    expect(on.args[0]!.filter((a) => a === '--append-system-prompt')).toHaveLength(1)

    const off = setup(true, [], 'ask', () => false)
    off.release()
    expect(await off.m.send(off.sink, 'p1', 'a', '/tmp', { agent: 'claude' })).toBe('ok')
    expect(off.args[0]).not.toContain('--append-system-prompt')
    expect(off.args[0]).not.toContain(agentGuide())
  })
  it('이어 하기(--resume) · 갈라 띄우기도 새 대화와 같은 안내를 받는다', async () => {
    const t = setup(true, [], 'ask', () => true)
    t.release()
    await t.m.send(t.sink, 'p1', 'a', '/tmp', { agent: 'claude', sessionId: 's1' })
    await t.m.send(t.sink, 'p2', 'a', '/tmp', { agent: 'claude', sessionId: 's1', forkAt: 'u-1' })
    expect(t.args[0]).toEqual(expect.arrayContaining(['--resume', 's1']))
    expect(guideOf(t.args[0]!)).toBe(agentGuide())
    expect(t.args[1]).toContain('--fork-session')
    expect(guideOf(t.args[1]!)).toBe(agentGuide())
  })
  it('띄울 때마다 지금 설정을 읽는다 — 띄운 뒤 끄면 다음에 띄울 때부터 없다', async () => {
    let enabled = true
    const t = setup(true, [], 'ask', () => enabled)
    t.release()
    await t.m.send(t.sink, 'p1', 'a', '/tmp', { agent: 'claude' })
    expect(guideOf(t.args[0]!)).toBe(agentGuide())
    enabled = false
    // 같은 pane 의 프로세스가 끝난 뒤 다음 보내기가 다시 띄운다
    t.children[0]!.stdout.emit('data', JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 5, terminal_reason: 'completed' }) + '\n')
    t.children[0]!.emit('exit', 0, null)
    expect(await t.m.send(t.sink, 'p1', 'b', '/tmp', { agent: 'claude' })).toBe('ok')
    expect(t.args).toHaveLength(2)
    expect(t.args[1]).not.toContain('--append-system-prompt')
    // 다른 pane 의 새 대화도
    await t.m.send(t.sink, 'p2', 'a', '/tmp', { agent: 'claude' })
    expect(t.args[2]).not.toContain('--append-system-prompt')
  })
  it('codex 대화의 인자는 그대로', async () => {
    const t = setup(true, [], 'ask', () => true)
    t.release()
    expect(await t.m.send(t.sink, 'p1', 'a', '/tmp', { agent: 'codex' })).toBe('ok')
    expect(t.args[0]).toEqual(['app-server'])
  })
})

describe('ChatManager — 수동 휴면', () => {
  const done: ChatEvent[] = [
    { t: 'session', id: 'same-session' },
    { t: 'user', text: 'a', at: 1 },
    { t: 'turn_end', ok: true, ms: 1, reason: 'completed' },
  ]
  const chat = { agent: 'claude' as const, sessionId: 'same-session' }

  it('완료된 프로세스 종료를 기다리고 해제 후 동일한 세션에서 이어 보낸다', async () => {
    const t = setup(true, [], 'ask', undefined, true)
    t.release()
    expect(await t.m.send(t.sink, 'p1', 'a', '/tmp', chat)).toBe('ok')
    const child = t.children[0]!
    child.stdout.emit('data', JSON.stringify({ type: 'system', subtype: 'init', session_id: 'same-session' }) + '\n')
    child.stdout.emit('data', JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1 }) + '\n')
    child.kill = () => { queueMicrotask(() => child.emit('exit', null, 'SIGTERM')); return true }
    expect(await t.m.setHibernated(t.sink, 'p1', chat, true)).toBe('ok')
    expect(t.m.size).toBe(0)
    expect(t.stored.at(-1)).toEqual({ t: 'hibernation', sessionId: 'same-session', sleeping: true })
    expect(await t.m.send(t.sink, 'p1', '중간 보내기', '/tmp', chat)).toBe('busy')
    expect(await t.m.setHibernated(t.sink, 'p1', chat, false)).toBe('ok')
    expect(t.children).toHaveLength(1)
    expect(await t.m.send(t.sink, 'p1', '다른 세션', '/tmp', { ...chat, sessionId: 'wrong' })).toBe('busy')
    expect(await t.m.send(t.sink, 'p1', '이어 보내기', '/tmp', chat)).toBe('ok')
    expect(t.args[1]).toEqual(expect.arrayContaining(['--resume', 'same-session']))
  })

  it('종료가 확인되지 않으면 같은 대화를 새로 띄우지 않는다', async () => {
    vi.useFakeTimers()
    try {
      const t = setup(true, [], 'ask', undefined, true)
      t.release()
      await t.m.send(t.sink, 'p1', 'a', '/tmp', chat)
      const child = t.children[0]!
      child.stdout.emit('data', JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1 }) + '\n')
      const sleep = t.m.setHibernated(t.sink, 'p1', chat, true)
      await vi.advanceTimersByTimeAsync(3_000)
      expect(await sleep).toBe('busy')
      expect(await t.m.send(t.sink, 'p1', '다음 글', '/tmp', chat)).toBe('busy')
      expect(t.stored.some((event) => event.t === 'hibernation')).toBe(false)
      child.emit('exit', null, 'SIGTERM')
      expect(await t.m.setHibernated(t.sink, 'p1', chat, true)).toBe('ok')
    } finally {
      vi.useRealTimers()
    }
  })

  it('Codex는 해제 뒤 새로운 스레드를 만들지 않고 기존 ID를 재개한다', async () => {
    const codex = { ...chat, agent: 'codex' as const }
    const t = setup(true, [...done, { t: 'hibernation', sessionId: 'same-session', sleeping: true }], 'ask', undefined, true)
    t.release()
    expect(await t.m.setHibernated(t.sink, 'p1', codex, false)).toBe('ok')
    expect(await t.m.send(t.sink, 'p1', '이어 보내기', '/tmp', codex)).toBe('ok')
    const child = t.children[0]!
    const reply = async (method: string, result: object) => {
      const request = child.written.map((line) => JSON.parse(line)).find((value) => value.method === method)
      expect(request).toBeDefined()
      child.stdout.emit('data', JSON.stringify({ id: request.id, result }) + '\n')
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    await reply('initialize', {})
    await reply('account/read', { account: { type: 'test' } })
    expect(child.written.map((line) => JSON.parse(line)).at(-1)).toMatchObject({ method: 'thread/resume', params: { threadId: 'same-session' } })
    await reply('thread/resume', { thread: { id: 'same-session' } })
    await reply('turn/start', { turn: { id: 'turn-1' } })
  })

  it('재시작 뒤에도 휴면을 지키며 다른 세션으로는 해제할 수 없다', async () => {
    const t = setup(true, [...done, { t: 'hibernation', sessionId: 'same-session', sleeping: true }], 'ask', undefined, true)
    t.release()
    expect(await t.m.send(t.sink, 'p1', 'b', '/tmp', chat)).toBe('busy')
    expect(await t.m.setHibernated(t.sink, 'p1', { ...chat, sessionId: 'other' }, false)).toBe('unavailable')
    expect(t.children).toHaveLength(0)
  })

  it('진행 중, 하위 작업 실행 중, 갈라질 예정인 대화의 휴면을 거절한다', async () => {
    const open = setup(true, [...done, { t: 'tool', id: 'still-active', name: 'Agent', summary: '백그라운드' }, { t: 'agent', id: 'still-active', phase: 'start' }], 'ask', undefined, true)
    expect(await open.m.setHibernated(open.sink, 'p1', chat, true)).toBe('unavailable')
    const t = setup(true, [], 'ask', undefined, true)
    t.release()
    await t.m.send(t.sink, 'p1', 'a', '/tmp', chat)
    expect(await t.m.setHibernated(t.sink, 'p1', chat, true)).toBe('busy')
    expect(await t.m.setHibernated(t.sink, 'p1', { ...chat, forkAt: 'old-anchor' }, true)).toBe('unavailable')
    expect(t.m.size).toBe(1)
  })
})
