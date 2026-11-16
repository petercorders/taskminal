// 51단계: zsh 셸 통합의 claude · codex 감싸기 — 실제 zsh 로 띄우고, PATH 앞의 가짜 claude · codex 가 받은 인자를 본다.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseAgentLine } from '../../src/shared/agent-hooks'

const dir = resolve(__dirname, '../../resources/shell/zsh')
let home: string
let bin: string
let log: string

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-agent-zsh-')))
  bin = join(home, 'bin')
  mkdirSync(bin)
  for (const name of ['claude', 'codex']) {
    const f = join(bin, name)
    // 받은 인자를 | 로 잇고, 인자에 fail 이 있으면 7 로 끝난다
    writeFileSync(f, `#!/bin/sh\nIFS='|'\necho "${name}:$*"\ncase "$*" in *fail*) exit 7;; esac\nexit 0\n`)
    chmodSync(f, 0o755)
  }
  log = join(home, 'p1.log')
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const ON = {
  TASKMINAL_CLAUDE_SETTINGS: '/s/claude settings.json',
  TASKMINAL_CODEX_NOTIFY: 'notify=["/x/codex-notify.sh"]',
}

let stderr = ''
const zsh = (env: Record<string, string>, script: string): string[] => {
  const r = spawnSync('/bin/zsh', ['-l', '-i', '-c', script], {
    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, TERM: 'xterm-256color', ZDOTDIR: dir, TASKMINAL_AGENT_EVENTS: log, ...env },
    encoding: 'utf8',
    timeout: 10_000,
  })
  stderr = r.stderr
  return r.stdout.split('\n').filter((l) => /^(claude|codex|rc|hooked)[:=]/.test(l))
}

describe('zsh claude · codex 감싸기', () => {
  it('claude 에 앱 훅 설정을 붙이고, 하위 명령 · 이미 --settings 를 준 실행은 그대로', () => {
    const out = zsh(ON, 'claude -r abc; claude mcp list; claude --settings=mine x; claude update')
    expect(out).toEqual(['claude:--settings|/s/claude settings.json|-r|abc', 'claude:mcp|list', 'claude:--settings=mine|x', 'claude:update'])
  })

  it('codex 에 턴 끝 알림을 붙이고, 로그인 같은 하위 명령은 그대로', () => {
    const out = zsh(ON, 'codex resume id1; codex; codex login')
    expect(out).toEqual(['codex:-c|notify=["/x/codex-notify.sh"]|resume|id1', 'codex:-c|notify=["/x/codex-notify.sh"]', 'codex:login'])
  })

  it('끝 코드를 그대로 돌려주고, 감싼 실행이 돌아오면 기록 파일에 세션 끝을 남긴다', () => {
    const out = zsh(ON, 'claude fail; print "rc=$?"; codex x; print "rc=$?"; claude mcp; print "rc=$?"')
    expect(out.filter((l) => l.startsWith('rc='))).toEqual(['rc=7', 'rc=0', 'rc=0'])
    const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean)
    expect(lines.map((l) => parseAgentLine(l))).toEqual([
      expect.objectContaining({ agent: 'claude', phase: 'ended' }),
      expect.objectContaining({ agent: 'codex', phase: 'ended' }),
    ])
  })

  it('앱이 변수를 주지 않으면(설정 끔) 감싸지 않는다', () => {
    expect(zsh({}, 'claude -r abc; codex resume id1')).toEqual(['claude:-r|abc', 'codex:resume|id1'])
    expect(existsSync(log)).toBe(false)
  })

  it('사용자가 같은 이름의 alias · 함수를 두었으면 덮지 않는다', () => {
    writeFileSync(join(home, '.zshrc'), "alias claude='claude --model x'\ncodex() { command codex --mine \"$@\" }\n")
    expect(zsh(ON, 'claude -r abc; codex resume id1')).toEqual(['claude:--model|x|-r|abc', 'codex:--mine|resume|id1'])
    expect(stderr).toBe('')
  })

  it('claude alias 만 있어도 셸 통합은 깨지지 않는다(정의 줄의 alias 펼침 · 구문 오류 없음) — codex 는 감싸고 프롬프트 훅도 남는다', () => {
    writeFileSync(join(home, '.zshrc'), "alias claude='claude --model x'\nalias codex2=codex\n")
    const out = zsh(ON, 'claude -r abc; codex resume id1; print "hooked=${precmd_functions[(I)__taskminal_precmd]}"')
    expect(stderr).toBe('')
    expect(out).toEqual(['claude:--model|x|-r|abc', 'codex:-c|notify=["/x/codex-notify.sh"]|resume|id1', 'hooked=1'])
  })
})
