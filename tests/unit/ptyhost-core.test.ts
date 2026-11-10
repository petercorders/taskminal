import { describe, expect, it, beforeEach } from 'vitest'
import { HostCore, type PtyLike, type SpawnPty } from '../../src/main/ptyhost/host-core'

// 지킴이 핵심 — 가짜 pty + 실제 @xterm/headless. 소켓 · node-pty 는 e2e 가 본다.

class FakePty implements PtyLike {
  static next = 100
  pid = FakePty.next++
  written: string[] = []
  kills: string[] = []
  size: [number, number] = [0, 0]
  private dataCb: (d: string) => void = () => {}
  private exitCb: (e: { exitCode: number; signal?: number }) => void = () => {}
  write(d: string) {
    this.written.push(d)
  }
  resize(c: number, r: number) {
    this.size = [c, r]
  }
  kill(sig?: string) {
    this.kills.push(sig ?? 'SIGHUP')
  }
  onData(cb: (d: string) => void) {
    this.dataCb = cb
    return { dispose() {} }
  }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void) {
    this.exitCb = cb
    return { dispose() {} }
  }
  emit(d: string) {
    this.dataCb(d)
  }
  exit(exitCode: number, signal?: number) {
    this.exitCb(signal === undefined ? { exitCode } : { exitCode, signal })
  }
}

class Conn {
  frames: Array<Record<string, unknown>> = []
  send(f: object) {
    this.frames.push(f as Record<string, unknown>)
  }
  reply(id: number) {
    return this.frames.find((f) => f['id'] === id)
  }
  data() {
    return this.frames.filter((f) => f['ev'] === 'data').map((f) => f['data'] as string).join('')
  }
}

let ptys: FakePty[]
let timers: Array<{ fn: () => void; at: number }>
let clock: number
let shutdowns: number
let core: HostCore

const spawnPty: SpawnPty = () => {
  const p = new FakePty()
  ptys.push(p)
  return p
}
const advance = (ms: number) => {
  clock += ms
  for (const t of timers.filter((x) => x.at <= clock)) {
    timers.splice(timers.indexOf(t), 1)
    t.fn()
  }
}
const tick = () => new Promise((r) => setTimeout(r, 5))
async function until<T>(f: () => T | undefined): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const v = f()
    if (v !== undefined) return v
    await tick()
  }
  throw new Error('기다린 값이 오지 않음')
}

const spawnReq = (id: number, paneId = 'p1') => ({ op: 'spawn' as const, id, paneId, file: '/bin/zsh', args: ['-l'], cwd: '/tmp', env: { TERM: 'xterm-256color' }, cols: 80, rows: 24 })

beforeEach(() => {
  ptys = []
  timers = []
  clock = 1_000_000
  shutdowns = 0
  core = new HostCore({
    spawnPty,
    now: () => clock,
    schedule: (fn, ms) => {
      const t = { fn, at: clock + ms }
      timers.push(t)
      return () => void timers.splice(timers.indexOf(t), 1)
    },
    version: 1,
    pid: 4242,
    rss: () => 50 * 1024 * 1024,
    onShutdown: () => shutdowns++,
  })
})

describe('HostCore', () => {
  it('hello 는 버전 · pid 를 답한다', () => {
    const a = new Conn()
    core.open(a)
    core.handle(a, { op: 'hello', id: 1, version: 1 })
    expect(a.reply(1)).toMatchObject({ ok: true, version: 1, pid: 4242, startedAt: 1_000_000 })
  })

  it('spawn 은 셸을 띄우고 출력을 띄운 손님에게 보낸다 · 같은 paneId 는 새로 만들지 않는다', () => {
    const a = new Conn()
    core.open(a)
    core.handle(a, spawnReq(1))
    expect(a.reply(1)).toMatchObject({ ok: true, pid: ptys[0]!.pid, existing: false })
    ptys[0]!.emit('hello\r\n')
    expect(a.data()).toBe('hello\r\n')
    core.handle(a, spawnReq(2))
    expect(a.reply(2)).toMatchObject({ ok: true, existing: true, pid: ptys[0]!.pid })
    expect(ptys).toHaveLength(1)
    expect(core.liveCount).toBe(1)
  })

  it('손님이 떨어진 동안의 출력도 다시 붙을 때 화면에 있다 · 그 뒤 출력은 새 손님에게', async () => {
    const a = new Conn()
    core.open(a)
    core.handle(a, spawnReq(1))
    ptys[0]!.emit('before-quit\r\n')
    core.close(a)
    ptys[0]!.emit('while-away\r\n')
    expect(a.data()).not.toContain('while-away')
    clock += 41_000
    const b = new Conn()
    core.open(b)
    core.handle(b, { op: 'attach', id: 7, paneId: 'p1' })
    const r = await until(() => b.reply(7))
    expect(r).toMatchObject({ ok: true, found: true, pid: ptys[0]!.pid, detachedMs: 41_000 })
    expect(r['screen']).toContain('before-quit')
    expect(r['screen']).toContain('while-away')
    ptys[0]!.emit('after\r\n')
    expect(b.data()).toBe('after\r\n')
  })

  it('attach 답을 기다리는 사이에 온 출력도 잃지 않는다', async () => {
    const a = new Conn()
    core.open(a)
    core.handle(a, spawnReq(1))
    core.close(a)
    const b = new Conn()
    core.open(b)
    core.handle(b, { op: 'attach', id: 2, paneId: 'p1' })
    ptys[0]!.emit('in-between\r\n') // 답이 나가기 전
    const r = await until(() => b.reply(2))
    const after = b.frames.slice(b.frames.indexOf(r)).filter((f) => f['ev'] === 'data').map((f) => f['data']).join('')
    expect(String(r['screen']) + after).toContain('in-between')
  })

  it('없는 pane 에 attach 하면 found:false', async () => {
    const a = new Conn()
    core.open(a)
    core.handle(a, { op: 'attach', id: 1, paneId: 'nope' })
    expect(await until(() => a.reply(1))).toMatchObject({ ok: true, found: false })
  })

  it('detach 하면 그 손님에게 출력을 보내지 않는다', () => {
    const a = new Conn()
    core.open(a)
    core.handle(a, spawnReq(1))
    core.handle(a, { op: 'detach', paneId: 'p1' })
    ptys[0]!.emit('x')
    expect(a.data()).toBe('')
  })

  it('write · resize 는 pty 로, kill 은 SIGHUP 뒤 2초에 SIGKILL', () => {
    const a = new Conn()
    core.open(a)
    core.handle(a, spawnReq(1))
    core.handle(a, { op: 'write', paneId: 'p1', data: 'ls\r' })
    core.handle(a, { op: 'resize', paneId: 'p1', cols: 100, rows: 30 })
    expect(ptys[0]!.written).toEqual(['ls\r'])
    expect(ptys[0]!.size).toEqual([100, 30])
    core.handle(a, { op: 'kill', paneId: 'p1' })
    expect(ptys[0]!.kills).toEqual(['SIGHUP'])
    advance(2000)
    expect(ptys[0]!.kills).toEqual(['SIGHUP', 'SIGKILL'])
  })

  it('붙은 채 끝나면 exit 를 보내고 세션을 지운다', () => {
    const a = new Conn()
    core.open(a)
    core.handle(a, spawnReq(1))
    core.handle(a, { op: 'kill', paneId: 'p1' })
    ptys[0]!.exit(0, 1)
    expect(a.frames.at(-1)).toEqual({ ev: 'exit', paneId: 'p1', exitCode: 0, signal: 1 })
    advance(2000)
    expect(ptys[0]!.kills).toEqual(['SIGHUP']) // 끝난 셸에 SIGKILL 을 보내지 않는다
    expect(core.liveCount).toBe(0)
  })

  it('손님 없는 셸을 kill 해 끝나면 기록을 남기지 않는다 (주인 없는 셸 끝내기)', () => {
    const a = new Conn()
    core.open(a)
    core.handle(a, spawnReq(1))
    core.close(a)
    const b = new Conn()
    core.open(b)
    core.handle(b, { op: 'kill', paneId: 'p1' })
    ptys[0]!.exit(0, 1)
    core.handle(b, { op: 'list', id: 2 })
    expect(b.reply(2)!['sessions']).toEqual([])
  })

  it('손님 없이 끝난 셸은 화면 · 이유를 남겼다가 attach 에 준다', async () => {
    const a = new Conn()
    core.open(a)
    core.handle(a, spawnReq(1))
    ptys[0]!.emit('last words\r\n')
    core.close(a)
    ptys[0]!.exit(3)
    expect(core.liveCount).toBe(0)
    const b = new Conn()
    core.open(b)
    core.handle(b, { op: 'list', id: 1 })
    expect((b.reply(1)!['sessions'] as Array<Record<string, unknown>>)[0]).toMatchObject({ paneId: 'p1', exited: { exitCode: 3, signal: null } })
    core.handle(b, { op: 'attach', id: 2, paneId: 'p1' })
    const r = await until(() => b.reply(2))
    expect(r).toMatchObject({ found: true, exited: { exitCode: 3, signal: null } })
    expect(r['screen']).toContain('last words')
    core.handle(b, { op: 'list', id: 3 })
    expect(b.reply(3)!['sessions']).toEqual([])
  })

  it('손님이 없던 동안의 입력 기다림(OSC 9 · 벨) · 실패(133;D) 를 list 가 주고, clearUnseen 이 지운다', async () => {
    const a = new Conn()
    core.open(a)
    core.handle(a, spawnReq(1))
    ptys[0]!.emit('\x07') // 붙어 있을 때의 벨은 손님이 봤다
    await core.settled()
    core.close(a)
    ptys[0]!.emit('\x1b]6973;cmd;claude\x07\x1b]133;C\x07')
    ptys[0]!.emit('\x1b]9;확인해 주세요\x07')
    ptys[0]!.emit('\x1b]133;D;1\x07')
    await core.settled()
    const b = new Conn()
    core.open(b)
    core.handle(b, { op: 'list', id: 1, clearUnseen: true })
    const s = (b.reply(1)!['sessions'] as Array<Record<string, unknown>>)[0]!
    expect(s).toMatchObject({ paneId: 'p1', command: 'claude', running: false, unseen: { waiting: true, message: '확인해 주세요', failed: 1 }, attached: false })
    core.handle(b, { op: 'list', id: 2 })
    expect((b.reply(2)!['sessions'] as Array<Record<string, unknown>>)[0]!['unseen']).toEqual({ waiting: false })
  })

  it('손님이 없던 동안 성공(133;D;0)으로 끝난 명령은 실패로 남지 않는다', async () => {
    const a = new Conn()
    core.open(a)
    core.handle(a, spawnReq(1))
    core.close(a)
    ptys[0]!.emit('\x1b]133;C\x07\x1b]133;D;0\x07')
    await core.settled()
    core.handle(a, { op: 'list', id: 2 })
    expect((a.reply(2)!['sessions'] as Array<Record<string, unknown>>)[0]).toMatchObject({ running: false, unseen: { waiting: false } })
    expect((a.reply(2)!['sessions'] as Array<Record<string, unknown>>)[0]!['unseen']).not.toHaveProperty('failed')
  })

  it('붙어 있을 때 온 벨 · 알림은 unseen 에 남지 않는다', async () => {
    const a = new Conn()
    core.open(a)
    core.handle(a, spawnReq(1))
    ptys[0]!.emit('\x07\x1b]9;hi\x07\x1b]133;D;2\x07')
    await core.settled()
    core.handle(a, { op: 'list', id: 2 })
    expect((a.reply(2)!['sessions'] as Array<Record<string, unknown>>)[0]!['unseen']).toEqual({ waiting: false })
  })

  it('attach 의 replay 는 마지막 명령 글자와 실행 중 표시', async () => {
    const a = new Conn()
    core.open(a)
    core.handle(a, spawnReq(1))
    ptys[0]!.emit('\x1b]6973;cmd;sleep 600\x07\x1b]133;C\x07')
    core.close(a)
    const b = new Conn()
    core.open(b)
    core.handle(b, { op: 'attach', id: 1, paneId: 'p1' })
    const r = await until(() => b.reply(1))
    expect(r['replay']).toBe('\x1b]6973;cmd;sleep 600\x07\x1b]133;C\x07')
  })

  it('tail 은 마지막 줄들을 글자로', async () => {
    const a = new Conn()
    core.open(a)
    core.handle(a, spawnReq(1))
    ptys[0]!.emit('one\r\ntwo\r\nthree\r\n')
    await core.settled()
    core.handle(a, { op: 'tail', id: 2, paneId: 'p1', lines: 2 })
    expect(await until(() => a.reply(2))).toMatchObject({ ok: true, text: 'two\nthree' })
  })

  it('stats 는 버전 · 메모리 · 살아 있는 셸 수', () => {
    const a = new Conn()
    core.open(a)
    core.handle(a, spawnReq(1))
    core.handle(a, spawnReq(2, 'p2'))
    core.handle(a, { op: 'stats', id: 3 })
    expect(a.reply(3)).toMatchObject({ ok: true, version: 1, pid: 4242, rss: 50 * 1024 * 1024, sessions: 2 })
  })

  it('shutdown 은 모든 셸에 SIGHUP, 다 끝나면 onShutdown — 안 끝나면 2초 뒤 SIGKILL 하고 끝낸다', () => {
    const a = new Conn()
    core.open(a)
    core.handle(a, spawnReq(1))
    core.handle(a, spawnReq(2, 'p2'))
    core.handle(a, { op: 'shutdown', id: 9 })
    expect(a.reply(9)).toMatchObject({ ok: true })
    expect(ptys.map((p) => p.kills)).toEqual([['SIGHUP'], ['SIGHUP']])
    ptys[0]!.exit(0, 1)
    expect(shutdowns).toBe(0)
    advance(2000)
    expect(ptys[1]!.kills).toEqual(['SIGHUP', 'SIGKILL'])
    expect(shutdowns).toBe(1)
  })

  it('셸이 없으면 shutdown 이 바로 끝낸다', () => {
    const a = new Conn()
    core.open(a)
    core.handle(a, { op: 'shutdown', id: 1 })
    expect(shutdowns).toBe(1)
  })

  it('spawn 이 실패하면 ok:false 와 이유', () => {
    const bad = new HostCore({
      spawnPty: () => {
        throw new Error('posix_spawnp failed.')
      },
      now: () => 0,
      schedule: () => () => {},
      version: 1,
      pid: 1,
      rss: () => 0,
      onShutdown: () => {},
    })
    const a = new Conn()
    bad.open(a)
    bad.handle(a, spawnReq(1))
    expect(a.reply(1)).toEqual({ id: 1, ok: false, error: 'posix_spawnp failed.' })
    expect(bad.liveCount).toBe(0)
  })

  it('붙은 손님이 있을 때 셸이 끝나도, 기다리던 attach · tail 은 화면을 받는다 (닫힌 headless 를 읽지 않는다)', async () => {
    const a = new Conn()
    core.open(a)
    core.handle(a, spawnReq(1))
    ptys[0]!.emit('before exit\r\n')
    const b = new Conn()
    core.open(b)
    core.handle(b, { op: 'attach', id: 2, paneId: 'p1' })
    core.handle(b, { op: 'tail', id: 3, paneId: 'p1', lines: 5 })
    ptys[0]!.exit(1) // a 가 붙어 있어 바로 세션을 지운다 — b 의 콜백은 아직
    const r = await until(() => b.reply(2))
    expect(r).toMatchObject({ ok: true, found: true, exited: { exitCode: 1, signal: null } })
    expect(r['screen']).toContain('before exit')
    expect(await until(() => b.reply(3))).toMatchObject({ ok: true, text: 'before exit' })
  })

  it('끝난 셸의 기록이 남아 있으면 유휴로 세지 않는다 (sessionCount)', () => {
    const a = new Conn()
    core.open(a)
    core.handle(a, spawnReq(1))
    core.close(a)
    ptys[0]!.exit(2)
    expect(core.liveCount).toBe(0)
    expect(core.sessionCount).toBe(1)
  })

  it('손님 수 · 살아 있는 셸 수로 유휴를 안다', () => {
    const a = new Conn()
    core.open(a)
    expect(core.clientCount).toBe(1)
    core.close(a)
    expect(core.clientCount).toBe(0)
    expect(core.liveCount).toBe(0)
  })
})
