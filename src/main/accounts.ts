import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import type { ChatAgent } from '../shared/chat'
import { codexUsage, type AccountStatus, type AgentAccount } from '../shared/accounts'
import { redact } from '../shared/redact'
import { AgentBinFinder } from './chat/find-bin'

interface Saved {
  accounts: Array<Omit<AgentAccount, 'selected'>>
  selected: Record<string, string>
  bindings: Record<string, string>
}
export class Accounts {
  private data: Saved = { accounts: [], selected: {}, bindings: {} }
  private logins = new Map<string, { child: ChildProcess; output: string; running: boolean }>()
  private pending = new Map<string, Promise<AccountStatus>>()
  private queries = new Set<ChildProcess>()
  private finder = new AgentBinFinder()
  private corrupt = false
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    try {
      const raw = readFileSync(join(dir, 'accounts.json'), 'utf8')
      if (raw.length > 1_000_000) throw new Error('large')
      const d = JSON.parse(raw)
      if (!Array.isArray(d.accounts) || d.accounts.length > 20 || !d.selected || !d.bindings || Object.keys(d.bindings).length > 20000)
        throw new Error('invalid')
      if (
        !d.accounts.every(
          (a: Record<string, unknown>) =>
            a &&
            typeof a.id === 'string' &&
            /^[a-f0-9-]{36}$/.test(a.id) &&
            ['claude', 'codex'].includes(String(a.agent)) &&
            typeof a.name === 'string' &&
            a.name.length <= 80,
        )
      )
        throw new Error('invalid')
      const valid = new Set(['default-claude', 'default-codex', ...d.accounts.map((a: { id: string }) => a.id)])
      if (!Object.values(d.selected).every((id) => valid.has(id as string)) || !Object.values(d.bindings).every((id) => valid.has(id as string)))
        throw new Error('invalid')
      this.data = d
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.corrupt = true
    }
  }
  private save() {
    const path = join(this.dir, 'accounts.json')
    writeFileSync(path + '.tmp', JSON.stringify(this.data), { mode: 0o600 })
    chmodSync(path + '.tmp', 0o600)
    renameSync(path + '.tmp', path)
  }
  list(): AgentAccount[] {
    if (this.corrupt) throw new Error('계정 기록이 손상돼 대화 재개를 중단했어요. accounts.json 원본을 보존하고 복구해 주세요.')
    return (['claude', 'codex'] as const)
      .flatMap((agent) => [
        { id: `default-${agent}`, agent, name: `${agent === 'claude' ? 'Claude' : 'Codex'} 기본 계정` },
        ...this.data.accounts.filter((a) => a.agent === agent),
      ])
      .map((a) => ({ ...a, selected: (this.data.selected[a.agent] ?? `default-${a.agent}`) === a.id }))
  }
  private account(id: string) {
    const a = this.list().find((a) => a.id === id)
    if (!a) throw new Error('계정을 찾지 못했어요')
    return a
  }
  add(agent: ChatAgent, name: string) {
    this.list()
    if (this.data.accounts.length >= 20) throw new Error('추가 계정은 20개까지 만들 수 있어요')
    const id = randomUUID()
    this.data.accounts.push({ id, agent, name: name.trim() })
    const dir = join(this.dir, agent, id)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (agent === 'codex') writeFileSync(join(dir, 'config.toml'), 'cli_auth_credentials_store = "file"\n', { mode: 0o600 })
    this.save()
  }
  select(id: string) {
    const a = this.account(id)
    this.data.selected[a.agent] = id
    this.save()
  }
  env(id: string): Record<string, string> {
    const a = this.account(id)
    return id.startsWith('default-')
      ? {}
      : a.agent === 'codex'
        ? { CODEX_HOME: join(this.dir, a.agent, id) }
        : { CLAUDE_CONFIG_DIR: join(this.dir, a.agent, id) }
  }
  environment(id: string, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env = { ...base, ...this.env(id) }
    if (!id.startsWith('default-'))
      for (const k of Object.keys(env))
        if (
          /^(ANTHROPIC_|OPENAI_|AWS_|GOOGLE_|GOOGLE_APPLICATION_|AZURE_|VERTEX_|BEDROCK_|CLAUDE_CODE_(?:OAUTH|API_KEY|USE_|AWS_|VERTEX_|FOUNDRY_)|CODEX_API_KEY)/.test(
            k,
          )
        )
          delete env[k]
    if (!id.startsWith('default-')) env.TASKMINAL_ACCOUNT_ISOLATED = '1'
    return env
  }
  sessionEnvironment(pane: string, agent: ChatAgent, resuming: boolean, base: NodeJS.ProcessEnv): Record<string, string> {
    this.bind(pane, agent, resuming)
    const env = this.environment(this.data.bindings[`${agent}:${pane}`]!, base)
    return Object.fromEntries(Object.entries(env).filter((pair): pair is [string, string] => typeof pair[1] === 'string'))
  }
  bind(pane: string, agent: ChatAgent, resuming: boolean): Record<string, string> {
    const key = `${agent}:${pane}`
    const id = this.data.bindings[key] ?? (resuming ? `default-${agent}` : (this.data.selected[agent] ?? `default-${agent}`))
    this.account(id)
    this.data.bindings[key] = id
    this.save()
    return this.env(id)
  }
  copyBinding(from: string, to: string, agent: ChatAgent, strict=false) {
    this.list()
    if(strict&&!this.data.bindings[`${agent}:${from}`])throw new Error('원래 계정 바인딩을 찾지 못했어요')
    this.data.bindings[`${agent}:${to}`] = this.data.bindings[`${agent}:${from}`] ?? `default-${agent}`
    this.save()
  }
  tuiCommand(pane: string, agent: ChatAgent, resuming: boolean, bin: string): string {
    this.bind(pane, agent, resuming)
    const id = this.data.bindings[`${agent}:${pane}`]!
    if (id.startsWith('default-')) return bin
    const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'"
    const vars = Object.entries(this.env(id))
      .map(([k, v]) => k + '=' + quote(v))
      .join(' ')
    // Login-shell startup files can add credentials not present in the GUI process.
    // Start from an explicit environment rather than trying to enumerate secret names.
    return (
      'env -i HOME="$HOME" PATH="$PATH" TERM="${TERM:-xterm-256color}" LANG="${LANG:-en_US.UTF-8}" TMPDIR="$TMPDIR" SHELL="$SHELL" SSH_AUTH_SOCK="$SSH_AUTH_SOCK" TASKMINAL_PANE_ID="$TASKMINAL_PANE_ID" TASKMINAL_TASK_ID="$TASKMINAL_TASK_ID" TASKMINAL_SOCKET="$TASKMINAL_SOCKET" TASKMINAL_CLI_NODE="$TASKMINAL_CLI_NODE" TASKMINAL_CLI_JS="$TASKMINAL_CLI_JS" ' +
      vars +
      ' ' +
      bin +
      (agent === 'codex' ? ' -c \'cli_auth_credentials_store="file"\'' : '')
    )
  }
  async status(id: string): Promise<AccountStatus> {
    const have = this.pending.get(id)
    if (have) return have
    const request = this.readStatus(id).finally(() => this.pending.delete(id))
    this.pending.set(id, request)
    return request
  }
  private async readStatus(id: string): Promise<AccountStatus> {
    const account = this.account(id),
      login = this.logins.get(id)
    const base = { display: account.name, windows: [], updatedAt: Date.now(), ...(login ? { login: { running: login.running, output: login.output } } : {}) }
    if (login?.running) return { ...base, state: 'unavailable', message: '로그인 중이에요. 아래 안내를 따라 완료해 주세요.' }
    const bin = await this.finder.find(account.agent)
    if (!bin) return { ...base, state: 'missing', message: '에이전트 CLI를 찾지 못했어요.' }
    const env = this.environment(id, { ...process.env, PATH: bin.path })
    if (account.agent === 'claude') {
      return new Promise((resolve) =>
        execFile(bin.bin, ['auth', 'status', '--json'], { env, timeout: 15000, maxBuffer: 100000 }, (err, stdout) => {
          try {
            const d = JSON.parse(stdout)
            const signed = d.loggedIn === true || (typeof d.authMethod === 'string' && d.authMethod !== 'none')
            resolve({
              ...base,
              state: signed ? 'unsupported' : 'signed-out',
              message: signed ? '로그인됨 · Claude 플랜 한도 조회는 지원하지 않아요.' : '로그인이 필요해요.',
            })
          } catch {
            resolve({ ...base, state: err ? 'unavailable' : 'unsupported', message: '계정 상태를 읽지 못했어요. CLI 버전을 확인해 주세요.' })
          }
        }),
      )
    }
    return new Promise((resolve) => {
      const args = ['app-server', '--listen', 'stdio://', ...(id.startsWith('default-') ? [] : ['-c', 'cli_auth_credentials_store="file"'])]
      const child = spawn(bin.bin, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
      this.queries.add(child)
      child.stderr?.resume()
      const lines = createInterface({ input: child.stdout! })
      let done = false,
        accountReady = false,
        display = account.name,
        authenticated = false
      const finish = (state: AccountStatus) => {
        if (done) return
        done = true
        clearTimeout(timer)
        lines.close()
        this.queries.delete(child)
        child.kill()
        resolve(state)
      }
      const send = (method: string, n: number, params: unknown) => child.stdin!.write(JSON.stringify({ id: n, method, params }) + '\n')
      const timer = setTimeout(() => finish({ ...base, state: 'unavailable', message: '조회 시간이 지났어요. 다시 시도해 주세요.' }), 15000)
      lines.on('line', (line) => {
        let msg: Record<string, any>
        try {
          msg = JSON.parse(line)
        } catch {
          return
        }
        if (msg.id === 1) {
          if (msg.error) {
            finish({ ...base, state: 'unavailable' })
            return
          }
          child.stdin!.write('{"method":"initialized","params":{}}\n')
          send('account/read', 2, { refreshToken: false })
        }
        if (msg.id === 2) {
          if (msg.error) {
            finish({ ...base, state: 'unavailable', message: '계정 조회에 실패했어요.' })
            return
          }
          const a = msg.result?.account
          authenticated = !!a || msg.result?.requiresOpenaiAuth === false
          accountReady = true
          if (!authenticated) {
            finish({ ...base, state: 'signed-out', message: '로그인이 필요해요.' })
            return
          }
          if (typeof a?.email === 'string') display = redact(a.email).slice(0, 160)
          send('account/rateLimits/read', 3, {})
        }
        if (msg.id === 3) {
          const windows = codexUsage(msg.result)
          finish({
            ...base,
            display,
            windows,
            state: msg.error ? 'unavailable' : windows.length ? 'ready' : 'unsupported',
            message: msg.error ? '사용량 조회에 실패했어요.' : windows.length ? undefined : '제공된 한도 수치가 없어요.',
          })
        }
      })
      child.on('error', () => finish({ ...base, state: 'unavailable', message: '조회 프로세스를 실행하지 못했어요.' }))
      child.on('exit', () =>
        finish({
          ...base,
          display,
          state: accountReady && authenticated ? 'unsupported' : 'unavailable',
          message: '조회가 끝나지 않았어요. 다시 시도해 주세요.',
        }),
      )
      child.stdin!.on('error', () => {})
      send('initialize', 1, { clientInfo: { name: 'taskminal-usage', version: '0.1.0' }, capabilities: {} })
    })
  }
  async login(id: string) {
    const a = this.account(id)
    if (id.startsWith('default-')) throw new Error('기본 계정 로그인은 기존 CLI에서 진행해 주세요. 여기서는 추가 계정만 로그인할 수 있어요.')
    if (this.logins.get(id)?.running) return
    // Reserve before the async executable lookup so same-frame calls cannot spawn twice.
    const slot = { child: null as ChildProcess | null, output: '준비하는 중…', running: true }
    this.logins.set(id, slot as { child: ChildProcess; output: string; running: boolean })
    try {
      const bin = await this.finder.find(a.agent)
      if (!bin) throw new Error('CLI를 찾지 못했어요')
      if (!slot.running) return
      const args = a.agent === 'codex' ? ['-c', 'cli_auth_credentials_store="file"', 'login', '--device-auth'] : ['auth', 'login', '--claudeai']
      const child = spawn(bin.bin, args, { env: this.environment(id, { ...process.env, PATH: bin.path }), stdio: ['ignore', 'pipe', 'pipe'] })
      slot.child = child
      slot.output = ''
      const output = (d: Buffer) => {
        slot.output = redact((slot.output + d.toString()).replace(/\x1b\[[0-9;]*m/g, '')).slice(-6000)
      }
      child.stdout?.on('data', output)
      child.stderr?.on('data', output)
      const timer = setTimeout(() => {
        child.kill()
        slot.output += '\n로그인 시간이 지났어요. 다시 시도해 주세요.'
      }, 300000)
      const finish = () => {
        slot.running = false
        clearTimeout(timer)
        try {
          chmodSync(join(this.dir, a.agent, id, 'auth.json'), 0o600)
        } catch {}
      }
      child.on('exit', finish)
      child.on('error', () => {
        slot.output = '로그인을 실행하지 못했어요.'
        finish()
      })
    } catch (e) {
      slot.running = false
      slot.output = '로그인을 준비하지 못했어요.'
      throw e
    }
  }
  cancel(id: string) {
    const l = this.logins.get(id)
    if (l) {
      l.child?.kill()
      l.running = false
      l.output += '\n로그인을 중단했어요. 이미 완료된 인증은 유지될 수 있어요.'
    }
  }
  dispose() {
    for (const l of this.logins.values()) if (l.running) l.child?.kill()
    for (const child of this.queries) child.kill()
  }
}
