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
  stdin = { write: (s: string) => (this.written.push(s), true), end: () => {} }
  kill() {
    return true
  }
}

function setup(found = true) {
  const sent: unknown[][] = []
  const stored: ChatEvent[] = []
  const children: FakeChild[] = []
  const envs: Record<string, string>[] = []
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => (release = r))
  const sink: Sink = { send: (...a) => sent.push(a), isDestroyed: () => false }
  const m = new ChatManager({
    store: { append: async (_p, ev) => void stored.push(...ev), read: async () => [], remove: async () => {} },
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
  return { m, sink, sent, stored, children, envs, release }
}

describe('ChatManager', () => {
  it('사용자 글은 claude 로는 원문, 창 · 디스크로는 가린 사본', async () => {
    const t = setup()
    t.release()
    expect(await t.m.send(t.sink, 'p1', `키 ${KEY}`, '/tmp', undefined)).toBe('ok')
    expect(t.children[0]!.written.join('')).toContain(KEY)
    expect(JSON.stringify(t.sent)).not.toContain(KEY)
    expect(t.sent[0]).toEqual(['chat:event', 'p1', { t: 'user', text: expect.stringContaining('‹가림'), at: 7 }, 1])
    expect(t.stored[0]).toMatchObject({ t: 'user' }) // 디스크 쪽 가리기는 ChatStore 가 한다(chat-store 시험)
    expect(t.envs[0]!['PATH']).toBe('/login/path')
  })
  it('실행 파일을 찾는 사이 두 번째 보내기는 busy', async () => {
    const t = setup()
    const first = t.m.send(t.sink, 'p1', 'a', '/tmp', undefined)
    expect(await t.m.send(t.sink, 'p1', 'b', '/tmp', undefined)).toBe('busy')
    t.release()
    expect(await first).toBe('ok')
    expect(await t.m.send(t.sink, 'p1', 'c', '/tmp', undefined)).toBe('busy') // 턴이 열려 있다
  })
  it('claude 가 없으면 missing 오류 이벤트, 다음 보내기가 다시 찾는다', async () => {
    const t = setup(false)
    t.release()
    expect(await t.m.send(t.sink, 'p1', 'a', '/tmp', undefined)).toBe('missing')
    expect(t.sent.map((s) => (s[2] as ChatEvent).t)).toEqual(['user', 'error'])
    expect(t.m.size).toBe(0)
  })
  it('창이 닫히면 그 창의 대화를 끝낸다', async () => {
    const t = setup()
    t.release()
    await t.m.send(t.sink, 'p1', 'a', '/tmp', undefined)
    t.m.closeSink(t.sink)
    expect(t.m.size).toBe(0)
  })
})

describe('AgentBinFinder', () => {
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
    expect(calls).toBe(2)
  })
})
