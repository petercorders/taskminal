import { execFile } from 'node:child_process'
import { listenerPids, parseLsofListen, parsePsTree, portsByPane, type PortInfo, type ProbeResult } from '../shared/ports'

const PS = '/bin/ps'
const LSOF = '/usr/sbin/lsof'
const TIMEOUT_MS = 2000

function run(file: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      const out = typeof stdout === 'string' ? stdout : ''
      // lsof 는 찾은 것이 없거나 · 없는 pid 가 섞이면 1 로 끝난다 — 출력이 있으면 쓴다. 시간 초과 · 실행 실패는 실패
      const failed = error !== null && ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as { killed?: boolean }).killed === true)
      resolve({ ok: !failed, out })
    })
  })
}

/**
 * pane 셸 pid 마다 그 자손이 듣는 TCP 포트 (20단계). ps 한 번 + lsof 한 번(셸 자손 pid 로 좁힘, 자손이 없으면 안 부름) — pane 수와 상관없다.
 * 실패(시간 초과 · 명령 없음)면 { ok: false } — renderer 가 '포트 확인 못 함' 을 한 번 보이고 다음 주기에 다시.
 */
export async function probePorts(shellPids: Readonly<Record<string, number>>): Promise<ProbeResult> {
  const valid = Object.fromEntries(Object.entries(shellPids).filter(([, pid]) => Number.isInteger(pid) && pid > 0))
  if (Object.keys(valid).length === 0) return { ok: true, ports: {} }
  const ps = await run(PS, ['-A', '-o', 'pid=,ppid='])
  if (!ps.ok || !ps.out) return { ok: false }
  const tree = parsePsTree(ps.out)
  const pids = listenerPids(valid, tree)
  const listens = pids.length === 0 ? [] : await listening(pids)
  if (!listens) return { ok: false }
  return { ok: true, ports: portsByPane(valid, tree, listens) }
}

/** 셸 자손 pid 만 본다(-a -p) — 시스템 전체의 열린 파일을 매 주기 훑지 않게 */
async function listening(pids: readonly number[]): Promise<PortInfo[] | null> {
  const r = await run(LSOF, ['-nP', '-a', '-p', pids.join(','), '-iTCP', '-sTCP:LISTEN', '-Fpcn'])
  return r.ok ? parseLsofListen(r.out) : null
}

/**
 * 포트 끄기 — 끄기 직전에 다시 조사해 그 pid 가 지금도 그 pane 셸의 자손이고 그 포트를 들을 때만 SIGTERM.
 * (확인 창이 열린 사이 서버가 꺼지고 pid 가 다른 프로세스에 다시 쓰였을 수 있다) 셸 자신은 끄지 않는다.
 */
export async function killPort(shellPid: number, port: number, pid: number): Promise<'killed' | 'gone' | 'failed'> {
  if (pid === shellPid) return 'failed'
  const r = await probePorts({ pane: shellPid })
  if (!r.ok) return 'failed'
  const now = r.ports['pane']?.find((p) => p.port === port)
  if (!now || now.pid !== pid) return 'gone'
  try {
    process.kill(pid, 'SIGTERM')
    return 'killed'
  } catch {
    return 'gone'
  }
}
