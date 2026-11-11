import { describe, expect, it } from 'vitest'
import { isSshHost, isRemotePath, sshArgs, remoteCommand, parseSshConfigHosts, sshOutputSignal, reconnectDelay, RECONNECT_TRIES, tmuxSession } from '../../src/shared/remote'

describe('isSshHost · isRemotePath', () => {
  it('Host 이름 · user@host · IPv4 · [IPv6] 를 받는다', () => {
    for (const h of ['nas', 'peter@192.168.0.20', 'my-host.example.com', 'u_1@h', '[::1]', 'nas:2222']) expect(isSshHost(h)).toBe(true)
  })
  it('- 로 시작(옵션 주입) · 공백 · 제어 글자 · 따옴표 · 빈 글 · 너무 긴 글은 거절', () => {
    for (const h of ['', '-oProxyCommand=x', 'a b', 'a\nb', "a'b", 'a;b', 'a$(x)', 'x'.repeat(256)]) expect(isSshHost(h)).toBe(false)
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
  it('원격 명령: 폴더로 cd · tmux 가 있으면 같은 세션에 붙고 없으면 로그인 셸 · 작은따옴표는 이스케이프', () => {
    const c = remoteCommand("/v/it's", 'p1', true)
    expect(c).toContain(`cd '/v/it'\\''s'`)
    expect(c).toContain(`exec tmux new-session -A -s ${tmuxSession('p1')}`)
    expect(c).toContain('exec "${SHELL:-/bin/sh}" -l')
    expect(remoteCommand('/v', 'p1', false)).not.toContain('tmux')
  })
  it('~ 로 시작하는 경로는 원격 셸이 펼치게 따옴표 밖에 둔다', () => {
    expect(remoteCommand('~/app', 'p', false)).toContain(`cd ~/'app'`)
    expect(remoteCommand('~', 'p', false)).toContain('cd ~ ')
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
