// 포트 감지 (20단계) — pane 셸의 자손 프로세스가 듣는(LISTEN) TCP 포트. 순수 함수: ps · lsof 출력 해석 · 칩 합치기 · 겹침 · 조사 주기.
// 출력 글자("Local: http://…")가 아니라 OS 에 묻는다. main 이 ps 한 번 + lsof 한 번으로 모든 pane 을 조사한다(스파이크: 각 10~30ms).

export interface PortInfo {
  port: number
  pid: number
  /** lsof 의 프로세스 이름 (node · Python · java …) */
  proc: string
}

export interface PortChip extends PortInfo {
  paneId: string
  /** 처음 잡힌 시각 — '3분째' */
  since: number
  /** 사라진 시각 — CLOSED_MS 동안 회색 취소선으로 남는다 */
  closedAt?: number
}

export type ProbeResult = { ok: true; ports: Record<string, PortInfo[]> } | { ok: false }

/** 닫힌 칩이 남는 시간 */
export const CLOSED_MS = 10_000
/** 이 아래 포트(시스템 · sshd)는 보이지 않는다 */
export const PORT_MIN = 1024
/** 사이드바 일감 줄에 보이는 칩 수 (나머지는 +n) */
export const SIDEBAR_CHIPS = 2

/** `ps -A -o pid=,ppid=` → 부모 pid → 자식 pid 목록 */
export function parsePsTree(out: string): Map<number, number[]> {
  const tree = new Map<number, number[]>()
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (!m) continue
    const pid = Number(m[1])
    const ppid = Number(m[2])
    const list = tree.get(ppid)
    if (list) list.push(pid)
    else tree.set(ppid, [pid])
  }
  return tree
}

/** root 와 그 자손(손자까지) — 고리가 있어도 끝난다 */
export function descendants(tree: ReadonlyMap<number, readonly number[]>, root: number): number[] {
  const seen = new Set<number>([root])
  const queue = [root]
  while (queue.length > 0) {
    for (const child of tree.get(queue.shift()!) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      queue.push(child)
    }
  }
  return [...seen]
}

/** `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` → pid · 이름 · 포트. 같은 pid 의 같은 포트(IPv4 · IPv6)는 한 번, PORT_MIN 미만 제외 */
export function parseLsofListen(out: string): PortInfo[] {
  const found: PortInfo[] = []
  const seen = new Set<string>()
  let pid = 0
  let proc = ''
  for (const line of out.split('\n')) {
    const tag = line[0]
    const value = line.slice(1)
    if (tag === 'p') {
      pid = Number(value)
      proc = ''
    } else if (tag === 'c') proc = value
    else if (tag === 'n' && pid > 0) {
      const m = /:(\d+)$/.exec(value)
      if (!m) continue
      const port = Number(m[1])
      const key = `${pid}:${port}`
      if (port < PORT_MIN || port > 65535 || seen.has(key)) continue
      seen.add(key)
      found.push({ pid, proc, port })
    }
  }
  return found
}

/** lsof 를 좁힐 pid — 셸 자신을 뺀 자손들. 비었으면 lsof 를 부르지 않는다(셸 혼자는 포트를 듣지 않는다) */
export function listenerPids(shellPids: Readonly<Record<string, number>>, tree: ReadonlyMap<number, readonly number[]>): number[] {
  const roots = new Set(Object.values(shellPids))
  const out = new Set<number>()
  for (const root of roots) for (const pid of descendants(tree, root)) if (!roots.has(pid)) out.add(pid)
  return [...out]
}

/**
 * 셸 pid 마다 그 자손이 듣는 포트 (포트 순, 같은 포트는 한 번).
 * 같은 포트를 여럿이 들으면(gunicorn · node cluster 의 주인과 일꾼) 다른 듣는 pid 의 자식이 아닌 것(주인)을 칩 pid 로 — 끄기가 일꾼만 끄지 않게.
 */
export function portsByPane(shellPids: Readonly<Record<string, number>>, tree: ReadonlyMap<number, readonly number[]>, listens: readonly PortInfo[]): Record<string, PortInfo[]> {
  const out: Record<string, PortInfo[]> = {}
  for (const [paneId, shellPid] of Object.entries(shellPids)) {
    const mine = new Set(descendants(tree, shellPid))
    const byPort = new Map<number, PortInfo[]>()
    for (const l of listens) if (mine.has(l.pid)) byPort.set(l.port, [...(byPort.get(l.port) ?? []), l])
    const ports: PortInfo[] = []
    for (const group of byPort.values()) {
      const owner = group.find((l) => !group.some((o) => o.pid !== l.pid && (tree.get(o.pid) ?? []).includes(l.pid)))
      ports.push(owner ?? group[0]!)
    }
    out[paneId] = ports.sort((a, b) => a.port - b.port)
  }
  return out
}

/**
 * 조사 결과를 칩에 합친다.
 * - probed 안의 pane: 찾은 포트는 열림(같은 포트면 since 를 잇고 닫힘을 푼다), 없어진 포트는 닫힘으로.
 * - 그 밖의 pane: 그대로(조사하지 않았다). live 밖의 pane 은 지운다. 닫힌 지 CLOSED_MS 지난 칩은 지운다.
 * opened = 이번에 새로 뜬 칩(처음 알림 · 겹침 알림).
 */
export function mergePorts(
  prev: Readonly<Record<string, readonly PortChip[]>>,
  found: Readonly<Record<string, readonly PortInfo[]>>,
  probed: readonly string[],
  live: ReadonlySet<string>,
  now: number,
): { next: Record<string, PortChip[]>; opened: PortChip[] } {
  const next: Record<string, PortChip[]> = {}
  const opened: PortChip[] = []
  const probedSet = new Set(probed)
  for (const paneId of new Set([...Object.keys(prev), ...probed])) {
    if (!live.has(paneId)) continue
    const old = prev[paneId] ?? []
    let chips: PortChip[]
    if (probedSet.has(paneId)) {
      const now_ = found[paneId] ?? []
      const ports = new Set(now_.map((p) => p.port))
      chips = now_.map((p) => {
        const was = old.find((c) => c.port === p.port)
        if (was && was.closedAt === undefined) return { ...was, pid: p.pid, proc: p.proc }
        const chip: PortChip = { ...p, paneId, since: now }
        opened.push(chip)
        return chip
      })
      for (const c of old) if (!ports.has(c.port)) chips.push(c.closedAt === undefined ? { ...c, closedAt: now } : c)
    } else chips = [...old]
    chips = chips.filter((c) => c.closedAt === undefined || now - c.closedAt < CLOSED_MS).sort((a, b) => a.port - b.port)
    if (chips.length > 0) next[paneId] = chips
  }
  return { next, opened }
}

/**
 * 새로 뜬 포트가 아래 번호를 다른 일감이 써서 밀린 것인가 — 바로 아래부터 연속으로 다른 pane 이 듣는 동안 내려가,
 * 맨 아래 주인이 다른 일감이면 겹침. (vite · next 처럼 '쓰는 중이면 +1' 하는 서버)
 */
export function portConflict(
  chip: PortChip,
  all: Readonly<Record<string, readonly PortChip[]>>,
  taskOf: (paneId: string) => string | null,
): { port: number; wanted: number; ownerPaneId: string } | null {
  const owner = new Map<number, string>()
  for (const [paneId, chips] of Object.entries(all)) {
    if (paneId === chip.paneId) continue
    for (const c of chips) if (c.closedAt === undefined) owner.set(c.port, paneId)
  }
  let q = chip.port - 1
  while (owner.has(q)) q--
  const wanted = q + 1
  if (wanted === chip.port) return null
  const ownerPaneId = owner.get(wanted)!
  const mine = taskOf(chip.paneId)
  const theirs = taskOf(ownerPaneId)
  if (theirs === null || theirs === mine) return null
  return { port: chip.port, wanted, ownerPaneId }
}

export function chipSummary<T>(chips: readonly T[], max: number): { shown: T[]; rest: T[] } {
  return { shown: chips.slice(0, max), rest: chips.slice(max) }
}

/**
 * 조사 주기의 한 번에 하나 · 옛 응답 버림.
 * - tick: 앞 조사가 안 끝났으면 건너뛴다(false) — 느린 lsof 가 쌓이지 않게.
 * - invalidate: 끄기 · 숨기기 · pane 닫힘 뒤 — 이미 떠난 조사의 응답을 버린다(세대).
 * - afterCurrent: 그 뒤 다시 묻기 — 조사 중이면 끝난 뒤에.
 */
export function createPortPoller(probe: (paneIds: string[]) => Promise<ProbeResult>, onResult: (r: ProbeResult, paneIds: string[]) => void) {
  let inFlight = false
  let generation = 0
  let after: (() => void) | null = null
  return {
    tick(paneIds: string[]): boolean {
      if (inFlight) return false
      inFlight = true
      const mine = generation
      const done = (r: ProbeResult) => {
        inFlight = false
        if (mine === generation) onResult(r, paneIds)
        const next = after
        after = null
        next?.()
      }
      probe(paneIds).then(done, () => done({ ok: false }))
      return true
    },
    invalidate(): void {
      generation++
    },
    /** 조사 중이 아니면 바로, 조사 중이면 그 조사가 끝난 뒤 한 번(여러 번 불러도 마지막 하나) — 끄기 뒤 다시 묻기가 건너뛰어지지 않게 */
    afterCurrent(fn: () => void): void {
      if (inFlight) after = fn
      else fn()
    },
    get busy(): boolean {
      return inFlight
    },
  }
}
