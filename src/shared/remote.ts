// SSH 원격 일감 (25단계) — 로컬 pty 에서 ssh 를 띄운다. 앱은 비밀번호 · 키를 갖지 않고, 사용자의 ssh 설정 · agent · known_hosts 를 그대로 쓴다.

/** ~/.ssh/config 의 Host 이름 · user@host · IP · [IPv6] · host:port. 옵션 주입(- 로 시작) · 셸 글자 · 공백은 거절 */
export function isSshHost(v: string): boolean {
  return v.length > 0 && v.length <= 255 && !v.startsWith('-') && /^[A-Za-z0-9._@:[\]%-]+$/.test(v)
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

/** 원격에서 돌 명령 — POSIX sh 만 쓴다(Synology ash 등). tmux 가 있으면 같은 세션에, 없으면 로그인 셸 */
export function remoteCommand(cwd: string, paneId: string, tmux: boolean): string {
  const cd = `cd ${quotePath(cwd)} 2>/dev/null || echo "taskminal: 폴더가 없어 홈에서 열어요 — ${cwd.replace(/["$`\\]/g, '')}";`
  const t = tmux ? ` command -v tmux >/dev/null 2>&1 && exec tmux new-session -A -s ${tmuxSession(paneId)};` : ''
  return `${cd}${t} exec "\${SHELL:-/bin/sh}" -l`
}

export interface SshSpec {
  host: string
  cwd: string
  paneId: string
  tmux: boolean
  /** <userData>/ssh — ControlPath 소켓 폴더(0700) */
  controlDir: string
}
/** ssh 인자 — 호스트당 연결 하나(ControlMaster), 끊김은 ServerAlive 로 알아챈다. 호스트 앞 -- 로 옵션 주입을 막는다 */
export function sshArgs(s: SshSpec): string[] {
  return [
    '-t',
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=${s.controlDir}/%C`,
    '-o', 'ControlPersist=600',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '--',
    s.host,
    remoteCommand(s.cwd, s.paneId, s.tmux),
  ]
}

/** ~/.ssh/config 의 Host 이름들 — 와일드카드(* ?) · 부정(!) · Match 는 빼고, 처음 나온 순서로 한 번씩 */
export function parseSshConfigHosts(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim()
    const m = /^host\s+(.+)$/i.exec(line)
    if (!m) continue
    for (const name of m[1]!.split(/\s+/)) {
      if (!name || /[*?!]/.test(name) || !isSshHost(name) || out.includes(name)) continue
      out.push(name)
    }
  }
  return out
}

export type SshSignal = { kind: 'new-host'; fingerprint: string } | { kind: 'key-changed' } | { kind: 'auth' }
/** pane 출력에서 ssh 의 알림을 알아본다 — 처음 보는 서버(지문) · 키 바뀜 · 인증 거절 */
export function sshOutputSignal(text: string): SshSignal | null {
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/.test(text)) return { kind: 'key-changed' }
  if (/Are you sure you want to continue connecting/.test(text)) {
    const m = /([A-Z0-9-]+) key fingerprint is (SHA256:[A-Za-z0-9+/=]+)/.exec(text)
    return { kind: 'new-host', fingerprint: m ? `${m[1]} · ${m[2]}` : '' }
  }
  if (/Permission denied \(/.test(text)) return { kind: 'auth' }
  return null
}

export const RECONNECT_TRIES = 5
const DELAYS = [1000, 2000, 4000, 8000, 8000]
/** n 번째(1부터) 다시 붙기 전 기다림 — 다섯 번 넘으면 null */
export function reconnectDelay(attempt: number): number | null {
  return DELAYS[attempt - 1] ?? null
}
