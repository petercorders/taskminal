// main 통합 시험 — 실제 ps · lsof · python 서버로 (20단계 포트 감지)
import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { killPort, probePorts } from '../../src/main/port-probe'

let server: ChildProcess | null = null
afterEach(() => {
  server?.kill('SIGKILL')
  server = null
})

async function startServer(port: number): Promise<ChildProcess> {
  const child = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { stdio: 'ignore' })
  for (let i = 0; i < 50; i++) {
    const r = await probePorts({ me: process.pid })
    if (r.ok && r.ports['me']?.some((p) => p.port === port)) return child
    await new Promise((res) => setTimeout(res, 100))
  }
  throw new Error('서버가 뜨지 않음')
}

describe('probePorts · killPort', () => {
  it('셸(여기서는 시험 프로세스)의 자식이 듣는 포트를 찾고, 다른 pid 의 pane 에는 넣지 않는다', async () => {
    const port = 18000 + Math.floor(Math.random() * 1000)
    server = await startServer(port)
    const sibling = spawn('sleep', ['30'], { stdio: 'ignore' })
    const r = await probePorts({ me: process.pid, other: sibling.pid! })
    sibling.kill('SIGKILL')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.ports['me']).toContainEqual({ port, pid: server.pid, proc: expect.stringMatching(/python/i) })
    expect(r.ports['other']).toEqual([])
  })

  it('끄기는 다시 조사해 같은 pid 일 때만 SIGTERM — 셸 자신 · 바뀐 pid 는 끄지 않는다', async () => {
    const port = 19000 + Math.floor(Math.random() * 1000)
    server = await startServer(port)
    const pid = server.pid!
    // 살아 있지만 그 포트를 듣지 않는 pid(형제 sleep) — 끄지 않고 'gone', sleep 은 살아 있다
    const sibling = spawn('sleep', ['30'], { stdio: 'ignore' })
    try {
      expect(await killPort(process.pid, port, sibling.pid!)).toBe('gone')
      expect(sibling.exitCode).toBeNull()
      expect(sibling.signalCode).toBeNull()
    } finally {
      sibling.kill('SIGKILL')
    }
    expect(await killPort(process.pid, port, process.pid)).toBe('failed')
    const exited = new Promise<NodeJS.Signals | null>((res) => server!.once('exit', (_c, sig) => res(sig)))
    expect(await killPort(process.pid, port, pid)).toBe('killed')
    expect(await exited).toBe('SIGTERM')
    expect(await killPort(process.pid, port, pid)).toBe('gone')
  })

  it('조사할 pane 이 없으면 명령을 부르지 않고 빈 결과', async () => {
    expect(await probePorts({})).toEqual({ ok: true, ports: {} })
    expect(await probePorts({ x: -1 })).toEqual({ ok: true, ports: {} })
  })
})
