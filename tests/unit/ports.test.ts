import { describe, expect, it } from 'vitest'
import {
  CLOSED_MS,
  chipSummary,
  createPortPoller,
  descendants,
  mergePorts,
  parseLsofListen,
  parsePsTree,
  portConflict,
  portsByPane,
  type PortChip,
  type ProbeResult,
} from '../../src/shared/ports'

describe('ps 트리 · 자손', () => {
  const ps = ['    1     0', '  100     1', '  200   100', '  300   200', '  400   100', '  999     1', 'garbage', ''].join('\n')
  it('부모 → 자식 목록', () => {
    const tree = parsePsTree(ps)
    expect(tree.get(100)).toEqual([200, 400])
    expect(tree.get(200)).toEqual([300])
  })
  it('손자까지 · 자기 자신 포함 · 다른 가지 제외', () => {
    expect(descendants(parsePsTree(ps), 100).sort((a, b) => a - b)).toEqual([100, 200, 300, 400])
  })
  it('고리가 있어도 끝난다', () => {
    const tree = new Map([
      [1, [2]],
      [2, [1]],
    ])
    expect(descendants(tree, 1).sort()).toEqual([1, 2])
  })
})

describe('lsof LISTEN 해석', () => {
  const out = ['p300', 'cnode', 'f20', 'n[::1]:5173', 'f21', 'n127.0.0.1:5173', 'p400', 'cPython', 'f4', 'n*:8123', 'p500', 'csshd', 'f3', 'n*:22', ''].join('\n')
  it('pid · 이름 · 포트, 같은 pid 의 같은 포트는 한 번, 1024 미만 제외', () => {
    expect(parseLsofListen(out)).toEqual([
      { pid: 300, proc: 'node', port: 5173 },
      { pid: 400, proc: 'Python', port: 8123 },
    ])
  })
  it('빈 출력이면 빈 목록', () => {
    expect(parseLsofListen('')).toEqual([])
  })
})

describe('portsByPane', () => {
  it('셸 pid 의 자손이 듣는 포트를 그 pane 에 · 포트 순', () => {
    const tree = parsePsTree(['10 1', '11 10', '20 1', '21 20'].join('\n'))
    const listens = [
      { pid: 11, proc: 'node', port: 5174 },
      { pid: 10, proc: 'zsh', port: 5173 },
      { pid: 21, proc: 'java', port: 8080 },
      { pid: 77, proc: 'other', port: 9000 },
    ]
    expect(portsByPane({ a: 10, b: 20, c: 30 }, tree, listens)).toEqual({
      a: [
        { pid: 10, proc: 'zsh', port: 5173 },
        { pid: 11, proc: 'node', port: 5174 },
      ],
      b: [{ pid: 21, proc: 'java', port: 8080 }],
      c: [],
    })
  })
})

describe('mergePorts — 닫힘 10초 · 새 포트', () => {
  const chip = (p: Partial<PortChip>): PortChip => ({ paneId: 'a', port: 5173, pid: 1, proc: 'node', since: 0, ...p })
  it('새로 잡힌 포트는 opened 로 · 같은 포트는 since 를 잇는다', () => {
    const r1 = mergePorts({}, { a: [{ port: 5173, pid: 1, proc: 'node' }] }, ['a'], new Set(['a']), 1000)
    expect(r1.opened.map((c) => c.port)).toEqual([5173])
    const r2 = mergePorts(r1.next, { a: [{ port: 5173, pid: 1, proc: 'node' }] }, ['a'], new Set(['a']), 4000)
    expect(r2.opened).toEqual([])
    expect(r2.next['a']![0]!.since).toBe(1000)
  })
  it('조사한 pane 에서 사라진 포트는 닫힘으로 10초 남았다 지워진다', () => {
    const prev = { a: [chip({ since: 0 })] }
    const r = mergePorts(prev, { a: [] }, ['a'], new Set(['a']), 1000)
    expect(r.next['a']![0]!.closedAt).toBe(1000)
    expect(mergePorts(r.next, {}, [], new Set(['a']), 1000 + CLOSED_MS - 1).next['a']).toHaveLength(1)
    expect(mergePorts(r.next, {}, [], new Set(['a']), 1000 + CLOSED_MS).next['a'] ?? []).toHaveLength(0)
  })
  it('닫힌 포트가 다시 뜨면 닫힘이 풀리고 새로 뜬 것으로 센다', () => {
    const prev = { a: [chip({ closedAt: 500 })] }
    const r = mergePorts(prev, { a: [{ port: 5173, pid: 2, proc: 'node' }] }, ['a'], new Set(['a']), 1000)
    expect(r.next['a']![0]).toMatchObject({ pid: 2, since: 1000 })
    expect(r.next['a']![0]!.closedAt).toBeUndefined()
    expect(r.opened).toHaveLength(1)
  })
  it('조사하지 않은 pane 은 그대로 · 닫힌 pane(live 밖)은 지운다', () => {
    const prev = { a: [chip({})], b: [chip({ paneId: 'b', port: 8080 })] }
    const r = mergePorts(prev, {}, [], new Set(['a']), 1000)
    expect(r.next['a']).toEqual(prev.a)
    expect(r.next['b']).toBeUndefined()
  })
})

describe('portConflict — 아래 번호를 다른 일감이 써서 밀려 떴다', () => {
  const taskOf = (paneId: string) => ({ a: 'T1', b: 'T2', c: 'T2' })[paneId] ?? null
  const open = (paneId: string, port: number): PortChip => ({ paneId, port, pid: 1, proc: 'node', since: 0 })
  it('5173 을 다른 일감이 듣는데 5174 가 새로 뜨면 겹침', () => {
    const all = { a: [open('a', 5173)], b: [open('b', 5174)] }
    expect(portConflict(open('b', 5174), all, taskOf)).toEqual({ port: 5174, wanted: 5173, ownerPaneId: 'a' })
  })
  it('연속으로 밀렸으면 맨 아래 주인', () => {
    const all = { a: [open('a', 5173)], c: [open('c', 5174)], b: [open('b', 5175)] }
    expect(portConflict(open('b', 5175), all, taskOf)).toEqual({ port: 5175, wanted: 5173, ownerPaneId: 'a' })
  })
  it('아래 번호가 같은 일감 것이거나 · 비었거나 · 닫힘이면 아님', () => {
    expect(portConflict(open('b', 5174), { c: [open('c', 5173)], b: [open('b', 5174)] }, taskOf)).toBeNull()
    expect(portConflict(open('b', 5174), { b: [open('b', 5174)] }, taskOf)).toBeNull()
    expect(portConflict(open('b', 5174), { a: [{ ...open('a', 5173), closedAt: 1 }] }, taskOf)).toBeNull()
  })
})

describe('chipSummary', () => {
  it('앞 n개 + 나머지 수', () => {
    const c = (port: number): PortChip => ({ paneId: 'a', port, pid: 1, proc: 'x', since: 0 })
    expect(chipSummary([c(1), c(2), c(3), c(4)], 2)).toEqual({ shown: [c(1), c(2)], rest: [c(3), c(4)] })
  })
})

describe('createPortPoller — 한 번에 하나 · 옛 응답 버림', () => {
  const gate = () => {
    let open!: (r: ProbeResult) => void
    const p = new Promise<ProbeResult>((r) => (open = r))
    return { p, open }
  }
  it('앞 조사가 안 끝났으면 다음 tick 은 건너뛴다 (쌓이지 않음)', async () => {
    const g = gate()
    let calls = 0
    const results: ProbeResult[] = []
    const poller = createPortPoller(
      () => {
        calls++
        return g.p
      },
      (r) => results.push(r),
    )
    expect(poller.tick(['a'])).toBe(true)
    expect(poller.tick(['a'])).toBe(false)
    expect(calls).toBe(1)
    g.open({ ok: true, ports: { a: [] } })
    await g.p
    await Promise.resolve()
    expect(results).toHaveLength(1)
    expect(poller.tick(['a'])).toBe(true)
  })
  it('invalidate 뒤 도착한 옛 응답은 버린다', async () => {
    const g = gate()
    const results: ProbeResult[] = []
    const poller = createPortPoller(() => g.p, (r) => results.push(r))
    poller.tick(['a'])
    poller.invalidate()
    g.open({ ok: true, ports: { a: [{ port: 5173, pid: 1, proc: 'node' }] } })
    await g.p
    await Promise.resolve()
    expect(results).toEqual([])
    // 버린 뒤에도 다음 조사는 돈다
    expect(poller.tick(['a'])).toBe(true)
  })
  it('실패(예외)는 ok:false 로 알린다', async () => {
    const results: ProbeResult[] = []
    const poller = createPortPoller(() => Promise.reject(new Error('x')), (r) => results.push(r))
    poller.tick(['a'])
    await new Promise((r) => setTimeout(r, 0))
    expect(results).toEqual([{ ok: false }])
  })
})
