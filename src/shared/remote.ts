// SSH 원격 일감 (25단계) — 로컬 pty 에서 ssh 를 띄운다. 앱은 비밀번호 · 키를 갖지 않고, 사용자의 ssh 설정 · agent · known_hosts 를 그대로 쓴다.

/**
 * ~/.ssh/config 의 Host 이름 · user@host · IP · IPv6(괄호 없이). 옵션 주입(- 로 시작) · 셸 글자 · 공백은 거절.
 * host:port · [IPv6] 는 ssh 명령줄이 읽지 못한다(포트는 ~/.ssh/config 의 Port) — 콜론이 하나뿐이면 거절
 */
export function isSshHost(v: string): boolean {
  return v.length > 0 && v.length <= 255 && !v.startsWith('-') && /^[A-Za-z0-9._@:%-]+$/.test(v) && !/^[^:]*:[^:]*$/.test(v)
}
/** 원격 작업 폴더 — 줄바꿈 · NUL 만 거절(따옴표는 remoteCommand 가 처리) */
export function isRemotePath(v: string): boolean {
  return v.length > 0 && v.length <= 4096 && !/[\n\r\0]/.test(v)
}

/** pane 마다 하나의 서버 tmux 세션 — 끊김 · 앱 재시작 뒤 같은 이름으로 다시 붙는다 */
export function tmuxSession(paneId: string): string {
  return `tm-${paneId.replace(/[^A-Za-z0-9_-]/g, '')}`
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
/** ~ 는 원격 셸이 펼치도록 따옴표 밖에 */
function quotePath(p: string): string {
  if (p === '~') return '~'
  if (p.startsWith('~/')) return `~/${q(p.slice(2))}`
  return q(p)
}

/**
 * 원격에서 돌 명령 — POSIX sh 만 쓴다(Synology ash 등). tmux 가 있으면 같은 세션에, 없으면 로그인 셸.
 * ssh 는 이 글을 원격 사용자의 로그인 셸(fish · csh 일 수 있다)로 돌리므로 `/bin/sh -c '<명령>'` 으로 감싼다
 */
export function remoteCommand(cwd: string, paneId: string, tmux: boolean): string {
  const cd = `cd ${quotePath(cwd)} 2>/dev/null || echo "taskminal: 폴더가 없어 홈에서 열어요 — ${cwd.replace(/["$`\\]/g, '')}";`
  const t = tmux ? ` command -v tmux >/dev/null 2>&1 && exec tmux new-session -A -s ${tmuxSession(paneId)};` : ''
  return `exec /bin/sh -c ${q(`${cd}${t} exec "\${SHELL:-/bin/sh}" -l`)}`
}

/** macOS 유닉스 소켓 경로 한도(sun_path, NUL 포함) */
const SUN_PATH_MAX = 104
/** ControlPath 폴더가 한도에 드나 — ssh 가 `<폴더>/<%C 40자>` 에 마스터를 만들 때 `.<16자>` 임시 꼬리를 붙인다(넘치면 연결 뒤 255 로 끝남) */
export function controlPathFits(dir: string): boolean {
  return new TextEncoder().encode(dir).length + 1 + 40 + 17 + 1 <= SUN_PATH_MAX
}

/** 키 바뀜 띠의 '명령 복사' — known_hosts 는 실제 HostName(22 가 아니면 [host]:port)으로 적히므로 ssh -G 로 풀어서 지운다 */
export function keygenFixCommand(host: string): string {
  return `ssh-keygen -R "$(ssh -G ${q(host)} | awk '$1=="hostname"{h=$2} $1=="port"{p=$2} END{print (p==22 ? h : "[" h "]:" p)}')"`
}

export interface SshSpec {
  host: string
  cwd: string
  paneId: string
  tmux: boolean
  /** ControlPath 소켓 폴더(0700, controlPathFits) — null 이면 연결을 나누지 않는다 */
  controlDir: string | null
}
/** ssh 인자 — 호스트당 연결 하나(ControlMaster), 끊김은 ServerAlive 로 알아챈다. 호스트 앞 -- 로 옵션 주입을 막는다 */
export function sshArgs(s: SshSpec): string[] {
  return [
    '-t',
    ...(s.controlDir ? ['-o', 'ControlMaster=auto', '-o', `ControlPath=${s.controlDir}/%C`, '-o', 'ControlPersist=600'] : []),
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '--',
    s.host,
    remoteCommand(s.cwd, s.paneId, s.tmux),
  ]
}

/** ~/.ssh/config 의 Host 이름들 — 와일드카드(* ?) · 부정(!) 은 isSshHost 가 거르고 Match 는 줄째 뺀다, 처음 나온 순서로 한 번씩 */
export function parseSshConfigHosts(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim()
    const m = /^host\s+(.+)$/i.exec(line)
    if (!m) continue
    for (const name of m[1]!.split(/\s+/)) {
      if (!isSshHost(name) || out.includes(name)) continue
      out.push(name)
    }
  }
  return out
}

export type SshSignal = { kind: 'new-host'; fingerprint: string } | { kind: 'key-changed' } | { kind: 'auth' } | { kind: 'refused' }
/** pane 출력에서 ssh 의 알림을 알아본다 — 처음 보는 서버(지문) · 키 바뀜 · 인증 거절 · 호스트 키 확인 실패(지문 거절) */
export function sshOutputSignal(text: string): SshSignal | null {
  // 끝난 결과가 질문보다 먼저 — 한 시도의 출력에 '처음 보는 서버' 질문이 남아 있어도 그 뒤의 거절 · 인증 실패를 본다
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/.test(text)) return { kind: 'key-changed' }
  if (/Host key verification failed/.test(text)) return { kind: 'refused' }
  if (/Permission denied \(/.test(text)) return { kind: 'auth' }
  if (/Are you sure you want to continue connecting/.test(text)) {
    const m = /([A-Z0-9-]+) key fingerprint is (SHA256:[A-Za-z0-9+/=]+)/.exec(text)
    return { kind: 'new-host', fingerprint: m ? `${m[1]} · ${m[2]}` : '' }
  }
  return null
}

/** 원격 pane 의 연결 상태 — 일감 머리 띠 · 사이드바 점이 쓴다 */
export type RemoteState =
  | { kind: 'up' }
  /** ssh 는 떴지만 아직 붙었는지 모름 — 출력이 오고 UP_CONFIRM_MS 동안 살아 있으면 up. attempt 0 = 첫 연결(띠 없음) */
  | { kind: 'connecting'; attempt: number }
  | { kind: 'new-host'; fingerprint: string }
  | { kind: 'retry'; attempt: number; inMs: number }
  | { kind: 'down'; why: 'gave-up' | 'key-changed' | 'auth' | 'refused' }

/** ssh 가 출력을 낸 뒤 이만큼 살아 있으면 붙은 것으로 본다(그 뒤 끊기면 다섯 번을 처음부터) — 시험은 걸음 단위의 3배로 줄인다 */
export const UP_CONFIRM_MS = 3000
/** 연결 시도마다 ssh 알림을 찾는 출력 길이 — 그 뒤(원격 셸 안의 글)는 보지 않는다 */
export const SIGNAL_SCAN_MAX = 16 * 1024

export const RECONNECT_TRIES = 5
const STEPS = [1, 2, 4, 8, 8]
/** n 번째(1부터) 다시 붙기 전 기다림 — 다섯 번 넘으면 null. unit = 한 걸음(기본 1초, 시험은 TASKMINAL_SSH_RETRY_MS 로 줄인다) */
export function reconnectDelay(attempt: number, unit = 1000): number | null {
  const k = STEPS[attempt - 1]
  return k === undefined ? null : k * unit
}
