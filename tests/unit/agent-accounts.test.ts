// 51단계: 추가 계정 TUI 명령(env -i 로 셸 함수를 거치지 않는다)에도 훅 설정 · 기록 파일을 넘긴다.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { Accounts } from '../../src/main/accounts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tm-agent-acc-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const run = (agent: 'claude' | 'codex', env: Record<string, string>): { argv: string[]; ev?: string } => {
  const a = new Accounts(dir)
  a.add(agent, '둘째')
  a.select(a.list().find((x) => x.name === '둘째' && x.agent === agent)!.id)
  const script = join(dir, 'show.cjs')
  writeFileSync(script, 'process.stdout.write(JSON.stringify({argv:process.argv.slice(2),ev:process.env.TASKMINAL_AGENT_EVENTS}))')
  const command = a.tuiCommand('p', agent, false, `'${process.execPath}' '${script}'`)
  return JSON.parse(execFileSync('/bin/zsh', ['-fc', command], { encoding: 'utf8', env: { ...process.env, ...env } }))
}

test('claude 추가 계정: 앱이 훅을 켰으면 --settings 와 기록 파일 변수를 넘긴다', () => {
  const out = run('claude', { TASKMINAL_CLAUDE_SETTINGS: '/h/claude settings.json', TASKMINAL_AGENT_EVENTS: '/e/p.log' })
  expect(out).toEqual({ argv: ['--settings', '/h/claude settings.json'], ev: '/e/p.log' })
})

test('codex 추가 계정: 턴 끝 알림을 -c 로 붙인다', () => {
  const out = run('codex', { TASKMINAL_CODEX_NOTIFY: 'notify=["/h/codex-notify.sh"]', TASKMINAL_AGENT_EVENTS: '/e/p.log' })
  expect(out.argv).toEqual(['-c', 'cli_auth_credentials_store="file"', '-c', 'notify=["/h/codex-notify.sh"]'])
})

test('claude 추가 계정: 안내 변수가 있으면 --append-system-prompt 로 넘기고(63단계), codex 추가 계정에는 주지 않는다', () => {
  const guide = { TASKMINAL_AGENT_GUIDE: '첫 줄\ntaskminal notify "확인" # 둘째', TASKMINAL_CODEX_GUIDE: 'developer_instructions="x"', TASKMINAL_CLAUDE_SETTINGS: '', TASKMINAL_CODEX_NOTIFY: '', TASKMINAL_AGENT_EVENTS: '' }
  expect(run('claude', guide).argv).toEqual(['--append-system-prompt', '첫 줄\ntaskminal notify "확인" # 둘째'])
  expect(run('claude', { ...guide, TASKMINAL_CLAUDE_SETTINGS: '/h/s.json' }).argv).toEqual(['--settings', '/h/s.json', '--append-system-prompt', '첫 줄\ntaskminal notify "확인" # 둘째'])
  expect(run('codex', guide).argv).toEqual(['-c', 'cli_auth_credentials_store="file"'])
})

test('훅을 끈 셸(변수 없음)에서는 빈 인자를 만들지 않는다', () => {
  const env = { TASKMINAL_CLAUDE_SETTINGS: '', TASKMINAL_CODEX_NOTIFY: '', TASKMINAL_AGENT_EVENTS: '', TASKMINAL_AGENT_GUIDE: '' }
  expect(run('claude', env).argv).toEqual([])
  expect(run('codex', env).argv).toEqual(['-c', 'cli_auth_credentials_store="file"'])
})
