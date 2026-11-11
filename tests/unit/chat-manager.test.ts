import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { ChatManager, type Sink } from '../../src/main/chat/chat-manager'
import { AgentBinFinder } from '../../src/main/chat/find-bin'
import type { ChildLike } from '../../src/main/chat/claude-adapter'
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

function setup(found = true, saved: ChatEvent[] = []) {
  const sent: unknown[][] = []
  const stored: ChatEvent[] = []
  const children: FakeChild[] = []
  const envs: Record<string, string>[] = []
  const replaced: { p: string; ev: ChatEvent[] }[] = []
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => (release = r))
  const sink: Sink = { send: (...a) => sent.push(a), isDestroyed: () => false }
  const m = new ChatManager({
    store: {
      append: async (_p, ev) => void stored.push(...ev),
      read: async () => [...saved],
      remove: async () => void stored.splice(0),
      replace: async (p, ev) => void replaced.push({ p, ev: [...ev] }),
      saveImage: async () => '/img',
    },
    redactOptions: () => ({}),
    spawn: (_b, _a, o) => {
      envs.push(o.env)
      const c = new FakeChild()
      children.push(c)
      return c
    },
    findBin: async () => {
      await gate
      return found ? { bin: '/x/claude', path: '/login/path' } : null
    },
    permission: () => 'ask',
    channel: 'chat:event',
    now: () => 7,
  })
  return { m, sink, sent, stored, children, envs, release, replaced }
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
