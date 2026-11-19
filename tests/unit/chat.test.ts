import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  agentCard,
  chatPermissionArgs,
  chatStatus,
  claudeArgs,
  claudeLineToEvents,
  foldBlocks,
  isChatEvent,
  isDangerousTool,
  openAgents,
  redactEvent,
  type ChatBlock,
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

// 68단계: 하위 에이전트 — 재료는 claude 2.1.325 실측 두 번(2026-11-19)을 줄인 것(subagent = 도구 없이, subagent-tools = Read 두 번)
describe('하위 에이전트 (68단계)', () => {
  const AGENT = 'toolu_014snkHA3ARALyjLSgu5q1pt'
  const card = (blocks: ChatBlock[]) => {
    const b = blocks.find((x) => x.kind === 'agent')
    if (!b || b.kind !== 'agent') throw new Error('Agent 카드 없음')
    return b.item
  }
  it('부모 단 tool_use 는 본 흐름 도구 줄이 되지 않고, 그 Agent 카드 아래에 개수와 함께', () => {
    const ev = eventsOf('subagent-tools')
    expect(ev.filter((e) => e.t === 'tool').map((e) => e.t === 'tool' && [e.name, e.parent])).toEqual([
      ['Agent', undefined],
      ['Read', AGENT],
      ['Read', AGENT],
    ])
    // 하위 에이전트에게 준 지시 · 하위 글은 본 글이 아니다
    expect(ev.filter((e) => e.t === 'text').map((e) => e.t === 'text' && e.text)).toEqual(['Subagent replied: `5`'])
    const blocks = foldBlocks(ev)
    expect(blocks.map((b) => b.kind)).toEqual(['agent', 'text', 'done'])
    const item = card(blocks)
    expect(item).toMatchObject({ id: AGENT, name: 'Agent', summary: 'Count lines in a.txt and b.txt' })
    expect(item.sub.map((s) => [s.name, s.summary, s.state])).toEqual([
      ['Read', 'a.txt', 'ok'],
      ['Read', 'b.txt', 'ok'],
    ])
  })
  it('task_progress 가 카드 진행(하는 일 · 도구 N번 · 마지막 도구 · 걸린 시간)을 바꾼다', () => {
    const ev = eventsOf('subagent-tools')
    const progress = ev.filter((e) => e.t === 'agent' && e.phase === 'progress')
    expect(progress).toHaveLength(2)
    const first = card(foldBlocks(ev.slice(0, ev.indexOf(progress[0]!) + 1)))
    expect(agentCard(first)).toEqual({ tone: 'run', label: '진행 중', progress: 'Reading a.txt · 도구 1번 · 마지막 Read · 1초', summary: '' })
    const second = card(foldBlocks(ev.slice(0, ev.indexOf(progress[1]!) + 1)))
    expect(second.agent).toMatchObject({ status: 'run', doing: 'Reading b.txt', tools: 2, last: 'Read', ms: 1811 })
    expect(second.sub).toHaveLength(1) // 두 번째 Read 는 아직 안 옴
  })
  it('task_notification 이 상태와 summary 를 채운다 — 끝나면 하는 일은 지운다', () => {
    const item = card(foldBlocks(eventsOf('subagent-tools')))
    expect(item.agent).toMatchObject({ status: 'done', summary: '5', tools: 2, ms: 4666, bg: false })
    expect(agentCard(item)).toEqual({ tone: 'ok', label: '✓ 끝남', progress: '도구 2번 · 마지막 Read · 4초', summary: '5' })
    // 도구 없이 답한 하위 에이전트
    const pong = card(foldBlocks(eventsOf('subagent')))
    expect(pong.sub).toEqual([])
    expect(agentCard(pong)).toEqual({ tone: 'ok', label: '✓ 끝남', progress: '1초', summary: 'PONG' })
  })
  it('summary 는 1000자로 자르고, 화면 · 디스크 사본에서 비밀값을 가린다', () => {
    const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'
    const line = { type: 'system', subtype: 'task_notification', task_id: 't', tool_use_id: 'A', status: 'failed', summary: `키 ${key} ` + 'x'.repeat(3000), usage: { total_tokens: 1, tool_uses: 3, duration_ms: 65000 } }
    const [ev] = claudeLineToEvents(line, CWD)
    expect(ev).toMatchObject({ t: 'agent', id: 'A', phase: 'end', status: 'fail', tools: 3, ms: 65000 })
    expect(ev && ev.t === 'agent' && ev.summary!.length).toBe(1000)
    expect(JSON.stringify(redactEvent(ev!))).not.toContain(key)
    const prog = claudeLineToEvents({ type: 'system', subtype: 'task_progress', tool_use_id: 'A', description: `cat ${key}`, last_tool_name: 'Bash', usage: { tool_uses: 1, duration_ms: 1 } }, CWD)[0]!
    expect(JSON.stringify(redactEvent(prog))).not.toContain(key)
  })
  it('모르는 tool_use_id 의 사건 · 부모를 모르는 도구는 버린다 — Agent 아닌 도구(백그라운드 셸)에도 붙지 않는다', () => {
    const base: ChatEvent[] = [
      { t: 'user', text: 'a', at: 1 },
      { t: 'tool', id: 'B1', name: 'Bash', summary: 'npm run dev' },
      { t: 'tool_end', id: 'B1', ok: true, tail: '' },
    ]
    const noise: ChatEvent[] = [
      { t: 'agent', id: 'zzz', phase: 'start', bg: true },
      { t: 'tool', id: 'R9', name: 'Read', summary: 'x.ts', parent: 'nope' },
      { t: 'tool_end', id: 'R9', ok: true, tail: '' },
      { t: 'agent', id: 'B1', phase: 'end', status: 'done', summary: '셸 끝남' },
    ]
    expect(foldBlocks([...base, ...noise])).toEqual(foldBlocks(base))
    // 실측 줄에서 task_updated(tool_use_id 없음)는 사건이 되지 않는다
    expect(claudeLineToEvents({ type: 'system', subtype: 'task_updated', task_id: 't', patch: { status: 'completed' } }, CWD)).toEqual([])
  })
  it('백그라운드: 턴이 끝나고 다음 글을 보낸 뒤 온 알림도 맞는 카드를 채운다 — 그 전엔 tool_end 가 와도 진행 중', () => {
    const ev: ChatEvent[] = [
      { t: 'user', text: '뒤에서 세어 줘', at: 1 },
      { t: 'tool', id: 'A1', name: 'Agent', summary: '세기' },
      { t: 'agent', id: 'A1', phase: 'start', bg: true },
      { t: 'tool_end', id: 'A1', ok: true, tail: 'Async agent launched' },
      { t: 'text', text: '맡겼어요' },
      { t: 'turn_end', ok: true, ms: 10, reason: 'completed' },
      { t: 'user', text: '다른 일', at: 2 },
      { t: 'tool', id: 'A1-r', name: 'Read', summary: 'a.txt', parent: 'A1' },
      { t: 'agent', id: 'A1', phase: 'end', status: 'done', summary: '3줄', tools: 1, ms: 9000 },
    ]
    const before = card(foldBlocks(ev.slice(0, 7)))
    expect(agentCard(before)).toMatchObject({ tone: 'run', label: '진행 중' })
    const blocks = foldBlocks(ev)
    expect(blocks.map((b) => b.kind)).toEqual(['user', 'agent', 'text', 'done', 'user'])
    const after = card(blocks)
    expect(after.sub.map((s) => s.name)).toEqual(['Read'])
    expect(agentCard(after)).toMatchObject({ tone: 'ok', summary: '3줄' })
    expect(openAgents(ev.slice(0, 7))).toEqual(['A1'])
    expect(openAgents(ev)).toEqual([])
  })
  it('멈춤은 포그라운드 카드를 멈춤으로(백그라운드는 그대로), 갑자기 끝남은 모두 멈춤으로', () => {
    const ev: ChatEvent[] = [
      { t: 'user', text: 'a', at: 1 },
      { t: 'tool', id: 'F', name: 'Task', summary: '앞' },
      { t: 'agent', id: 'F', phase: 'start' },
      { t: 'tool', id: 'G', name: 'Agent', summary: '뒤' },
      { t: 'agent', id: 'G', phase: 'start', bg: true },
    ]
    const tones = (e: ChatEvent[]) => foldBlocks(e).flatMap((b) => (b.kind === 'agent' ? [agentCard(b.item).label] : []))
    expect(tones([...ev, { t: 'stopped' }])).toEqual(['멈춤', '진행 중'])
    expect(tones([...ev, { t: 'error', kind: 'crash', message: 'x' }])).toEqual(['멈춤', '멈춤'])
    // 포그라운드는 알림 없이 tool_end 만 와도 끝난다
    expect(tones([...ev, { t: 'tool_end', id: 'F', ok: false, tail: '' }])).toEqual(['✕ 실패', '진행 중'])
  })
  it('옛 기록(68단계 전): 모든 줄이 그대로 읽히고, Agent 없는 기록은 접은 결과가 전과 같다', () => {
    // 0.2.0 이 쓴 모양 — 하위 에이전트 도구(R1)는 parent 없이 본 흐름에 섞여 기록됐다
    const OLD = [
      '{"t":"user","text":"세어 줘","at":1}',
      '{"t":"session","id":"s1","model":"claude-haiku-5-5"}',
      '{"t":"tool","id":"A1","name":"Agent","summary":"Count lines"}',
      '{"t":"tool","id":"R1","name":"Read","summary":"a.txt"}',
      '{"t":"tool_end","id":"R1","ok":true,"tail":"1\\talpha"}',
      '{"t":"tool_end","id":"A1","ok":true,"tail":"agentId: x\\n<usage>tool_uses: 1</usage>"}',
      '{"t":"text","text":"5 줄"}',
      '{"t":"tool","id":"B1","name":"Bash","summary":"npm test"}',
      '{"t":"tool_end","id":"B1","ok":false,"tail":"1 failed"}',
      '{"t":"turn_end","ok":true,"ms":4000,"reason":"completed","ctxPct":3,"anchor":"u-9"}',
    ].map((l) => JSON.parse(l) as unknown)
    expect(OLD.every(isChatEvent)).toBe(true)
    const old = OLD as ChatEvent[]
    // Agent 없는 부분: 68단계 전 코드로 접은 결과(2026-11-19 캡처) + 빈 sub
    const noAgent = old.filter((e) => !('id' in e) || (e.id !== 'A1' && e.id !== 'R1'))
    expect(foldBlocks(noAgent)).toEqual([
      { kind: 'user', key: '0', text: '세어 줘', images: [], index: 0, at: 1 },
      { kind: 'text', key: '2', text: '5 줄' },
      { kind: 'tools', key: '3', items: [{ id: 'B1', name: 'Bash', summary: 'npm test', state: 'err', tail: '1 failed', sub: [] }] },
      { kind: 'done', key: '5', ms: 4000 },
    ])
    // Agent 가 있는 옛 기록: 진행 없는 카드(끝 3줄은 그대로) · 섞여 기록된 Read 는 부모를 몰라 본 흐름에 남는다
    const blocks = foldBlocks(old)
    expect(blocks.map((b) => b.kind)).toEqual(['user', 'agent', 'tools', 'text', 'tools', 'done'])
    const a = card(blocks)
    expect(a.agent).toBeUndefined()
    expect(agentCard(a)).toEqual({ tone: 'ok', label: '✓ 끝남', progress: '', summary: '' })
  })
  it('isChatEvent: 모양이 틀린 agent · parent 줄은 버린다', () => {
    expect(isChatEvent({ t: 'agent', id: 'a', phase: 'end', status: 'done', summary: 's', tools: 1, ms: 2, bg: false, doing: '', last: 'Read' })).toBe(true)
    expect(isChatEvent({ t: 'tool', id: 'r', name: 'Read', summary: 'a', parent: 'a' })).toBe(true)
    for (const bad of [
      { t: 'agent', id: 'a', phase: 'zzz' },
      { t: 'agent', id: 1, phase: 'end' },
      { t: 'agent', id: 'a', phase: 'end', status: 'weird' },
      { t: 'agent', id: 'a', phase: 'progress', tools: '2' },
      { t: 'agent', id: 'a', phase: 'progress', summary: 3 },
      { t: 'tool', id: 'r', name: 'Read', summary: 'a', parent: 5 },
    ])
      expect(isChatEvent(bad)).toBe(false)
  })
})
