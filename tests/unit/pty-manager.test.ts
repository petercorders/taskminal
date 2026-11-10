import { describe, expect, it } from 'vitest'
import type { WebContents } from 'electron'
import { IPC } from '../../src/shared/ipc'
import type { HostRequest } from '../../src/shared/ptyhost'
import type { HostClient } from '../../src/main/ptyhost/client'
import { PtyManager } from '../../src/main/pty-manager'

// main 쪽 pane ↔ 창 연결 — 가짜 지킴이 손님 · 가짜 창. 실제 지킴이 · 창은 e2e(persist.spec)가 본다.

class FakeHost {
  connected = true
  sent: HostRequest[] = []
  requests: Array<{ req: HostRequest; resolve(v: Record<string, unknown>): void }> = []
  request(req: HostRequest): Promise<Record<string, unknown>> {
    if (!this.connected) return Promise.reject(new Error('셸 지킴이에 연결되어 있지 않음'))
    return new Promise((resolve) => this.requests.push({ req, resolve }))
  }
  send(req: HostRequest): boolean {
    this.sent.push(req)
    return this.connected
  }
}

class FakeWin {
  destroyed = false
  out: Array<[string, ...unknown[]]> = []
  isDestroyed() {
    return this.destroyed
  }
  send(channel: string, ...args: unknown[]) {
    this.out.push([channel, ...args])
  }
  data(paneId: string) {
    return this.out.filter(([c, id]) => c === IPC.ptyData && id === paneId).map(([, , d]) => d as string).join('')
  }
}

const setup = () => {
  const host = new FakeHost()
  const ptys = new PtyManager(host as unknown as HostClient)
  const win = new FakeWin()
  return { host, ptys, win, wc: win as unknown as WebContents }
}
const flushed = () => new Promise((r) => setTimeout(r, 40)) // 출력 묶음(OutputBatcher) 이 나가기를

describe('PtyManager', () => {
  it('attach 답과 같은 덩어리로 온 출력은 버리지 않고 화면 다음에 붙인다', async () => {
    const { host, ptys, win, wc } = setup()
    const p = ptys.attach(wc, 'p1')
    // 지킴이는 답 → 그 사이 모은 출력 순서로 보낸다. 손님은 한 덩어리를 한 번에 처리해 await 뒤보다 먼저 onHostData 가 돈다.
    host.requests[0]!.resolve({ ok: true, found: true, pid: 7, screen: 'SCREEN', replay: '' })
    ptys.onHostData('p1', '-late')
    await expect(p).resolves.toEqual({ attached: true, detachedMs: 0 })
    await flushed()
    expect(win.data('p1')).toBe('\x1bcSCREEN-late')
  })

  it('attach 를 기다리는 사이 온 exit 도 화면 뒤에 창으로 보낸다', async () => {
    const { host, ptys, win, wc } = setup()
    const p = ptys.attach(wc, 'p1')
    host.requests[0]!.resolve({ ok: true, found: true, pid: 7, screen: 'S', replay: '' })
    ptys.onHostExit('p1', { exitCode: 1, signal: null })
    await p
    expect(win.out.filter(([c]) => c === IPC.ptyExit)).toEqual([[IPC.ptyExit, 'p1', { exitCode: 1, signal: null }]])
  })

  it('spawn 답과 같이 온 첫 출력(프롬프트)을 버리지 않는다', async () => {
    const { host, ptys, win, wc } = setup()
    const p = ptys.spawn(wc, 'p1', { cwd: '/tmp', cols: 80, rows: 24 })
    host.requests[0]!.resolve({ ok: true, pid: 7, existing: false })
    ptys.onHostData('p1', 'prompt% ')
    await p
    await flushed()
    expect(win.data('p1')).toBe('prompt% ')
  })

  it('attach 를 기다리는 사이 창이 새로 고쳐지면 주인으로 잡지 않고 지킴이에서도 뗀다', async () => {
    const { host, ptys, win, wc } = setup()
    const p = ptys.attach(wc, 'p1')
    ptys.detachOwner(wc) // did-start-navigation
    host.requests[0]!.resolve({ ok: true, found: true, pid: 7, screen: 'S', replay: '' })
    await expect(p).rejects.toThrow()
    expect(host.sent).toContainEqual({ op: 'detach', paneId: 'p1' })
    ptys.write(wc, 'p1', 'x')
    expect(host.sent.some((r) => r.op === 'write')).toBe(false)
    await flushed()
    expect(win.data('p1')).toBe('')
  })

  it('spawn 을 기다리는 사이 창이 닫히면 지킴이에서 뗀다', async () => {
    const { host, ptys, win, wc } = setup()
    const p = ptys.spawn(wc, 'p1', { cwd: '/tmp', cols: 80, rows: 24 })
    win.destroyed = true
    host.requests[0]!.resolve({ ok: true, pid: 7, existing: false })
    await expect(p).rejects.toThrow()
    expect(host.sent).toContainEqual({ op: 'detach', paneId: 'p1' })
  })

  it('끊긴 동안 attach · spawn 이 오면 놓쳤다고 기억한다 (다시 붙으면 창을 다시 읽게) — 읽으면 지운다', async () => {
    const { host, ptys, wc } = setup()
    expect(ptys.takeMissed()).toBe(false)
    host.connected = false
    await expect(ptys.attach(wc, 'p1')).resolves.toEqual({ attached: false })
    expect(ptys.takeMissed()).toBe(true)
    expect(ptys.takeMissed()).toBe(false)
    await expect(ptys.spawn(wc, 'p1', { cwd: '/tmp', cols: 80, rows: 24 })).rejects.toThrow()
    expect(ptys.takeMissed()).toBe(true)
  })
})
