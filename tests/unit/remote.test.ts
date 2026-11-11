import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { controlPathFits, isSshHost, isRemotePath, keygenFixCommand, sshArgs, remoteCommand, parseSshConfigHosts, sshOutputSignal, reconnectDelay, RECONNECT_TRIES, tmuxSession } from '../../src/shared/remote'

/** 원격 명령 `exec /bin/sh -c '<안>'` 의 안쪽을 이 Mac 의 sh 로 풀어 본다(따옴표가 맞는지) */
const inner = (cmd: string): string => {
  expect(cmd.startsWith('exec /bin/sh -c ')).toBe(true)
  return execFileSync('/bin/sh', ['-c', `printf %s ${cmd.slice('exec /bin/sh -c '.length)}`], { encoding: 'utf8' })
}

describe('isSshHost · isRemotePath', () => {
  it('Host 이름 · user@host · IPv4 · IPv6(괄호 없이) 를 받는다', () => {
    for (const h of ['nas', 'peter@192.168.0.20', 'my-host.example.com', 'u_1@h', '::1', 'fe80::1%en0', 'u@2001:db8::2']) expect(isSshHost(h)).toBe(true)
  })
  it('host:port · [IPv6] 는 ssh 명령줄이 못 읽는다 — 거절(포트는 ~/.ssh/config 의 Port)', () => {
    for (const h of ['nas:2222', 'u@nas.local:22', '[::1]', '[::1]:22']) expect(isSshHost(h)).toBe(false)
  })
  it('- 로 시작(옵션 주입) · 공백 · 제어 글자 · 따옴표 · 빈 글 · 너무 긴 글은 거절', () => {
    for (const h of ['', '-oProxyCommand=x', '-oProxyCommand', '-p22', 'a b', 'a\nb', "a'b", 'a;b', 'a$(x)', 'x'.repeat(256)]) expect(isSshHost(h)).toBe(false)
  })
  it('원격 경로는 줄바꿈 · NUL · 빈 글 거절', () => {
    expect(isRemotePath('/volume1/docker/app')).toBe(true)
    expect(isRemotePath("~/it's")).toBe(true)
    expect(isRemotePath('a\nb')).toBe(false)
    expect(isRemotePath('a\0b')).toBe(false)
    expect(isRemotePath('')).toBe(false)
  })
})

describe('sshArgs · remoteCommand', () => {
  it('소켓 폴더가 없으면(경로가 너무 김 · 안전하지 않음) 연결 나누기 옵션 없이', () => {
    const a = sshArgs({ host: 'nas', cwd: '/v', paneId: 'p1', tmux: false, controlDir: null })
    expect(a.join(' ')).not.toContain('Control')
    expect(a).toContain('ServerAliveInterval=15')
    expect(a[a.indexOf('--') + 1]).toBe('nas')
  })
  it('ControlPath 는 macOS 소켓 경로 한도(104바이트)에 ssh 가 붙이는 %C(40) · 임시 꼬리(17)까지 들어가야 한다', () => {
    expect(controlPathFits('/tmp/taskminal-501')).toBe(true)
    expect(controlPathFits('/Users/gimgibong/Library/Application Support/Taskminal/ssh')).toBe(false)
    expect(controlPathFits('/' + 'a'.repeat(44))).toBe(true) // 45 + 1 + 40 + 17 + NUL = 104
    expect(controlPathFits('/' + 'a'.repeat(45))).toBe(false)
    expect(controlPathFits('/한')).toBe(true) // 바이트로 센다
    expect(controlPathFits('/' + '한'.repeat(15))).toBe(false)
  })
  it('ControlMaster · ControlPath · 끊김 감지 옵션 뒤 -- 와 호스트, 마지막이 원격 명령', () => {
    const a = sshArgs({ host: 'nas', cwd: '/v1/app', paneId: 'p1', tmux: true, controlDir: '/u/ssh' })
    expect(a[0]).toBe('-t')
    expect(a).toContain('ControlMaster=auto')
    expect(a).toContain('ControlPath=/u/ssh/%C')
    expect(a).toContain('ServerAliveInterval=15')
    const dd = a.indexOf('--')
    expect(a[dd + 1]).toBe('nas')
    expect(a.length).toBe(dd + 3)
    expect(a[dd + 2]).toBe(remoteCommand('/v1/app', 'p1', true))
  })
  it('원격 명령은 /bin/sh -c 로 감싼다 — 로그인 셸이 fish · csh 여도 POSIX 문법이 돈다', () => {
    const c = remoteCommand('/v', 'p1', false)
    expect(c.startsWith("exec /bin/sh -c '")).toBe(true)
    expect(inner(c)).toBe(`cd '/v' 2>/dev/null || echo "taskminal: 폴더가 없어 홈에서 열어요 — /v"; exec "\${SHELL:-/bin/sh}" -l`)
  })
  it('원격 명령: 폴더로 cd · tmux 가 있으면 같은 세션에 붙고 없으면 로그인 셸 · 작은따옴표는 이스케이프', () => {
    const c = inner(remoteCommand("/v/it's", 'p1', true))
    expect(c).toContain(`cd '/v/it'\\''s'`)
    expect(c).toContain(`exec tmux new-session -A -s ${tmuxSession('p1')}`)
    expect(c).toContain('exec "${SHELL:-/bin/sh}" -l')
    expect(remoteCommand('/v', 'p1', false)).not.toContain('tmux')
  })
  it('~ 로 시작하는 경로는 원격 셸이 펼치게 따옴표 밖에 둔다', () => {
    expect(inner(remoteCommand('~/app', 'p', false))).toContain(`cd ~/'app'`)
    expect(inner(remoteCommand('~', 'p', false))).toContain('cd ~ ')
  })
  it('키 바뀜 고칠 명령 — 별칭 · user@host 를 ssh -G 로 실제 HostName(포트가 22 가 아니면 [host]:port)으로 풀어 지운다', () => {
    const c = keygenFixCommand('peter@nas')
    expect(c).toContain(`ssh -G 'peter@nas'`)
    expect(c.startsWith('ssh-keygen -R "$(')).toBe(true)
    // awk 부분이 ssh -G 출력을 맞게 푸는지 — 가짜 출력으로
    const awk = /awk ('[^']+')/.exec(c)![1]!
    const run = (out: string) => execFileSync('/bin/sh', ['-c', `printf '${out}' | awk ${awk}`], { encoding: 'utf8' }).trim()
    expect(run('user peter\\nhostname 10.0.0.2\\nport 22\\n')).toBe('10.0.0.2')
    expect(run('hostname nas.local\\nport 2222\\n')).toBe('[nas.local]:2222')
  })
  it('tmux 세션 이름은 pane id 에서 — 셸에 안전한 글자만', () => {
    expect(tmuxSession('abc-123')).toBe('tm-abc-123')
    expect(tmuxSession('a b;c')).toBe('tm-abc')
  })
})

describe('parseSshConfigHosts', () => {
  it('Host 줄의 이름들 · 와일드카드 · 부정 · 주석은 뺀다 · 겹치면 한 번', () => {
    const cfg = `# 주석\nHost nas nas-backup\n  HostName 192.168.0.20\nHost *\n  ForwardAgent no\nhost  gpu-*  !bad web\nMatch host x\nHost nas\n`
    expect(parseSshConfigHosts(cfg)).toEqual(['nas', 'nas-backup', 'web'])
  })
})

describe('sshOutputSignal', () => {
  it('처음 보는 서버 질문과 지문', () => {
    const s = sshOutputSignal(
      "The authenticity of host 'nas (192.168.0.20)' can't be established.\r\nED25519 key fingerprint is SHA256:q3Z8m1XcAbC/f0Kp.\r\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ",
    )
    expect(s).toEqual({ kind: 'new-host', fingerprint: 'ED25519 · SHA256:q3Z8m1XcAbC/f0Kp' })
  })
  it('키가 바뀜 · 인증 거절 · 아무것도 아님', () => {
    expect(sshOutputSignal('@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @')).toEqual({ kind: 'key-changed' })
    expect(sshOutputSignal('peter@nas: Permission denied (publickey).')).toEqual({ kind: 'auth' })
    expect(sshOutputSignal('hello')).toBeNull()
  })
  it('지문을 거절(no)하거나 known_hosts 확인이 실패하면 refused — 키 바뀜 글이 함께 있으면 key-changed 가 먼저', () => {
    expect(sshOutputSignal('Host key verification failed.')).toEqual({ kind: 'refused' })
    expect(sshOutputSignal('@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @\nHost key verification failed.')).toEqual({ kind: 'key-changed' })
  })
  it('질문 뒤에 온 결과가 이긴다 — 같은 시도의 출력에 질문이 남아 있어도 거절 · 인증 실패를 알아본다', () => {
    const q = 'ED25519 key fingerprint is SHA256:abc.\nAre you sure you want to continue connecting (yes/no)? '
    expect(sshOutputSignal(q + 'no\nHost key verification failed.')).toEqual({ kind: 'refused' })
    expect(sshOutputSignal(q + 'yes\nWarning: Permanently added\npeter@nas: Permission denied (publickey).')).toEqual({ kind: 'auth' })
  })
})

describe('reconnectDelay', () => {
  it('1 · 2 · 4 · 8 · 8초, 다섯 번 넘으면 null', () => {
    expect(RECONNECT_TRIES).toBe(5)
    expect([1, 2, 3, 4, 5, 6].map((n) => reconnectDelay(n))).toEqual([1000, 2000, 4000, 8000, 8000, null])
  })
  it('단위를 바꾸면(시험) 같은 배수로', () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => reconnectDelay(n, 10))).toEqual([10, 20, 40, 80, 80, null])
  })
})
