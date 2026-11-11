import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CliServer, type CliServerDeps } from '../../src/main/cli-server'
import { lastTurnText } from '../../src/shared/chat'
import { CLI_PROTOCOL, type PaneTarget, type UiReply, type UiRequest } from '../../src/shared/cli'
import type { ChatEvent } from '../../src/shared/chat'
import { PaneWatch } from '../../src/shared/pane-watch'

const dirs: string[] = []
const servers: CliServer[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const realClock = { now: () => Date.now(), later: (fn: () => void, ms: number) => ((t) => () => clearTimeout(t))(setTimeout(fn, ms)) }

const term: PaneTarget = { paneId: 'p1', label: 'A › w', kind: 'terminal', cwd: '/tmp', pending: false }
const chatT = (id: string): PaneTarget => ({ paneId: id, label: `A › ${id}`, kind: 'chat', cwd: '/tmp', chat: { agent: 'claude' }, pending: false })

function setup(over: Partial<CliServerDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tm-cli-'))
  dirs.push(dir)
  const asked: UiRequest[] = []
  const written: Array<[string, string]> = []
  const listeners = new Set<(p: string, ev: ChatEvent) => void>()
  const history: Record<string, ChatEvent[]> = {}
  const watch = new PaneWatch(realClock)
  const deps: CliServerDeps = {
    sockPath: join(dir, 'cli.sock'),
    askUi: async (req): Promise<UiReply> => {
      asked.push(req)
      if (req.op === 'pane.resolve') return { ok: true, target: req.pane?.startsWith('c') ? chatT(req.pane) : term }
      if (req.op === 'chat.panes') return { ok: true, targets: ['c1', 'c2'].map(chatT) }
      if (req.op === 'chat.new') return { ok: true, target: chatT('c9') }
      return { ok: true, text: `ui:${req.op}` }
    },
    pane: {
      ready: async () => true,
      write: (p, d) => (written.push([p, d]), true),
      tail: async () => 'line1\nTOKEN sk-ant-api03-secretsecretsecretsecret\nline3',
      info: async () => ({ running: false, lastOutputAt: 0 }),
    },
    watch,
    chat: {
      send: async () => 'ok',
      history: async (p) => history[p] ?? [],
      subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    },
    redact: (s) => s.replace(/sk-ant-\S+/g, '‹가림›'),
    ...over,
  }
  const server = new CliServer(deps)
  servers.push(server)
  const emit = (p: string, ev: ChatEvent) => listeners.forEach((fn) => fn(p, ev))
  return { server, deps, asked, written, history, emit, listeners, watch }
}

function call(path: string, body: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const s = connect(path)
    let buf = ''
    s.setEncoding('utf8')
    s.on('connect', () => s.write(JSON.stringify(body) + '\n'))
    s.on('data', (c: string) => (buf += c))
    s.on('end', () => resolve(JSON.parse(buf)))
    s.on('error', reject)
  })
}

describe('CliServer 소켓', () => {
  it('0600 으로 열고, 앱이 죽고 남은 소켓 파일은 지우고 다시 연다', async () => {
    const { server, deps } = setup()
    // 죽은 앱이 남긴 소켓: 듣던 프로세스를 SIGKILL — 파일만 남는다(스파이크와 같은 방법)
    const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(deps.sockPath)}, () => console.log('up'))`])
    await new Promise<void>((r) => child.stdout.once('data', () => r()))
    child.kill('SIGKILL')
    await new Promise<void>((r) => child.once('exit', () => r()))
    expect(statSync(deps.sockPath).isSocket()).toBe(true) // 남은 파일이 있다
    await server.listen()
    expect(statSync(deps.sockPath).mode & 0o777).toBe(0o600)
    expect(await call(deps.sockPath, { v: CLI_PROTOCOL, op: 'list' })).toEqual({ ok: true, text: 'ui:list' })
    server.close()
    expect(() => statSync(deps.sockPath)).toThrow()
  })

  it('만들어지는 순간부터 같은 사용자만 — listen 동안 umask 077 · 끝나면 원래 값', async () => {
    const { server } = setup()
    const before = process.umask()
    const spy = vi.spyOn(process, 'umask')
    try {
      await server.listen()
      expect(spy.mock.calls[0]).toEqual([0o077])
      expect(process.umask()).toBe(before)
    } finally {
      spy.mockRestore()
      server.close()
    }
  })

  it('소켓이 아닌 같은 이름 파일은 지우지 않는다 (listen 이 실패)', async () => {
    const { server, deps } = setup()
    writeFileSync(deps.sockPath, 'x')
    await expect(server.listen()).rejects.toThrow()
    expect(statSync(deps.sockPath).isFile()).toBe(true)
  })

  it('버전이 다르거나 모양이 틀리면 사용법 오류', async () => {
    const { server, deps, asked } = setup()
    await server.listen()
    expect(await call(deps.sockPath, { v: 99, op: 'list' })).toMatchObject({ ok: false, exit: 2, error: expect.stringContaining('버전') })
    expect(await call(deps.sockPath, { v: CLI_PROTOCOL, op: 'pane.read', pane: 'p', lines: 99999 })).toMatchObject({ ok: false, exit: 2 })
    expect(asked).toHaveLength(0)
  })

  it('기다리는 중에 CLI 가 끊으면 기다림을 버린다', async () => {
    const { server, deps, watch } = setup()
    await server.listen()
    watch.feed('p1', '\x1b]133;C\x07')
    const s = connect(deps.sockPath)
    await new Promise<void>((r) => s.on('connect', r))
    s.write(JSON.stringify({ v: CLI_PROTOCOL, op: 'pane.wait', pane: 'p1', for: { kind: 'exit' }, timeoutMs: 60_000, quietMs: 3000 }) + '\n')
    await expect.poll(() => watch.snapshot('p1').waiters).toBe(1)
    s.destroy()
    await expect.poll(() => watch.snapshot('p1').waiters).toBe(0)
  })
})

describe('CliServer 처리', () => {
  it('pane send: 이름을 풀고 셸에 쓴다 (↩ 포함)', async () => {
    const { server, written, asked } = setup()
    expect(await server.handle({ op: 'pane.send', pane: 'A', text: 'y', enter: true, self: 'me' })).toEqual({ ok: true })
    expect(written).toEqual([['p1', 'y\r']])
    expect(asked[0]).toEqual({ op: 'pane.resolve', pane: 'A', self: 'me' })
  })

  it('pane read: 가린 뒤 돌려준다', async () => {
    const { server } = setup()
    const r = await server.handle({ op: 'pane.read', pane: 'A', lines: 3 })
    expect(r).toMatchObject({ ok: true, text: 'line1\nTOKEN ‹가림›\nline3' })
    expect(JSON.stringify(r)).not.toContain('secret')
  })

  it('pane wait text: 화면에 있으면 찾은 줄(가린 것)', async () => {
    const { server } = setup()
    expect(await server.handle({ op: 'pane.wait', pane: 'A', for: { kind: 'text', text: 'TOKEN' }, timeoutMs: 1000, quietMs: 100 })).toMatchObject({ ok: true, text: '찾음: TOKEN ‹가림›' })
  })

  it('pane wait: 시간 초과는 124 · 셸이 안 뜨면 오류', async () => {
    const { server, watch } = setup()
    watch.feed('p1', '\x1b]133;C\x07')
    expect(await server.handle({ op: 'pane.wait', pane: 'A', for: { kind: 'exit' }, timeoutMs: 20, quietMs: 100 })).toMatchObject({ ok: false, exit: 124 })
    const b = setup({ pane: { ready: async () => false, write: () => true, tail: async () => '', info: async () => null } })
    expect(await b.server.handle({ op: 'pane.send', pane: 'A', text: 'x', enter: false })).toMatchObject({ ok: false, error: expect.stringContaining('뜨지 않았') })
  })

  it('대화 pane 에 pane send 를 하면 chat send 를 권한다', async () => {
    const { server, written } = setup()
    expect(await server.handle({ op: 'pane.send', pane: 'c1', text: 'x', enter: true })).toMatchObject({ ok: false, error: expect.stringContaining('chat send') })
    expect(written).toHaveLength(0)
  })

  it('chat new: 창이 pane 을 만들고 main 이 첫 글을 보낸다', async () => {
    const sent: Array<[string, string]> = []
    const { server } = setup({ chat: { send: async (t, x) => (sent.push([t.paneId, x]), 'ok'), history: async () => [], subscribe: () => () => {} } })
    expect(await server.handle({ op: 'chat.new', agent: 'claude', where: 'right', text: '시험 고쳐 줘' })).toMatchObject({ ok: true, data: { pane: 'c9' } })
    expect(sent).toEqual([['c9', '시험 고쳐 줘']])
    const busy = setup({ chat: { send: async () => 'busy', history: async () => [], subscribe: () => () => {} } })
    expect(await busy.server.handle({ op: 'chat.send', pane: 'c1', text: 'x' })).toMatchObject({ ok: false, error: expect.stringContaining('실행 중') })
  })

  it('chat wait --all: 둘 다 끝날 때까지, 허락을 기다리면 그 자리에서 멈춘다', async () => {
    const { server, history, emit, listeners } = setup()
    history['c1'] = [{ t: 'user', text: 'a', at: 1 }]
    history['c2'] = [{ t: 'user', text: 'b', at: 1 }]
    const p = server.handle({ op: 'chat.wait', panes: [], all: true, timeoutMs: 5000 })
    await expect.poll(() => listeners.size).toBe(1)
    await new Promise((r) => setTimeout(r, 10))
    emit('c1', { t: 'turn_end', ok: true, ms: 5, reason: 'success' })
    emit('c2', { t: 'permission', id: 'x', tool: 'Bash', summary: 'rm', why: '', danger: true })
    const r = await p
    expect(r).toMatchObject({ ok: true, exit: 0 })
    expect((r as { text: string }).text).toContain('끝남')
    expect((r as { text: string }).text).toContain('허락')
    expect(listeners.size).toBe(0)
  })

  it('chat wait: 이미 끝난 대화는 바로 · 시간이 다 되면 124 와 그때 상태', async () => {
    const { server, history } = setup()
    history['c1'] = [{ t: 'user', text: 'a', at: 1 }, { t: 'turn_end', ok: true, ms: 1, reason: '' }]
    history['c2'] = [{ t: 'user', text: 'b', at: 1 }]
    const r = await server.handle({ op: 'chat.wait', panes: ['c1', 'c2'], all: false, timeoutMs: 30 })
    expect(r).toMatchObject({ ok: true, exit: 124 })
    expect((r as { data: Array<{ state: string }> }).data.map((x) => x.state)).toEqual(['done', 'run'])
  })

  it('chat read: 마지막 턴의 에이전트 글', async () => {
    const { server, history } = setup()
    history['c1'] = [
      { t: 'user', text: 'q1', at: 1 },
      { t: 'text', text: 'old' },
      { t: 'turn_end', ok: true, ms: 1, reason: '' },
      { t: 'user', text: 'q2', at: 2 },
      { t: 'text', text: '고쳤어요' },
      { t: 'tool', id: 't', name: 'Bash', summary: 'x' },
      { t: 'text', text: '시험 통과' },
    ]
    expect(await server.handle({ op: 'chat.read', pane: 'c1' })).toMatchObject({ ok: true, text: '고쳤어요\n시험 통과', data: { state: 'run' } })
  })

  it('화면 상태를 바꾸는 요청은 창에 그대로', async () => {
    const { server, asked } = setup()
    expect(await server.handle({ op: 'task.move', status: '완료', self: 'p1' })).toEqual({ ok: true, text: 'ui:task.move' })
    expect(asked).toEqual([{ op: 'task.move', status: '완료', self: 'p1' }])
  })
})

describe('lastTurnText', () => {
  it('사용자 글이 없으면 모든 글', () => {
    expect(lastTurnText([{ t: 'text', text: 'a' }, { t: 'text', text: 'b' }])).toBe('a\nb')
    expect(lastTurnText([])).toBe('')
  })
})
