// 이 Mac 에 떠 있는 다른 Taskminal 셸 지킴이 찾기 (61단계) — 순수 로직.
// 지킴이는 `<실행 파일> …/host.js <소켓> <데이터 폴더>` 로 떠 있고 앱이 꺼져도 셸이 있는 동안 남는다.
// 앱은 자기 데이터 폴더의 지킴이만 쓰므로, 개발 · 시험 실행이나 옛 설치본이 남긴 지킴이는 여기서 프로세스 목록으로 찾는다.

import { formatDuration } from './activity'

/** `ps` 인자 — macOS · Linux 공통(`-A` 모든 프로세스 · `-ww` 줄 자르지 않음). 부르는 쪽이 LC_ALL=C 를 준다(시작 시각 글자가 고정된다). */
export const HOST_PS_ARGS: readonly string[] = ['-A', '-ww', '-o', 'pid=,ppid=,uid=,lstart=,command=']
/** 한 번에 보여 주는 지킴이 수 */
export const OTHER_HOSTS_MAX = 50

export interface HostProcess {
  pid: number
  /** `ps` 의 시작 시각 글자 그대로 — 같은 프로세스인지 견줄 때 쓴다(pid 는 다시 쓰인다) */
  startedAt: string
  /** 시작 시각(ms) — 글자를 읽지 못하면 null */
  startedMs: number | null
  sockPath: string
  userData: string
  /** 소켓 이름의 프로토콜 번호 */
  version: number
  /** 이 지킴이가 띄운 프로세스 수(셸) — 지킴이가 답하지 않을 때 보여 줄 값 */
  children: number
}

/** 화면에 보이는 다른 지킴이 하나 */
export interface OtherHost extends HostProcess {
  /** ok: 지킴이가 답했다 · silent: 소켓이 답하지 않는다(내용을 모른다) */
  state: 'ok' | 'silent'
  /** 살아 있는 셸 수 (ok 일 때) */
  shells?: number
  /** 지금 실행 중인 명령들 — 가려서 (ok 일 때) */
  commands?: string[]
  /** 다른 앱이 이 지킴이에 붙어 있다 — 쓰는 중이라 여기서 끝내지 않는다 */
  attached?: boolean
}

/** 끝내라고 고른 대상 — main 이 이 셋으로 다시 찾는다 */
export interface OtherHostTarget {
  pid: number
  startedAt: string
  sockPath: string
}

export type EndOtherHostResult = { ok: true } | { ok: false; reason: 'gone' | 'changed' | 'attached' | 'silent' }

export function isOtherHostTarget(v: unknown): v is OtherHostTarget {
  if (typeof v !== 'object' || v === null) return false
  const t = v as Record<string, unknown>
  return (
    Number.isInteger(t['pid']) &&
    (t['pid'] as number) > 0 &&
    typeof t['startedAt'] === 'string' &&
    t['startedAt'].length > 0 &&
    t['startedAt'].length <= 40 &&
    typeof t['sockPath'] === 'string' &&
    t['sockPath'].length > 0 &&
    t['sockPath'].length <= 4096 &&
    !t['sockPath'].includes('\0')
  )
}

const ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4})\s+(\S.*)$/
const HOST_ARGS = /\/host\.js (.+)$/
/** `<데이터 폴더>/ptyhost-v<n>.sock <데이터 폴더>` */
const INSIDE = /^(.+)\/ptyhost-v(\d{1,4})\.sock (.+)$/
/** `<임시 폴더>/taskminal-<데이터 폴더 해시 12자>-v<n>.sock <데이터 폴더>` — 데이터 폴더 경로가 길 때 */
const HASHED = /^(.+\/taskminal-([0-9a-f]{12})-v(\d{1,4})\.sock) (.+)$/

function startedMs(lstart: string): number | null {
  // 'Wed Nov 11 10:25:52 2026' → 'Nov 11 2026 10:25:52' (그 Mac 의 시각대)
  const m = /^\w{3} (\w{3}) ([ \d]\d) (\d\d:\d\d:\d\d) (\d{4})$/.exec(lstart)
  if (!m) return null
  const ms = Date.parse(`${m[1]} ${m[2]!.trim()} ${m[4]} ${m[3]}`)
  return Number.isFinite(ms) ? ms : null
}

/** 명령줄의 `host.js` 뒤 글자에서 소켓 · 데이터 폴더. 지킴이 꼴이 아니면 null (데이터 폴더에 공백이 있어도 읽는다) */
function hostArgs(rest: string, hash: (s: string) => string): { sockPath: string; userData: string; version: number } | null {
  const a = INSIDE.exec(rest)
  if (a && a[1] === a[3]!.replace(/\/+$/, '')) return { sockPath: `${a[1]}/ptyhost-v${a[2]}.sock`, userData: a[3]!, version: Number(a[2]) }
  const b = HASHED.exec(rest)
  if (b && hash(b[4]!).slice(0, 12) === b[2]) return { sockPath: b[1]!, userData: b[4]!, version: Number(b[3]) }
  return null
}

/**
 * `ps` 출력에서 이 사용자의 Taskminal 셸 지킴이들. 다른 프로그램 · 다른 사용자 · 모양이 다른 줄은 버린다.
 * uid 가 null 이면(Windows) 사용자를 가리지 않는다. hash 는 `socketPath` 에 준 것과 같은 함수.
 */
export function parseHostProcesses(out: string, uid: number | null, hash: (s: string) => string): HostProcess[] {
  const rows: Array<{ pid: number; ppid: number; uid: number; lstart: string; command: string }> = []
  for (const line of out.split('\n')) {
    const m = ROW.exec(line)
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), uid: Number(m[3]), lstart: m[4]!, command: m[5]! })
  }
  const hosts: HostProcess[] = []
  for (const r of rows) {
    if (uid !== null && r.uid !== uid) continue
    const rest = HOST_ARGS.exec(r.command)
    const args = rest && hostArgs(rest[1]!, hash)
    if (!args) continue
    hosts.push({ pid: r.pid, startedAt: r.lstart, startedMs: startedMs(r.lstart), ...args, children: rows.filter((x) => x.ppid === r.pid).length })
  }
  return hosts
}

/** 다시 훑은 목록에서 고른 대상 — 같은 pid 가 같은 시작 시각 · 같은 소켓으로 그대로 있을 때만 */
export function findTarget(hosts: readonly HostProcess[], target: OtherHostTarget): HostProcess | 'gone' | 'changed' {
  const now = hosts.find((h) => h.pid === target.pid)
  if (!now) return 'gone'
  return now.startedAt === target.startedAt && now.sockPath === target.sockPath ? now : 'changed'
}

const DAY = 24 * 60 * 60 * 1000

export interface OtherHostLine {
  /** 데이터 폴더 — 집 폴더는 ~ 로 */
  folder: string
  /** '3일째 · 셸 2개' */
  summary: string
  /** 실행 중인 명령 · 응답 없음 · 붙은 앱 안내 */
  detail: string
  /** 여기서 끝낼 수 있나 */
  canEnd: boolean
}

/** 설정 › 셸 지킴이의 '이 Mac 의 다른 지킴이' 한 줄에 보일 글 */
export function otherHostLine(h: OtherHost, now: number, home: string): OtherHostLine {
  const base = home.replace(/\/+$/, '')
  const folder = base && (h.userData === base || h.userData.startsWith(base + '/')) ? '~' + h.userData.slice(base.length) : h.userData
  const ms = h.startedMs !== null ? now - h.startedMs : -1
  // 며칠씩 남는 것이 문제라 이틀부터는 날 수로
  const age = ms < 0 ? '시작 시각 모름' : ms >= 2 * DAY ? `${Math.floor(ms / DAY)}일째` : `${formatDuration(ms)}째`
  if (h.state === 'silent') {
    return { folder, summary: `${age} · 프로세스 ${h.children}개`, detail: `응답이 없어 여기서 끝내지 않아요 (프로세스 ${h.pid})`, canEnd: false }
  }
  const shells = h.shells ?? 0
  const running = h.commands ?? []
  const summary = `${age} · 셸 ${shells}개`
  if (h.attached) return { folder, summary, detail: '다른 Taskminal 이 쓰고 있어요 — 그 앱에서 끝내요', canEnd: false }
  return { folder, summary, detail: running.length > 0 ? `실행 중: ${running.join(' · ')}` : '실행 중인 명령 없음', canEnd: true }
}

/** 끝내기 확인에 보일 글 — 무엇이 끝나는지 */
export function endOtherHostText(h: OtherHost): string {
  const shells = h.shells ?? 0
  const running = h.commands ?? []
  return `이 지킴이와 셸 ${shells}개가 끝나요${running.length > 0 ? ` — 실행 중인 명령 ${running.length}개도` : ''}. 되돌릴 수 없어요.`
}

/** 끝내라고 보낸 뒤 보일 글 — 다시 읽은 목록에 그 지킴이가 아직 있으면 알려 준다. settled: 셸이 끝날 시간(3초)이 지난 뒤의 읽기 */
export function endSentNote(sent: OtherHostTarget, list: readonly HostProcess[], settled: boolean): string {
  if (!list.some((h) => h.pid === sent.pid && h.startedAt === sent.startedAt)) return '지킴이와 셸을 끝냈어요.'
  return settled ? '끝내라고 보냈지만 아직 떠 있어요. 잠시 뒤 다시 읽어 보세요.' : '끝내는 중이에요…'
}

/** 끝내기가 안 됐을 때 보일 글 */
export function endOtherHostError(reason: 'gone' | 'changed' | 'attached' | 'silent'): string {
  switch (reason) {
    case 'gone':
      return '이미 끝난 지킴이예요.'
    case 'changed':
      return '그 사이 다른 프로세스로 바뀌었어요. 끝내지 않았어요.'
    case 'attached':
      return '그 사이 다른 Taskminal 이 붙었어요. 끝내지 않았어요.'
    case 'silent':
      return '지킴이가 답하지 않아요. 끝내지 않았어요.'
  }
}
