// 52단계 main: statusLine 스크립트(실제 /bin/sh) · 사용자 statusLine 잇기 · 상태 파일 감시 · UsageStore · 계정 매핑 · 대화 원천.
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { claudeStatusLineScript } from '../../src/shared/agent-hooks'
import { AgentEvents, syncUserStatusLine, writeHookFiles } from '../../src/main/agent-events'
import { UsageStore, claudeAccountId } from '../../src/main/usage-store'
import { ClaudeSession, type ChildLike } from '../../src/main/chat/claude-adapter'
import type { UsageSnapshot } from '../../src/shared/usage'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tm-usage-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const RL = '{"five_hour":{"used_percentage":42,"resets_at":1794816000},"seven_day":{"used_percentage":91.5,"resets_at":1794906000}}'
const INPUT = `{"session_id":"s","cwd":"/secret/project","model":{"id":"m","display_name":"Opus"},"rate_limits":${RL},"cost":{"total_cost_usd":1.2}}`

describe('statusLine 스크립트 (실제 /bin/sh)', () => {
  const setup = (userCmd?: string) => {
    const hooks = join(root, 'agent-hooks')
    mkdirSync(hooks)
    const script = join(hooks, 'claude-statusline.sh')
    writeFileSync(script, claudeStatusLineScript())
    chmodSync(script, 0o700)
    if (userCmd !== undefined) writeFileSync(join(hooks, 'user-statusline.cmd'), userCmd)
    const events = join(root, 'agent-events')
    mkdirSync(events)
    return { script, log: join(events, 'p1.log'), status: join(events, 'p1.status') }
  }
  const run = (script: string, input: string, env: Record<string, string>) =>
    spawnSync('/bin/sh', ['-c', `'${script}'`], { input, env: { PATH: '/usr/bin:/bin', ...env }, encoding: 'utf8' })

  it('rate_limits 만 pane 상태 파일에 쓰고(폴더 · 비용은 안 씀), 사용자 statusLine 이 없으면 아무것도 출력하지 않는다', () => {
    const { script, log, status } = setup()
    const r = run(script, INPUT, { TASKMINAL_AGENT_EVENTS: log, CLAUDE_CONFIG_DIR: '/acc/c1' })
    expect([r.status, r.stdout, r.stderr]).toEqual([0, '', ''])
    const text = readFileSync(status, 'utf8')
    expect(text).toBe(`v1\t/acc/c1\t${RL}\n`)
    expect(text).not.toContain('/secret/project')
  })

  it('사용자의 원래 statusLine 명령을 같은 입력으로 이어 부르고 그 출력을 그대로 낸다', () => {
    const { script, log } = setup(`sed -n 's/.*"display_name":"\\([A-Za-z]*\\)".*/USER:\\1/p'`)
    const r = run(script, INPUT, { TASKMINAL_AGENT_EVENTS: log })
    expect([r.status, r.stdout]).toEqual([0, 'USER:Opus']) // 입력을 그대로(끝 줄바꿈 없이) 넘긴다
  })

  it('rate_limits 가 없거나 기록 변수가 없으면 상태 파일을 쓰지 않는다', () => {
    const { script, log, status } = setup()
    expect(run(script, '{"session_id":"s"}', { TASKMINAL_AGENT_EVENTS: log }).status).toBe(0)
    expect(existsSync(status)).toBe(false)
    expect(run(script, INPUT, {}).status).toBe(0)
    expect(existsSync(status)).toBe(false)
  })
})

describe('사용자 statusLine 잇기 · 훅 설정', () => {
  it('설정의 statusLine 명령을 cmd 파일(0600)로 두고, 바뀌면 다시 쓰고, 없어지면 지운다 · 깨진 JSON 이면 그대로 둔다', () => {
    const hooks = join(root, 'agent-hooks')
    const claudeDir = join(root, 'claude')
    mkdirSync(claudeDir)
    writeHookFiles(hooks)
    const cmd = join(hooks, 'user-statusline.cmd')
    const settings = join(claudeDir, 'settings.json')
    writeFileSync(settings, JSON.stringify({ statusLine: { type: 'command', command: 'echo one' } }))
    syncUserStatusLine(hooks, claudeDir)
    expect(readFileSync(cmd, 'utf8')).toBe('echo one')
    expect(statSync(cmd).mode & 0o777).toBe(0o600)
    writeFileSync(settings, JSON.stringify({ statusLine: { type: 'command', command: 'echo two' } }))
    const later = new Date(Date.now() + 5000)
    require('node:fs').utimesSync(settings, later, later)
    syncUserStatusLine(hooks, claudeDir)
    expect(readFileSync(cmd, 'utf8')).toBe('echo two')
    writeFileSync(settings, '{ broken')
    require('node:fs').utimesSync(settings, new Date(Date.now() + 9000), new Date(Date.now() + 9000))
    syncUserStatusLine(hooks, claudeDir)
    expect(readFileSync(cmd, 'utf8')).toBe('echo two')
    writeFileSync(settings, JSON.stringify({ model: 'x' }))
    require('node:fs').utimesSync(settings, new Date(Date.now() + 12000), new Date(Date.now() + 12000))
    syncUserStatusLine(hooks, claudeDir)
    expect(existsSync(cmd)).toBe(false)
  })

  it('앱 훅 설정에 statusLine 이 앱 스크립트로 걸린다', () => {
    const files = writeHookFiles(join(root, 'agent-hooks'))
    const s = JSON.parse(readFileSync(files.claudeSettings, 'utf8'))
    expect(s.statusLine.command).toContain(files.claudeStatusLine)
    expect(statSync(files.claudeStatusLine).mode & 0o777).toBe(0o700)
  })
})

describe('상태 파일 감시', () => {
  it('pane 상태 파일이 바뀌면 250ms 로 묶어 한 번 알린다', async () => {
    const dir = join(root, 'agent-events')
    const seen: Array<[string, string]> = []
    // 감시가 늦거나 놓쳐도 주기 읽기가 받는다(전체 시험 부하에서 FSEvents 가 3초 넘게 늦은 적이 있다)
    const ev = new AgentEvents({ dir, onSignal: () => {}, onStatus: (p, t) => seen.push([p, t]), pollMs: 200 })
    ev.start()
    try {
      for (let i = 0; i < 3; i++) writeFileSync(join(dir, 'p1.status'), `v1\t\t{"five_hour":{"used_percentage":${i},"resets_at":1}}\n`)
      await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0), { timeout: 3000, interval: 50 })
      await new Promise((r) => setTimeout(r, 400))
      expect(seen).toHaveLength(1)
      expect(seen[0]![0]).toBe('p1')
      expect(seen[0]![1]).toContain('"used_percentage":2')
    } finally {
      ev.stop()
    }
  })

  it('감시 없이도 주기 읽기로 상태 파일 변화를 알리고, 시작 때 남아 있던 파일 · 같은 파일은 다시 알리지 않는다', async () => {
    const dir = join(root, 'agent-events')
    mkdirSync(dir)
    writeFileSync(join(dir, 'old.status'), 'v1\t\t{}\n') // 받은 시각을 모르는 지난 값
    const seen: Array<[string, string]> = []
    const ev = new AgentEvents({ dir, onSignal: () => {}, onStatus: (p, t) => seen.push([p, t]), pollMs: 100, watch: false })
    ev.start()
    try {
      writeFileSync(join(dir, 'p1.status'), 'v1\t\t{"a":1}\n')
      await vi.waitFor(() => expect(seen).toEqual([['p1', 'v1\t\t{"a":1}\n']]), { timeout: 3000, interval: 50 })
      await new Promise((r) => setTimeout(r, 500))
      expect(seen).toHaveLength(1)
      writeFileSync(join(dir, 'p1.status'), 'v1\t\t{"a":22}\n')
      await vi.waitFor(() => expect(seen.at(-1)).toEqual(['p1', 'v1\t\t{"a":22}\n']), { timeout: 3000, interval: 50 })
      expect(seen.some(([p]) => p === 'old')).toBe(false)
    } finally {
      ev.stop()
    }
  })
})

describe('UsageStore', () => {
  const snap = (at: number, used: number, resetsAt = 9_999_999_999_999): UsageSnapshot => ({ fiveHour: { used, resetsAt }, at, source: 'chat' })

  it('더 새 값만 받아 0600 으로 저장하고, 다시 열면 읽는다 · 바뀐 값만 알린다', () => {
    const file = join(root, 'usage.json')
    const changes: number[] = []
    const s = new UsageStore(file, (map) => changes.push(map['default-claude']!.at), () => 100)
    expect(s.put('default-claude', snap(10, 5))).toBe(true)
    expect(s.put('default-claude', snap(5, 50))).toBe(false) // 늦게 온 옛 값
    expect(s.put('default-claude', snap(11, 5))).toBe(false) // 같은 값
    expect(changes).toEqual([10])
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(new UsageStore(file, () => {}, () => 100).get()).toEqual({ 'default-claude': snap(10, 5) })
  })

  it('90% 를 새로 넘은 창을 알린다', () => {
    const crossed: string[] = []
    const s = new UsageStore(join(root, 'u.json'), (_m, c) => crossed.push(...c.map((x) => `${x.account}:${x.key}`)), () => 100)
    s.put('default-claude', snap(1, 80))
    s.put('default-claude', snap(2, 91))
    s.put('default-claude', snap(3, 95))
    expect(crossed).toEqual(['default-claude:fiveHour'])
  })

  it('깨진 파일은 빈 값으로 시작한다', () => {
    const file = join(root, 'usage.json')
    writeFileSync(file, '{ nope')
    expect(new UsageStore(file, () => {}, () => 1).get()).toEqual({})
  })
})

describe('계정 매핑', () => {
  it('추가 계정 폴더면 그 id, 아니면 기본 계정', () => {
    const acc = '/u/accounts'
    expect(claudeAccountId(`${acc}/claude/0d1f8a2e-1111-4222-8333-944445555666`, acc)).toBe('0d1f8a2e-1111-4222-8333-944445555666')
    expect(claudeAccountId('', acc)).toBe('default-claude')
    expect(claudeAccountId(undefined, acc)).toBe('default-claude')
    expect(claudeAccountId('/elsewhere/claude', acc)).toBe('default-claude')
    expect(claudeAccountId(`${acc}/claude/../../x`, acc)).toBe('default-claude')
  })
})

describe('대화 원천', () => {
  it('rate_limit_event 의 정보를 onUsage 로 넘긴다(허용 상태여도)', () => {
    const got: unknown[] = []
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: Object.assign(new EventEmitter(), { write: () => true, end: () => {} }),
      kill: () => true,
    }) as unknown as ChildLike & { stdout: EventEmitter }
    const s = new ClaudeSession({ bin: 'claude', env: {}, cwd: '/tmp', permission: 'ask', spawn: () => child, onEvent: () => {}, onExit: () => {}, onUsage: (info) => got.push(info) })
    s.send('hi')
    const info = { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 5 } } }
    child.stdout.emit('data', JSON.stringify({ type: 'rate_limit_event', rate_limit_info: info }) + '\n')
    expect(got).toEqual([info])
  })
})
