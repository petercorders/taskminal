import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  chatPermissionArgs,
  chatStatus,
  claudeArgs,
  claudeLineToEvents,
  foldBlocks,
  isDangerousTool,
  redactEvent,
  type ChatEvent,
} from '../../src/shared/chat'

const CWD = '/tmp/proj'
function fixture(name: string): unknown[] {
  return readFileSync(join(__dirname, '../fixtures/claude', `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { dir: string; line: unknown })
    .filter((x) => x.dir === 'out')
    .map((x) => x.line)
}
const eventsOf = (name: string): ChatEvent[] => fixture(name).flatMap((o) => claudeLineToEvents(o, CWD))

describe('claudeLineToEvents — 스파이크 fixture', () => {
  it('Bash 허락 없이: 세션 · 도구 시작/끝 · 글 · 턴 끝(사용량 %)', () => {
    const ev = eventsOf('bash-allow')
    expect(ev[0]).toMatchObject({ t: 'session', id: expect.any(String), model: 'claude-haiku-5-5' })
    const tool = ev.find((e) => e.t === 'tool')
    expect(tool).toMatchObject({ name: 'Bash', summary: 'echo spike-ok-21' })
    expect(ev.find((e) => e.t === 'tool_end')).toMatchObject({ ok: true, tail: 'spike-ok-21' })
    expect(ev.find((e) => e.t === 'text')).toMatchObject({ text: 'done' })
    const end = ev.find((e) => e.t === 'turn_end')
    expect(end).toMatchObject({ ok: true, reason: 'completed' })
    expect(end && end.t === 'turn_end' && end.ctxPct).toBeGreaterThanOrEqual(0)
  })
  it('허락 요청: Write 는 파일 경로(폴더 기준), Bash 는 명령 · 이유', () => {
    const perms = eventsOf('write-deny').filter((e) => e.t === 'permission')
    expect(perms).toHaveLength(2)
    expect(perms[0]).toMatchObject({ tool: 'Write', summary: 'note21.txt', danger: false })
    expect(perms[1]).toMatchObject({ tool: 'Bash', summary: 'touch made21.txt', why: expect.stringContaining('made21') })
  })
  it('질문: AskUserQuestion 은 질문 카드로(선택지 · 설명)', () => {
    const q = eventsOf('ask').find((e) => e.t === 'question')
    expect(q).toMatchObject({ questions: [{ question: 'Which color do you prefer?', header: 'Color', multi: false, options: [{ label: 'Red' }, { label: 'Blue' }] }] })
    expect(eventsOf('ask').some((e) => e.t === 'permission')).toBe(false)
  })
  it('멈춤(interrupt): 실패가 아니라 stopped', () => {
    const ev = eventsOf('interrupt')
    expect(ev.some((e) => e.t === 'stopped')).toBe(true)
    expect(ev.some((e) => e.t === 'turn_end' && !e.ok)).toBe(false)
    // '[Request interrupted by user]' 같은 user 글은 화면에 넣지 않는다
    expect(ev.some((e) => e.t === 'user')).toBe(false)
  })
  it('로그인 없음: login 오류 하나 · 같은 턴의 실패 띠는 따로 안 보임', () => {
    const ev = eventsOf('noauth')
    expect(ev.filter((e) => e.t === 'error')).toEqual([expect.objectContaining({ kind: 'login' })])
    const blocks = foldBlocks(ev)
    expect(blocks.filter((b) => b.kind === 'band')).toHaveLength(1)
  })
  it('한도 거절은 limit 오류(풀리는 시각 ms), 허용은 아무것도 아님', () => {
    const allowed = { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1794384600 } }
    expect(claudeLineToEvents(allowed, CWD)).toEqual([])
    const rejected = { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1794384600, rateLimitType: 'five_hour' } }
    expect(claudeLineToEvents(rejected, CWD)).toEqual([expect.objectContaining({ t: 'error', kind: 'limit', resetsAt: 1794384600000 })])
  })
  it('모양이 틀린 줄은 버린다', () => {
    expect(claudeLineToEvents(null, CWD)).toEqual([])
    expect(claudeLineToEvents({ type: 'assistant', message: { content: 'x' } }, CWD)).toEqual([])
    expect(claudeLineToEvents({ type: 'control_request', request: { subtype: 'can_use_tool' } }, CWD)).toEqual([])
  })
})

describe('위험 도구', () => {
  it('위험 명령 · 폴더 밖 쓰기는 위험', () => {
    expect(isDangerousTool('Bash', { command: 'rm -rf build' }, CWD)).toBe(true)
    expect(isDangerousTool('Bash', { command: 'git push --force' }, CWD)).toBe(true)
    expect(isDangerousTool('Bash', { command: 'npm test' }, CWD)).toBe(false)
    expect(isDangerousTool('Write', { file_path: '/tmp/proj/a.txt' }, CWD)).toBe(false)
    expect(isDangerousTool('Write', { file_path: '/etc/hosts' }, CWD)).toBe(true)
    expect(isDangerousTool('Edit', { file_path: '/tmp/project2/a' }, CWD)).toBe(true)
    expect(isDangerousTool('Bash', { command: 'ls' }, CWD, '/Users/me/x')).toBe(true)
  })
})

describe('foldBlocks', () => {
  const base: ChatEvent[] = [
    { t: 'user', text: '고쳐 줘', at: 1 },
    { t: 'text', text: '볼게요' },
    { t: 'tool', id: 'a', name: 'Read', summary: 'a.ts' },
    { t: 'tool_end', id: 'a', ok: true, tail: '' },
    { t: 'tool', id: 'b', name: 'Bash', summary: 'npm test' },
    { t: 'tool_end', id: 'b', ok: false, tail: '1 failed' },
    { t: 'text', text: '고쳤어요' },
  ]
  it('이어진 도구는 한 묶음(이름별 수 · 실패 표시), 글이 끼면 새 묶음', () => {
    const blocks = foldBlocks(base)
    expect(blocks.map((b) => b.kind)).toEqual(['user', 'text', 'tools', 'text'])
    const tools = blocks[2]!
    expect(tools.kind === 'tools' && tools.items.map((i) => i.state)).toEqual(['ok', 'err'])
  })
  it('허락 카드는 답이 오면 굳는다 · 답 없이 끝나면 lost', () => {
    const ev: ChatEvent[] = [...base, { t: 'permission', id: 'r1', tool: 'Bash', summary: 'rm x', why: '', danger: true }]
    expect(foldBlocks(ev).at(-1)).toMatchObject({ kind: 'permission', answer: null })
    expect(foldBlocks([...ev, { t: 'answered', id: 'r1', how: 'deny' }]).at(-1)).toMatchObject({ kind: 'permission', answer: 'deny' })
    expect(foldBlocks([...ev, { t: 'error', kind: 'crash', message: 'x', code: 1 }]).find((b) => b.kind === 'permission')).toMatchObject({ answer: 'lost' })
  })
  it('실패한 턴 끝은 실패 띠 · 성공은 끝남 줄', () => {
    expect(foldBlocks([...base, { t: 'turn_end', ok: false, ms: 3000, reason: 'api_error' }]).at(-1)).toMatchObject({ kind: 'band', tone: 'err' })
    expect(foldBlocks([...base, { t: 'turn_end', ok: true, ms: 3000, reason: 'completed' }]).at(-1)).toMatchObject({ kind: 'done', ms: 3000 })
  })
})

describe('chatStatus', () => {
  it('새 대화 → 실행 중 → 기다림 → 끝남 / 실패 / 멈춤', () => {
    expect(chatStatus([]).state).toBe('new')
    const run: ChatEvent[] = [{ t: 'user', text: 'x', at: 100 }]
    expect(chatStatus(run)).toEqual({ state: 'run', since: 100 })
    expect(chatStatus([...run, { t: 'question', id: 'q', questions: [] }]).state).toBe('wait')
    expect(chatStatus([...run, { t: 'question', id: 'q', questions: [] }, { t: 'answered', id: 'q', how: 'answer' }]).state).toBe('run')
    expect(chatStatus([...run, { t: 'turn_end', ok: true, ms: 5, reason: 'completed' }])).toMatchObject({ state: 'done', ms: 5 })
    expect(chatStatus([...run, { t: 'turn_end', ok: false, ms: 5, reason: 'api_error' }]).state).toBe('fail')
    expect(chatStatus([...run, { t: 'error', kind: 'crash', message: '', code: 1 }]).state).toBe('fail')
    expect(chatStatus([...run, { t: 'stopped' }]).state).toBe('stopped')
  })
})

describe('인자 · 허락 방식', () => {
  it('허락 방식 → --permission-mode', () => {
    expect(chatPermissionArgs('ask')).toEqual(['--permission-mode', 'default'])
    expect(chatPermissionArgs('edits')).toEqual(['--permission-mode', 'acceptEdits'])
    expect(chatPermissionArgs('auto')).toEqual(['--permission-mode', 'auto'])
  })
  it('세션이 있으면 --resume', () => {
    expect(claudeArgs('ask')).not.toContain('--resume')
    const a = claudeArgs('auto', 'abc-1')
    expect(a.slice(a.indexOf('--resume'), a.indexOf('--resume') + 2)).toEqual(['--resume', 'abc-1'])
    expect(a).toEqual(expect.arrayContaining(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--permission-prompt-tool', 'stdio']))
  })
})

describe('redactEvent', () => {
  const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'
  it('글 · 명령 · 결과 · 질문의 비밀값을 가린다', () => {
    for (const ev of [
      { t: 'text', text: `키 ${key}` },
      { t: 'user', text: key, at: 1 },
      { t: 'tool', id: 'a', name: 'Bash', summary: `echo ${key}` },
      { t: 'tool_end', id: 'a', ok: true, tail: key },
      { t: 'permission', id: 'r', tool: 'Bash', summary: `curl -H ${key}`, why: key, danger: false },
      { t: 'question', id: 'q', questions: [{ question: key, header: '', multi: false, options: [{ label: key, description: key }] }] },
      { t: 'error', kind: 'other', message: key },
    ] as ChatEvent[]) {
      expect(JSON.stringify(redactEvent(ev))).not.toContain(key)
    }
  })
})
