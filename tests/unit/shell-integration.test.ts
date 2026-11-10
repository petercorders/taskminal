// resources/shell/zsh 셸 통합을 실제 zsh 로 띄워 본다 (macOS /etc/zshrc 포함). 사용자 dotfile 대신 임시 HOME 을 쓴다.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { unescapeCommand } from '../../src/shared/activity'
import { parseOsc7 } from '../../src/shared/cwd'

const dir = resolve(__dirname, '../../resources/shell/zsh')
let home: string

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-zsh-')))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const zsh = (env: Record<string, string>, script: string): string =>
  execFileSync('/bin/zsh', ['-l', '-i', '-c', script], {
    env: { HOME: home, PATH: '/usr/bin:/bin', TERM: 'xterm-256color', ZDOTDIR: dir, ...env },
    encoding: 'utf8',
    timeout: 10_000,
  })

describe('zsh 셸 통합', () => {
  it('사용자 .zshrc 를 읽고, 기록 파일은 사용자 HOME 에, 끝나면 ZDOTDIR 은 없던 대로', () => {
    writeFileSync(join(home, '.zshrc'), 'export MARK=from-home\n')
    const out = zsh({}, 'print -r -- "H=$HISTFILE Z=${ZDOTDIR-unset} M=$MARK U=${TASKMINAL_USER_ZDOTDIR-unset}"')
    expect(out.trim().split('\n').at(-1)).toBe(`H=${home}/.zsh_history Z=unset M=from-home U=unset`)
  })

  it('원래 ZDOTDIR 이 있었으면 그 폴더의 설정 · 기록 파일, 끝나면 ZDOTDIR 도 그 폴더', () => {
    const cfg = join(home, 'cfg')
    mkdirSync(cfg)
    writeFileSync(join(cfg, '.zshrc'), 'export MARK=from-cfg\n')
    const out = zsh({ TASKMINAL_USER_ZDOTDIR: cfg }, 'print -r -- "H=$HISTFILE Z=$ZDOTDIR M=$MARK"')
    expect(out.trim().split('\n').at(-1)).toBe(`H=${cfg}/.zsh_history Z=${cfg} M=from-cfg`)
  })

  it('명령 글자의 제어 문자 · ; · \\ 를 모두 바꿔 보내고, 되돌리면 원래 명령', () => {
    const command = 'a;b\\c\nd\x18e\x1af\rg\x7fh\x07i\x1bj'
    const out = execFileSync('/bin/zsh', ['-f', '-c', `source ${dir}/taskminal-hooks.zsh; __taskminal_preexec "$1"`, 'x', command], {
      encoding: 'utf8',
    })
    const m = out.match(/^\x1b\]6973;cmd;([^\x07]*)\x07\x1b\]133;C\x07$/)
    expect(m, JSON.stringify(out)).not.toBeNull()
    expect(m![1]).not.toMatch(/[\x00-\x1f\x7f;]/)
    expect(unescapeCommand(m![1]!)).toBe(command)
  })

  it('프롬프트마다 OSC 7 로 지금 폴더를 알리고, 한글 · 공백 · % · ; 폴더도 parseOsc7 이 원래 경로로 되돌린다 (13단계)', () => {
    const folder = join(home, '한글 폴더;a%b')
    mkdirSync(folder)
    const out = execFileSync('/bin/zsh', ['-f', '-c', `source ${dir}/taskminal-hooks.zsh; cd "$1"; __taskminal_precmd`, 'x', folder], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', HOST: 'my-mac', LANG: 'ko_KR.UTF-8' },
    })
    const m = out.match(/\x1b\]7;([^\x07]*)\x07/)
    expect(m, JSON.stringify(out)).not.toBeNull()
    expect(m![1]).not.toMatch(/[\x00-\x1f\x7f; ]/)
    expect(parseOsc7(m![1]!, 'my-mac')).toBe(folder)
  })
})
