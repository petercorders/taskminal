import { expect, test } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Accounts } from '../../src/main/accounts'
import { execFileSync } from 'node:child_process'
test('extra accounts clear inherited credentials, keep bindings across selection/restart and use file credentials', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tm-accounts-'))
  try {
    const a = new Accounts(dir)
    a.add('codex', '첫 계정')
    a.add('codex', '둘째 계정')
    const first = a.list().find((x) => x.name === '첫 계정')!,
      second = a.list().find((x) => x.name === '둘째 계정')!
    a.select(first.id)
    const env = {
      PATH: '/bin',
      OPENAI_API_KEY: 'private',
      ANTHROPIC_AUTH_TOKEN: 'private',
      CLAUDE_CODE_OAUTH_TOKEN: 'private',
      CLAUDE_CODE_USE_BEDROCK: '1',
      AWS_PROFILE: 'private',
    }
    const one = a.sessionEnvironment('p', 'codex', false, env)
    expect(one.OPENAI_API_KEY).toBeUndefined()
    expect(one.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(one.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(one.CLAUDE_CODE_USE_BEDROCK).toBeUndefined()
    expect(one.AWS_PROFILE).toBeUndefined()
    expect(one.CODEX_HOME).toBe(join(dir, 'codex', first.id))
    expect(readFileSync(join(one.CODEX_HOME!, 'config.toml'), 'utf8')).toContain('cli_auth_credentials_store = "file"')
    a.select(second.id)
    a.copyBinding('p', 'fork', 'codex')
    expect(a.sessionEnvironment('fork', 'codex', true, env).CODEX_HOME).toBe(one.CODEX_HOME)
    expect(a.tuiCommand('p', 'codex', true, 'codex')).toContain('CODEX_HOME=')
    expect(a.tuiCommand('p', 'codex', true, 'codex')).toContain(first.id)
    const script=join(dir,'show-env.cjs')
    writeFileSync(script,'process.stdout.write(JSON.stringify({key:process.env.OPENAI_API_KEY,mode:process.env.CLAUDE_CODE_USE_BEDROCK,home:process.env.CODEX_HOME}))')
    const command=a.tuiCommand('p','codex',true,`'${process.execPath}' '${script}'`)
    const inherited=JSON.parse(execFileSync('/bin/zsh',['-fc',command],{encoding:'utf8',env:{...process.env,OPENAI_API_KEY:'shell-only',CLAUDE_CODE_USE_BEDROCK:'1'}}))
    expect(inherited).toEqual({home:one.CODEX_HOME})
    expect(a.sessionEnvironment('p', 'codex', true, env).CODEX_HOME).toBe(one.CODEX_HOME)
    expect(new Accounts(dir).sessionEnvironment('p', 'codex', true, env).CODEX_HOME).toBe(one.CODEX_HOME)
    expect(a.sessionEnvironment('new', 'codex', false, env).CODEX_HOME).toBe(join(dir, 'codex', second.id))
    expect(a.sessionEnvironment('legacy', 'codex', true, env).CODEX_HOME).toBeUndefined()
    expect(a.sessionEnvironment('legacy', 'codex', true, env).OPENAI_API_KEY).toBe('private')
    expect(statSync(join(dir, 'accounts.json')).mode & 0o777).toBe(0o600)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('corrupt account records fail closed and preserve original bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tm-accounts-'))
  try {
    writeFileSync(join(dir, 'accounts.json'), 'broken')
    const a = new Accounts(dir)
    expect(() => a.sessionEnvironment('p', 'codex', true, {})).toThrow('손상')
    expect(() => a.add('codex', 'new')).toThrow('손상')
    expect(readFileSync(join(dir, 'accounts.json'), 'utf8')).toBe('broken')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
