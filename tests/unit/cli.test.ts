import { describe, expect, it } from 'vitest'
import { cliSocketPath, formatRows, isCliRequest, listRows, parseArgs, parseDuration, parseUiReply, resolvePane, resolveTask, type CliRequest } from '../../src/shared/cli'
import { addTab, createTask, emptyState, renameTab, splitActivePane } from '../../src/shared/model'
import type { AppState, Task } from '../../src/shared/types'

let n = 0
const newId = () => `id${++n}`

function mk(name: string): Task {
  return createTask({ name, cwd: '~/w', templateId: null, statusId: 'doing', groupId: null, color: null }, emptyState().settings, newId, 0)
}

function req(argv: string[]): CliRequest {
  const p = parseArgs(argv)
  if (p.kind !== 'request') throw new Error(`요청이 아님: ${JSON.stringify(p)}`)
  return p.req
}
const usageOf = (argv: string[]) => {
  const p = parseArgs(argv)
  return p.kind === 'usage' ? p.error : null
}

describe('parseDuration', () => {
  it('단위 · 기본 초 · 틀린 값', () => {
    expect(parseDuration('10m')).toBe(600_000)
    expect(parseDuration('30s')).toBe(30_000)
    expect(parseDuration('1h')).toBe(3_600_000)
    expect(parseDuration('500ms')).toBe(500)
    expect(parseDuration('90')).toBe(90_000)
    expect(parseDuration('abc')).toBeNull()
    expect(parseDuration('25h')).toBeNull()
  })
})

describe('parseArgs', () => {
  it('도움말 · 버전', () => {
    expect(parseArgs([]).kind).toBe('help')
    expect(parseArgs(['help']).kind).toBe('help')
    expect(parseArgs(['--version']).kind).toBe('version')
  })

  it('- 로 시작하는 글은 -- 뒤에 — 모르는 옵션이면 그렇게 하라고 알려 준다 (24 리뷰)', () => {
    const bad = parseArgs(['chat', 'send', 'p', '--- 요약'])
    expect(bad).toMatchObject({ kind: 'usage', error: expect.stringContaining('-- 를 두고') })
    expect(parseArgs(['chat', 'send', 'p', '--', '--- 요약'])).toMatchObject({ kind: 'request', req: { op: 'chat.send', pane: 'p', text: '--- 요약' } })
  })

  it('list · --json 은 어디에 있어도', () => {
    expect(parseArgs(['list', '--json'])).toEqual({ kind: 'request', req: { op: 'list' }, json: true })
    expect(parseArgs(['--json', 'list'])).toEqual({ kind: 'request', req: { op: 'list' }, json: true })
    expect(parseArgs(['list'])).toEqual({ kind: 'request', req: { op: 'list' }, json: false })
  })

  it('task 명령들', () => {
    expect(req(['task', 'new', '배포', '--cwd', '/tmp', '--status=대기'])).toEqual({ op: 'task.new', name: '배포', cwd: '/tmp', status: '대기' })
    expect(req(['task', 'move', '--status', '완료'])).toEqual({ op: 'task.move', status: '완료' })
    expect(req(['task', 'move', 'UX', '--group', '찍계부'])).toEqual({ op: 'task.move', task: 'UX', group: '찍계부' })
    expect(req(['task', 'rename', '새 이름'])).toEqual({ op: 'task.rename', name: '새 이름' })
    expect(req(['task', 'rename', 'UX', '새 이름'])).toEqual({ op: 'task.rename', task: 'UX', name: '새 이름' })
    expect(req(['task', 'color', '#aabbcc'])).toEqual({ op: 'task.color', color: '#aabbcc' })
    expect(req(['task', 'remove', 'x', '--force'])).toEqual({ op: 'task.remove', task: 'x', force: true })
    expect(req(['task', 'note', '시험 고칠 것'])).toEqual({ op: 'task.note', text: '시험 고칠 것' })
    expect(req(['task', 'open'])).toEqual({ op: 'task.open' })
  })

  it('pane 명령들', () => {
    expect(req(['pane', 'split', '--down', '--cmd', 'npm test'])).toEqual({ op: 'pane.split', dir: 'down', cmd: 'npm test' })
    expect(req(['pane', 'split'])).toEqual({ op: 'pane.split', dir: 'right' })
    expect(req(['pane', 'send', 'p1', 'y', '--enter'])).toEqual({ op: 'pane.send', pane: 'p1', text: 'y', enter: true })
    expect(req(['pane', 'read', 'p1', '--lines', '3'])).toEqual({ op: 'pane.read', pane: 'p1', lines: 3 })
    expect(req(['pane', 'wait', 'p1', '--for', 'exit', '--timeout', '10m'])).toEqual({ op: 'pane.wait', pane: 'p1', for: { kind: 'exit' }, timeoutMs: 600_000, quietMs: 3000 })
    expect(req(['pane', 'wait', 'p1', '--for', 'text:BUILD OK'])).toMatchObject({ for: { kind: 'text', text: 'BUILD OK' } })
  })

  it('-- 뒤는 글 (-- 로 시작하는 글을 보낼 때)', () => {
    expect(req(['pane', 'send', 'p1', '--', '--help'])).toEqual({ op: 'pane.send', pane: 'p1', text: '--help', enter: false })
  })

  it('chat · notify', () => {
    expect(req(['chat', 'new', '시험 고쳐 줘'])).toEqual({ op: 'chat.new', agent: 'claude', where: 'right', text: '시험 고쳐 줘' })
    expect(req(['chat', 'new', '--agent', 'codex', '--tab', '--task', 'UX', '봐 줘'])).toEqual({ op: 'chat.new', agent: 'codex', where: 'tab', task: 'UX', text: '봐 줘' })
    expect(req(['chat', 'wait', '--all', '--timeout', '30m'])).toEqual({ op: 'chat.wait', panes: [], all: true, timeoutMs: 1_800_000 })
    expect(req(['chat', 'wait', 'a', 'b'])).toEqual({ op: 'chat.wait', panes: ['a', 'b'], all: false, timeoutMs: 1_800_000 })
    expect(req(['notify', '--task', '배포', '빌드 깨짐'])).toEqual({ op: 'notify', task: '배포', text: '빌드 깨짐' })
  })

  it('사용법 오류', () => {
    expect(usageOf(['nope'])).toContain('모르는 명령')
    expect(usageOf(['task'])).toContain('뒤에 할 일')
    expect(usageOf(['task', 'move'])).toContain('--status')
    expect(usageOf(['pane', 'wait', 'p1'])).toContain('--for')
    expect(usageOf(['pane', 'wait', 'p1', '--for', 'soon'])).toContain('idle')
    expect(usageOf(['pane', 'wait', 'p1', '--for', 'exit', '--timeout', 'x'])).toContain('--timeout')
    expect(usageOf(['pane', 'read', 'p1', '--lines', '0'])).toContain('1~1000')
    expect(usageOf(['pane', 'split', '--right', '--down'])).toContain('하나만')
    expect(usageOf(['pane', 'send', 'p1'])).toContain('모자라요')
    expect(usageOf(['notify', 'a', 'b'])).toContain('따옴표')
    expect(usageOf(['list', '--bogus'])).toContain('--bogus')
    expect(usageOf(['task', 'color', 'red'])).toContain('#rrggbb')
    expect(usageOf(['chat', 'wait'])).toContain('--all')
    expect(usageOf(['chat', 'new', '--agent', 'gpt', 'x'])).toContain('claude')
    expect(usageOf(['pane', 'send', 'p', 'x', '--enter=1'])).toContain('값을 받지')
  })
})

describe('isCliRequest', () => {
  it('해석한 요청은 모두 통과', () => {
    const all: string[][] = [
      ['list'],
      ['task', 'new', 'a'],
      ['task', 'move', '--status', 's'],
      ['task', 'remove'],
      ['tab', 'new', '--cmd', 'ls'],
      ['pane', 'split', '--cmd', 'x'],
      ['pane', 'send', 'p', 't'],
      ['pane', 'read', 'p'],
      ['pane', 'wait', 'p', '--for', 'text:x'],
      ['notify', 'x'],
      ['chat', 'new', 'x'],
      ['chat', 'send', 'p', 'x'],
      ['chat', 'wait', '--all'],
      ['chat', 'read', 'p'],
    ]
    for (const a of all) expect(isCliRequest({ ...req(a), self: 'p-1' }), a.join(' ')).toBe(true)
  })

  it('모양이 틀리면 거절', () => {
    expect(isCliRequest(null)).toBe(false)
    expect(isCliRequest({ op: 'rm -rf' })).toBe(false)
    expect(isCliRequest({ op: 'list', self: '../x' })).toBe(false)
    expect(isCliRequest({ op: 'task.new', name: '  ' })).toBe(false)
    expect(isCliRequest({ op: 'pane.read', pane: 'p', lines: 5000 })).toBe(false)
    expect(isCliRequest({ op: 'pane.wait', pane: 'p', for: { kind: 'later' }, timeoutMs: 1, quietMs: 100 })).toBe(false)
    expect(isCliRequest({ op: 'pane.wait', pane: 'p', for: { kind: 'idle' }, timeoutMs: 1e12, quietMs: 100 })).toBe(false)
    expect(isCliRequest({ op: 'chat.new', agent: 'x', where: 'tab', text: 'a' })).toBe(false)
    expect(isCliRequest({ op: 'task.color', color: 'javascript:' })).toBe(false)
    expect(isCliRequest({ op: 'task.move', task: 'a' })).toBe(false) // 옮길 곳(상태 · 묶음)이 없다
  })
})

describe('resolveTask · resolvePane', () => {
  function state(): AppState {
    const s = emptyState()
    const a = mk('배포')
    const b = mk('UX 평가')
    const c = mk('ux 평가') // 대소문자만 다름
    s.tasks = [a, b, c]
    return s
  }

  it('생략하면 부른 터미널의 일감, 터미널이 일감 밖이면 오류', () => {
    const s = state()
    const self = Object.keys(s.tasks[0]!.panes)[0]
    expect(resolveTask(s, undefined, self)).toMatchObject({ ok: true, value: { name: '배포' } })
    expect(resolveTask(s, undefined, undefined)).toMatchObject({ ok: false })
    expect(resolveTask(s, undefined, 'unknown')).toMatchObject({ ok: false })
  })

  it('id · 같은 이름 · 대소문자 무시 · 겹치면 후보', () => {
    const s = state()
    expect(resolveTask(s, s.tasks[1]!.id, undefined)).toMatchObject({ ok: true, value: { name: 'UX 평가' } })
    expect(resolveTask(s, 'UX 평가', undefined)).toMatchObject({ ok: true, value: { id: s.tasks[1]!.id } })
    expect(resolveTask(s, '배포', undefined)).toMatchObject({ ok: true })
    const r = resolveTask(s, 'Ux 평가', undefined)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.candidates).toHaveLength(2)
    expect(resolveTask(s, '없음', undefined)).toMatchObject({ ok: false, error: expect.stringContaining('찾지 못했') })
  })

  it('pane: id · 일감(활성 pane) · 일감:탭 이름 · 번호 · 없는 탭은 후보', () => {
    const s = state()
    let t = s.tasks[0]!
    t = addTab(t, newId)
    t = renameTab(t, t.activeTabId!, '서버')
    t = splitActivePane(t, 'down', newId)
    s.tasks[0] = t
    const second = t.tabs[1]!
    expect(resolvePane(s, '배포', undefined)).toEqual({ ok: true, value: { taskId: t.id, tabId: second.id, paneId: second.activePaneId } })
    expect(resolvePane(s, '배포:1', undefined)).toMatchObject({ ok: true, value: { tabId: t.tabs[0]!.id } })
    expect(resolvePane(s, '배포:서버', undefined)).toMatchObject({ ok: true, value: { paneId: second.activePaneId } })
    const firstPane = t.tabs[0]!.activePaneId
    expect(resolvePane(s, firstPane, undefined)).toMatchObject({ ok: true, value: { tabId: t.tabs[0]!.id, paneId: firstPane } })
    const miss = resolvePane(s, '배포:없는탭', undefined)
    expect(miss.ok).toBe(false)
    if (!miss.ok) expect(miss.candidates).toHaveLength(2)
    expect(resolvePane(s, undefined, firstPane)).toMatchObject({ ok: true, value: { paneId: firstPane } })
    expect(resolvePane(s, undefined, undefined)).toMatchObject({ ok: false })
    expect(resolvePane(s, 'Ux 평가', undefined)).toMatchObject({ ok: false, candidates: expect.any(Array) })
  })
})

describe('listRows · formatRows', () => {
  it('확인 필요 → 실패 → 실행 중 → 끝남 순, 명령 가림, ← 여기', () => {
    const s = emptyState()
    const a = mk('A')
    const b = mk('B')
    const c = mk('C')
    s.tasks = [a, b, c]
    const pa = Object.keys(a.panes)[0]!
    const pb = Object.keys(b.panes)[0]!
    const pc = Object.keys(c.panes)[0]!
    const rows = listRows(
      s,
      {
        [pa]: { state: 'running', busy: true, attention: false, command: 'TOKEN=sk-x vitest', startedAt: 0 },
        [pb]: { state: 'waiting', busy: false, attention: true, message: '질문' },
        [pc]: { state: 'failed', busy: false, attention: false, exitCode: 1, command: 'gradlew' },
      },
      pa,
      61_000,
      (x) => x.replace('sk-x', '‹가림›'),
    )
    expect(rows.map((r) => [r.task, r.activity])).toEqual([
      ['B', 'attention'],
      ['C', 'failed'],
      ['A', 'running'],
    ])
    expect(rows[2]).toMatchObject({ command: 'TOKEN=‹가림› vitest', detail: '1분 1초째', here: true })
    expect(rows[1]!.detail).toBe('✗ exit 1')
    const text = formatRows(rows)
    expect(text.split('\n')).toHaveLength(3)
    expect(text).toContain('← 여기')
    expect(text).toContain('확인 필요')
    expect(formatRows([])).toBe('일감이 없어요')
  })
})

describe('cliSocketPath', () => {
  it('짧으면 userData 안, 길면 tmp', () => {
    expect(cliSocketPath('/Users/me/Library/Application Support/Taskminal', '/tmp', () => 'abc')).toBe('/Users/me/Library/Application Support/Taskminal/cli.sock')
    const long = '/x/' + 'y'.repeat(120)
    expect(cliSocketPath(long, '/tmp/', () => '0123456789abcdef0123')).toBe('/tmp/taskminal-0123456789abcdef-cli.sock')
  })
})

describe('parseUiReply', () => {
  const target = { paneId: 'p1', label: 'A › b', kind: 'chat', cwd: '/x', pending: false, chat: { agent: 'claude' } }
  it('맞는 모양만', () => {
    expect(parseUiReply({ ok: true, text: 'x', target })).not.toBeNull()
    expect(parseUiReply({ ok: false, error: 'e', candidates: ['a'] })).not.toBeNull()
    expect(parseUiReply({ ok: true, target: { ...target, paneId: '../x' } })).toBeNull()
    expect(parseUiReply({ ok: true, targets: [{ ...target, kind: 'shell' }] })).toBeNull()
    expect(parseUiReply({ ok: false })).toBeNull()
    expect(parseUiReply({ ok: true, exit: 999 })).toBeNull()
    expect(parseUiReply('ok')).toBeNull()
  })
})
