// 51단계: 터미널 에이전트 상태 훅 — 기록 줄 해석 · 사건 → 상태 · 훅 스크립트(실제 /bin/sh) · 설정 JSON.
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CLAUDE_HOOK_EVENTS,
  agentPhase,
  claudeHookScript,
  claudeHookSettings,
  codexNotifyArg,
  codexNotifyScript,
  codexHasNotify,
  parseAgentLine,
  shQuote,
  splitLines,
} from '../../src/shared/agent-hooks'

let dir: string
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-hooks-')))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('기록 줄 해석', () => {
  it('v1 줄을 사건으로 바꾸고 시각은 ms 로', () => {
    expect(parseAgentLine('v1\t1794809955\tclaude\tUserPromptSubmit\t')).toEqual({ agent: 'claude', phase: 'working', at: 1794809955000 })
    expect(parseAgentLine('v1\t1794809955\tclaude\tNotification\tpermission_prompt')).toEqual({ agent: 'claude', phase: 'permission', at: 1794809955000 })
    expect(parseAgentLine('v1\t1794809955\tcodex\tagent-turn-complete\t')).toEqual({ agent: 'codex', phase: 'done', at: 1794809955000 })
  })
  it('모르는 판 · 에이전트 · 사건 · 칸 수 · 숫자 아닌 시각은 버린다', () => {
    for (const line of [
      'v2\t1\tclaude\tStop\t',
      'v1\t1\tgemini\tStop\t',
      'v1\t1\tclaude\tSubagentStop\t',
      'v1\t1\tclaude\tStop',
      'v1\t1\tclaude\tStop\t\textra',
      'v1\tabc\tclaude\tStop\t',
      'v1\t\tclaude\tStop\t',
      '',
    ]) expect(parseAgentLine(line), JSON.stringify(line)).toBeNull()
  })
  it('줄바꿈 앞까지만 줄로 보고 반쪽 줄은 남긴다', () => {
    expect(splitLines('a\nb\nc')).toEqual({ lines: ['a', 'b'], rest: 'c' })
    expect(splitLines('a\n')).toEqual({ lines: ['a'], rest: '' })
    expect(splitLines('half')).toEqual({ lines: [], rest: 'half' })
  })
})

describe('사건 → 에이전트 상태', () => {
  it.each([
    ['UserPromptSubmit', '', 'working'],
    ['PreToolUse', '', 'working'],
    ['PostToolUse', '', 'working'],
    ['PostToolUseFailure', '', 'working'],
    ['PermissionRequest', '', 'permission'],
    ['Notification', 'permission_prompt', 'permission'],
    ['Notification', 'idle_prompt', 'input'],
    ['Notification', 'elicitation_dialog', 'input'],
    ['Stop', '', 'done'],
    ['StopFailure', '', 'failed'],
    ['SessionEnd', '', 'ended'],
    ['TaskminalExit', '', 'ended'],
  ])('claude %s %s → %s', (event, type, phase) => {
    expect(agentPhase('claude', event, type)).toBe(phase)
  })
  it('알 수 없는 알림 종류 · 다른 사건은 상태를 바꾸지 않는다', () => {
    expect(agentPhase('claude', 'Notification', 'auth_success')).toBeNull()
    expect(agentPhase('claude', 'SessionStart', '')).toBeNull()
    expect(agentPhase('codex', 'agent-turn-complete', '')).toBe('done')
    expect(agentPhase('codex', 'TaskminalExit', '')).toBe('ended')
    expect(agentPhase('codex', 'Stop', '')).toBeNull()
  })
  it('훅에 거는 사건은 모두 상태로 바뀐다(거는데 버리는 사건이 없다)', () => {
    for (const ev of CLAUDE_HOOK_EVENTS) {
      const type = ev === 'Notification' ? 'permission_prompt' : ''
      expect(agentPhase('claude', ev, type), ev).not.toBeNull()
    }
  })
})

const runHook = (script: string, stdin: string, env: Record<string, string>): { code: number | null; out: string } => {
  const r = spawnSync('/bin/sh', [script], { input: stdin, env: { PATH: '/usr/bin:/bin', ...env }, encoding: 'utf8', timeout: 10_000 })
  return { code: r.status, out: r.stdout + r.stderr }
}

describe('claude 훅 스크립트 (실제 /bin/sh)', () => {
  const setup = (): { script: string; log: string } => {
    const script = join(dir, 'claude-hook.sh')
    writeFileSync(script, claudeHookScript())
    chmodSync(script, 0o700)
    return { script, log: join(dir, 'p1.log') }
  }

  it('사건 이름 · 알림 종류만 한 줄로 덧붙이고, 출력 없이 0 으로 끝난다', () => {
    const { script, log } = setup()
    const a = runHook(script, JSON.stringify({ session_id: 's', hook_event_name: 'UserPromptSubmit', prompt: '비밀 계획 sk-ant-xxx' }), { TASKMINAL_AGENT_EVENTS: log })
    const b = runHook(script, JSON.stringify({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission' }), {
      TASKMINAL_AGENT_EVENTS: log,
    })
    expect([a, b]).toEqual([{ code: 0, out: '' }, { code: 0, out: '' }])
    const lines = readFileSync(log, 'utf8').split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[2]).toBe('')
    expect(parseAgentLine(lines[0]!)?.phase).toBe('working')
    expect(parseAgentLine(lines[1]!)?.phase).toBe('permission')
    // 프롬프트 · 알림 글은 디스크에 쓰지 않는다
    expect(readFileSync(log, 'utf8')).not.toMatch(/비밀|sk-ant|permission\b.*needs/)
  })

  it('도구 입력 글 안의 hook_event_name 글자에 속지 않는다', () => {
    const { script, log } = setup()
    const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_input: { content: '{"hook_event_name":"Stop","notification_type":"idle_prompt"}' } })
    runHook(script, input, { TASKMINAL_AGENT_EVENTS: log })
    const line = readFileSync(log, 'utf8').replace(/\n$/, '')
    expect(line).toMatch(/^v1\t\d+\tclaude\tPreToolUse\t$/)
  })

  it('기록 파일 변수가 없으면 아무것도 쓰지 않고 0, 큰 입력(1MB)도 다 읽고 끝난다', () => {
    const { script, log } = setup()
    expect(runHook(script, JSON.stringify({ hook_event_name: 'Stop' }), {})).toEqual({ code: 0, out: '' })
    expect(existsSync(log)).toBe(false)
    const big = JSON.stringify({ hook_event_name: 'PreToolUse', tool_input: { content: 'x'.repeat(1_000_000) } })
    expect(runHook(script, big, { TASKMINAL_AGENT_EVENTS: log })).toEqual({ code: 0, out: '' })
    expect(readFileSync(log, 'utf8')).toMatch(/\tPreToolUse\t\n$/)
  })

  it('기록 폴더가 사라졌어도 출력 없이 0 (claude 를 막지 않는다)', () => {
    const { script } = setup()
    expect(runHook(script, JSON.stringify({ hook_event_name: 'Stop' }), { TASKMINAL_AGENT_EVENTS: join(dir, 'gone', 'p.log') })).toEqual({ code: 0, out: '' })
  })
})

describe('codex 알림 스크립트 (실제 /bin/sh)', () => {
  it('턴 끝 JSON 인자에서 종류만 덧붙인다', () => {
    const script = join(dir, 'codex-notify.sh')
    writeFileSync(script, codexNotifyScript())
    chmodSync(script, 0o700)
    const log = join(dir, 'p2.log')
    const payload = JSON.stringify({ type: 'agent-turn-complete', 'thread-id': 't', 'last-assistant-message': '{"type":"other"} 비밀' })
    const r = spawnSync('/bin/sh', [script, payload], { env: { PATH: '/usr/bin:/bin', TASKMINAL_AGENT_EVENTS: log }, encoding: 'utf8' })
    expect([r.status, r.stdout + r.stderr]).toEqual([0, ''])
    const line = readFileSync(log, 'utf8').replace(/\n$/, '')
    expect(parseAgentLine(line)).toMatchObject({ agent: 'codex', phase: 'done' })
    expect(line).not.toContain('비밀')
  })
})

describe('훅 설정', () => {
  it('claude 설정 JSON 은 거는 사건마다 훅 명령 · statusLine 을 두고, 공백 · 따옴표 경로도 sh 로 그대로 불린다', () => {
    const sub = join(dir, "Application Support", "it's")
    execFileSync('/bin/mkdir', ['-p', sub])
    const hook = join(sub, 'claude-hook.sh')
    writeFileSync(hook, '#!/bin/sh\necho ran\n')
    chmodSync(hook, 0o700)
    const settings = JSON.parse(claudeHookSettings(hook, join(sub, 'claude-statusline.sh')))
    expect(Object.keys(settings.hooks).sort()).toEqual([...CLAUDE_HOOK_EVENTS].sort())
    const cmd: string = settings.hooks.Stop[0].hooks[0].command
    expect(execFileSync('/bin/sh', ['-c', cmd], { encoding: 'utf8' })).toBe('ran\n')
    expect(settings.statusLine).toMatchObject({ type: 'command' })
    expect(claudeHookSettings(hook)).not.toContain('statusLine')
  })

  it('codex -c 값은 TOML 배열 하나', () => {
    expect(codexNotifyArg('/a b/codex-notify.sh')).toBe('notify=["/a b/codex-notify.sh"]')
    expect(codexNotifyArg('/a"b\\c')).toBe('notify=["/a\\"b\\\\c"]')
  })

  it('사용자 codex 설정에 맨 위 notify 가 있을 때만 있다고 본다', () => {
    expect(codexHasNotify('model = "x"\nnotify = ["a"]\n[tui]\n')).toBe(true)
    expect(codexHasNotify('  notify=["a"]')).toBe(true)
    expect(codexHasNotify('[tui]\nnotify = ["a"]\n')).toBe(false)
    expect(codexHasNotify('# notify = ["a"]\nmodel = "x"')).toBe(false)
    expect(codexHasNotify('')).toBe(false)
  })

  it('셸 따옴표', () => {
    expect(shQuote("a b'c")).toBe("'a b'\\''c'")
  })
})
