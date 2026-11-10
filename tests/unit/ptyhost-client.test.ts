import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:net'
import { mkdtempSync, rmdirSync, unlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostClient, type HostStatus } from '../../src/main/ptyhost/client'

// 지킴이 손님의 다시 붙기 — 실제 유닉스 소켓, 지킴이 대신 받자마자 끊는 서버.

let server: Server | null = null
let dir = ''
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
  server = null
  const sock = join(dir, 's.sock')
  if (existsSync(sock)) unlinkSync(sock)
  if (dir) rmdirSync(dir)
})

describe('HostClient', () => {
  it('hello 전에 연결이 끊기면 다시 붙기는 하나만 돈다 (다섯 번 뒤 down)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tm-client-'))
    const sockPath = join(dir, 's.sock')
    server = createServer((c) => c.destroy()) // 받자마자 닫음 — 막 유휴로 끝나는 지킴이
    await new Promise<void>((r) => server!.listen(sockPath, r))
    const statuses: HostStatus[] = []
    const client = new HostClient({
      sockPath,
      userData: dir,
      hostScript: '/없는/host.js',
      execPath: process.execPath,
      env: {},
      retryScale: 1, // 1·2·4·8·16 ms
      onData: () => {},
      onExit: () => {},
      onStatus: (s) => statuses.push(s),
      onReconnected: () => {},
      onHostLost: () => {},
    })
    await client.start()
    for (let i = 0; i < 200 && !statuses.some((s) => s.state === 'down'); i++) await new Promise((r) => setTimeout(r, 10))
    await new Promise((r) => setTimeout(r, 100)) // 둘째 고리가 있다면 더 쌓일 시간
    client.dispose()
    const reconnecting = statuses.filter((s) => s.state === 'reconnecting').map((s) => (s as { attempt: number }).attempt)
    expect(reconnecting).toEqual([1, 2, 3, 4, 5])
    expect(statuses.filter((s) => s.state === 'down')).toHaveLength(1)
  })
})
