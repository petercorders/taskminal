// 이 Mac 의 다른 셸 지킴이를 찾고(프로세스 목록 + 소켓에 물어보기) 고른 것을 끝낸다 (61단계).
// ps · 소켓은 주입한다 — 시험은 가짜를 넣는다. 신호(SIGTERM)는 보내지 않는다: 답하는 지킴이에게 shutdown 만 보낸다.

import type { HostRequest, SessionInfo } from '../shared/ptyhost'
import { findTarget, OTHER_HOSTS_MAX, parseHostProcesses, type EndOtherHostResult, type HostProcess, type OtherHost, type OtherHostTarget } from '../shared/host-scan'

export interface HostScanDeps {
  /** `ps` 출력(HOST_PS_ARGS · LC_ALL=C). 실패하면 던진다 */
  ps(): Promise<string>
  /** 그 소켓에 요청들을 보내고 답들을 받는다. 연결 · 답이 없으면 null (client.ts 의 oneShot) */
  ask(sockPath: string, reqs: HostRequest[]): Promise<Array<Record<string, unknown>> | null>
  /** 지금 앱의 지킴이 소켓 — 목록에서 빼고, 끝내지도 않는다 */
  selfSock: string
  uid: number | null
  hash(s: string): string
  /** 화면에 보일 명령 글자를 가린다 */
  mask(text: string): string
  protocol: number
}

const COMMANDS_MAX = 5
const COMMAND_CHARS = 80

/** 지킴이에게 물어 셸 수 · 실행 중인 명령 · 붙은 연결을 채운다. 답이 없으면 silent */
async function inspect(d: HostScanDeps, h: HostProcess): Promise<OtherHost> {
  const r = await d.ask(h.sockPath, [{ op: 'hello', version: d.protocol }, { op: 'list' }, { op: 'stats' }])
  const sessions = r?.[1]?.['sessions']
  if (!r || !Array.isArray(sessions)) return { ...h, state: 'silent' }
  const live = (sessions as SessionInfo[]).filter((s) => s && typeof s === 'object' && !s.exited)
  // 새 지킴이는 연결 수를 알려 준다(묻는 이 연결 하나를 뺀다). 옛 지킴이는 셸에 붙은 손님이 있는지로 대신한다
  const clients = r[2]?.['clients']
  const attached = typeof clients === 'number' ? clients > 1 : live.some((s) => s.attached === true)
  const commands = live
    .filter((s) => s.running === true && typeof s.command === 'string' && s.command.trim() !== '')
    .slice(0, COMMANDS_MAX)
    .map((s) => d.mask(s.command!).slice(0, COMMAND_CHARS))
  return { ...h, state: 'ok', shells: live.length, commands, attached }
}

async function scan(d: HostScanDeps): Promise<HostProcess[]> {
  return parseHostProcesses(await d.ps(), d.uid, d.hash).filter((h) => h.sockPath !== d.selfSock)
}

/** 지금 앱의 것을 뺀, 이 Mac 에 떠 있는 지킴이들 — 오래된 것부터 */
export async function listOtherHosts(d: HostScanDeps): Promise<OtherHost[]> {
  const hosts = (await scan(d)).sort((a, b) => (a.startedMs ?? 0) - (b.startedMs ?? 0)).slice(0, OTHER_HOSTS_MAX)
  return Promise.all(hosts.map((h) => inspect(d, h)))
}

/**
 * 고른 지킴이를 셸까지 끝낸다. 확인을 누르는 사이 바뀌었을 수 있으니 다시 훑어 같은 프로세스일 때만,
 * 다시 물어 붙은 앱이 없을 때만 shutdown 을 보낸다. 그 밖에는 아무것도 보내지 않는다.
 */
export async function endOtherHost(d: HostScanDeps, target: OtherHostTarget): Promise<EndOtherHostResult> {
  const found = findTarget(await scan(d), target)
  if (found === 'gone' || found === 'changed') return { ok: false, reason: found }
  const now = await inspect(d, found)
  if (now.state === 'silent') return { ok: false, reason: 'silent' }
  if (now.attached) return { ok: false, reason: 'attached' }
  if (await d.ask(found.sockPath, [{ op: 'shutdown' }])) return { ok: true }
  // 셸이 없던 지킴이는 답을 쓰자마자 끝나 답이 안 올 수 있다 — 사라졌으면 끝난 것이다
  return findTarget(await scan(d), target) === 'gone' ? { ok: true } : { ok: false, reason: 'silent' }
}
