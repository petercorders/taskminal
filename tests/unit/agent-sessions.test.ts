import { describe, expect, test, vi } from 'vitest'
import {
  HEAD_BYTES,
  SUMMARY_MAX,
  SessionFeed,
  filterSessions,
  isSessionId,
  parseClaudeHead,
  parseCodexHead,
  resumeCommand,
  sessionAgo,
  summarize,
  withDeadline,
  type AgentSession,
} from '../../src/shared/agent-sessions'
import { addResumedChatTab } from '../../src/shared/model'
import { emptyState } from '../../src/shared/model'

// 모든 글은 직접 만든 가짜다 — 실제 기록의 글을 옮기지 않는다.
const ID = '11111111-2222-4333-8444-555555555555'
const line = (o: unknown) => JSON.stringify(o)
const claude = (...rows: unknown[]) => rows.map(line).join('\n') + '\n'

describe('세션 id — UUID 모양만 (명령 주입 방지)', () => {
  test('UUID 는 받고 셸 글자 · 길이 다른 것은 막는다', () => {
    expect(isSessionId(ID)).toBe(true)
    expect(isSessionId(ID.toUpperCase())).toBe(true)
    for (const bad of [`${ID}; rm -rf ~`, `$(${ID})`, ID.slice(1), '', 'sess-1', `${ID}\n`, ` ${ID}`, 1, null]) expect(isSessionId(bad)).toBe(false)
  })
  test('resumeCommand 는 id 를 검사하고 에이전트마다 다른 꼴', () => {
    expect(resumeCommand('claude', ID, 'claude')).toBe(`claude --resume ${ID}`)
    expect(resumeCommand('codex', ID, 'codex')).toBe(`codex resume ${ID}`)
    expect(() => resumeCommand('claude', `${ID};echo hi`, 'claude')).toThrow()
  })
})

describe('Claude 앞부분 해석', () => {
  test('세션 id 는 파일 이름 · cwd · 첫 사용자 글 · 시작 시각 — 메타 · 명령 · 도구 결과는 건너뛴다', () => {
    const text = claude(
      { type: 'session-owner', sessionId: ID },
      { type: 'user', isMeta: true, cwd: '/tmp/work', timestamp: '2026-01-02T03:04:05.000Z', message: { role: 'user', content: '<local-command-caveat>가짜</local-command-caveat>' } },
      { type: 'user', cwd: '/tmp/work', timestamp: '2026-01-02T03:04:06.000Z', message: { role: 'user', content: '<command-name>/clear</command-name>' } },
      { type: 'user', cwd: '/tmp/work', timestamp: '2026-01-02T03:04:07.000Z', message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] } },
      { type: 'user', cwd: '/tmp/work', timestamp: '2026-01-02T03:04:08.000Z', message: { role: 'user', content: [{ type: 'text', text: '가짜   첫\n질문' }] } },
      { type: 'user', cwd: '/tmp/work', message: { role: 'user', content: '두 번째' } },
    )
    const r = parseClaudeHead(text, `${ID}.jsonl`, false)
    expect(r.kind).toBe('session')
    if (r.kind !== 'session') return
    // 원문 조각 그대로 — 가리기(여러 줄 비밀값 포함) 뒤에 공백을 접는 것은 main 의 summarize
    expect(r.session).toMatchObject({ id: ID, cwd: '/tmp/work', text: '가짜   첫\n질문', startedAt: Date.parse('2026-01-02T03:04:05.000Z') })
    expect(summarize(r.session.text, (t) => t.replace('첫', '‹가림›'))).toBe('가짜 ‹가림› 질문')
    expect(summarize('가'.repeat(500), (t) => t)).toHaveLength(SUMMARY_MAX)
    expect(r.badLines).toBe(0)
  })
  test('손상 줄은 세고 건너뛴다 · 잘린 마지막 줄은 손상으로 세지 않는다', () => {
    const text = '{"type":"user", broken\n' + claude({ type: 'user', cwd: '/w', message: { role: 'user', content: 'hi' } }) + '{"type":"us'
    const r = parseClaudeHead(text, `${ID}.jsonl`, true)
    expect(r).toMatchObject({ kind: 'session', badLines: 1 })
  })
  test('슬래시 명령으로 시작한 세션은 명령 이름 + 인자 · 앞에 붙은 주입 블록은 걷어 낸 나머지', () => {
    const cmd = claude({ type: 'user', cwd: '/w', message: { role: 'user', content: '<command-message>run</command-message>\n<command-name>/run</command-name>\n<command-args>가짜 인자</command-args>' } })
    expect(parseClaudeHead(cmd, `${ID}.jsonl`, false)).toMatchObject({ kind: 'session', session: { text: '/run 가짜 인자' } })
    const reminder = claude({ type: 'user', cwd: '/w', message: { role: 'user', content: '<system-reminder>가짜 주입</system-reminder>\n가짜 본문' } })
    expect(parseClaudeHead(reminder, `${ID}.jsonl`, false)).toMatchObject({ kind: 'session', session: { text: '가짜 본문' } })
  })
  test('앞부분에 사용자 글이 없으면 사용자가 붙인 제목 > 자동 제목 > 마지막 프롬프트', () => {
    const base = { type: 'attachment', cwd: '/w' }
    expect(parseClaudeHead(claude(base, { type: 'last-prompt', lastPrompt: '가짜 마지막' }, { type: 'ai-title', aiTitle: '가짜 자동 제목' }), `${ID}.jsonl`, false)).toMatchObject({ session: { text: '가짜 자동 제목' } })
    expect(parseClaudeHead(claude(base, { type: 'custom-title', customTitle: '가짜 내 제목' }, { type: 'ai-title', aiTitle: 'x' }), `${ID}.jsonl`, false)).toMatchObject({ session: { text: '가짜 내 제목' } })
    expect(parseClaudeHead(claude(base, { type: 'last-prompt', lastPrompt: '가짜 마지막' }), `${ID}.jsonl`, false)).toMatchObject({ session: { text: '가짜 마지막' } })
    // 사용자 글이 있으면 그것이 먼저
    expect(parseClaudeHead(claude(base, { type: 'ai-title', aiTitle: 'x' }, { type: 'user', message: { role: 'user', content: '가짜 첫 글' } }), `${ID}.jsonl`, false)).toMatchObject({ session: { text: '가짜 첫 글' } })
  })
  test('파일 이름이 UUID 가 아니거나 cwd 가 없으면 세션이 아니다', () => {
    expect(parseClaudeHead(claude({ type: 'user', cwd: '/w', message: { role: 'user', content: 'x' } }), 'notes.jsonl', false).kind).toBe('skip')
    expect(parseClaudeHead(claude({ type: 'user', message: { role: 'user', content: 'x' } }), `${ID}.jsonl`, false).kind).toBe('skip')
    expect(parseClaudeHead('', `${ID}.jsonl`, false).kind).toBe('skip')
  })
})

describe('Codex 앞부분 해석', () => {
  const meta = (extra: Record<string, unknown> = {}) => ({ timestamp: '2026-02-01T00:00:00.000Z', type: 'session_meta', payload: { id: ID, cwd: '/tmp/cx', timestamp: '2026-02-01T00:00:01.000Z', source: 'cli', ...extra } })
  const user = (text: string) => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })
  test('첫 session_meta 의 id · cwd · 시각, 주입된 맥락 글은 건너뛴 첫 사용자 글', () => {
    const r = parseCodexHead(claude(meta(), user('<environment_context>가짜</environment_context>'), user('# AGENTS.md instructions for /x'), user('가짜 코덱스 질문'), { type: 'session_meta', payload: { id: '99999999-2222-4333-8444-555555555555', cwd: '/other', source: { subagent: {} } } }), `rollout-2026-02-01-${ID}.jsonl`, false)
    expect(r).toMatchObject({ kind: 'session', session: { id: ID, cwd: '/tmp/cx', text: '가짜 코덱스 질문', startedAt: Date.parse('2026-02-01T00:00:01.000Z') } })
  })
  test('하위 에이전트 파일은 따로 센다 · id 가 UUID 가 아니면 세션이 아니다', () => {
    expect(parseCodexHead(claude(meta({ source: { subagent: { thread_spawn: {} } } })), 'rollout-x.jsonl', false).kind).toBe('subagent')
    expect(parseCodexHead(claude(meta({ id: 'abc;rm' })), 'rollout-x.jsonl', false).kind).toBe('skip')
  })
  test('옛 event_msg user_message 도 첫 글로 받는다', () => {
    const r = parseCodexHead(claude(meta(), { type: 'event_msg', payload: { type: 'user_message', message: '옛 형식 가짜 글' } }), 'rollout-x.jsonl', false)
    expect(r).toMatchObject({ kind: 'session', session: { text: '옛 형식 가짜 글' } })
  })
})

describe('목록 거르기', () => {
  const s = (o: Partial<AgentSession>): AgentSession => ({ agent: 'claude', id: ID, cwd: '/a', summary: '', startedAt: 0, updatedAt: 0, account: 'default-claude', ...o })
  const list = [s({ id: 'a', cwd: '/proj', summary: '로그인 고치기', updatedAt: 3 }), s({ id: 'b', agent: 'codex', cwd: '/proj/sub', summary: '테스트 추가', updatedAt: 5 }), s({ id: 'c', cwd: '/projx', summary: '로그인 화면', updatedAt: 9 })]
  test('최신순 · 에이전트 · 범위(폴더 안쪽만, 접두어 같은 다른 폴더 제외) · 찾기(요약 · 폴더)', () => {
    expect(filterSessions(list, { query: '', agent: 'all', scope: 'all', folder: null }).map((x) => x.id)).toEqual(['c', 'b', 'a'])
    expect(filterSessions(list, { query: '', agent: 'all', scope: 'task', folder: '/proj' }).map((x) => x.id)).toEqual(['b', 'a'])
    expect(filterSessions(list, { query: '로그인', agent: 'claude', scope: 'all', folder: null }).map((x) => x.id)).toEqual(['c', 'a'])
    expect(filterSessions(list, { query: 'SUB', agent: 'all', scope: 'all', folder: null }).map((x) => x.id)).toEqual(['b'])
    expect(filterSessions(list, { query: '', agent: 'all', scope: 'task', folder: '/proj/' }).map((x) => x.id)).toEqual(['b', 'a'])
  })
  test('상대 시각', () => {
    expect(sessionAgo(1000, 1000 + 30_000)).toBe('방금')
    expect(sessionAgo(0, 5 * 60_000)).toBe('5분 전')
    expect(sessionAgo(0, 3 * 3_600_000)).toBe('3시간 전')
    expect(sessionAgo(0, 2 * 86_400_000)).toBe('2일 전')
    // 30일이 넘으면 날짜로 ('20726일 전' 대신)
    const old = Date.UTC(2026, 0, 2, 12)
    expect(sessionAgo(old, old + 40 * 86_400_000)).toBe(new Date(old).toLocaleDateString())
  })
  test('상수: 앞 256KB · 글 160자', () => {
    expect(HEAD_BYTES).toBe(256 * 1024)
    expect(SUMMARY_MAX).toBe(160)
  })
})

describe('SessionFeed — 옛 응답 · 한 번에 하나 · 안 보일 때 멈춤', () => {
  const deferred = <T,>() => {
    let resolve!: (v: T) => void
    const promise = new Promise<T>((r) => (resolve = r))
    return { promise, resolve }
  }
  test('느린 첫 요청 뒤 둘째 요청 — 첫 응답은 버리고 둘째만 화면에', async () => {
    const calls: Array<ReturnType<typeof deferred<string>>> = []
    const shown: string[] = []
    const feed = new SessionFeed(() => { const d = deferred<string>(); calls.push(d); return d.promise }, (r) => r.ok && shown.push(r.value))
    feed.request()
    feed.request()
    calls[0]!.resolve('old')
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    calls[1]!.resolve('new')
    await vi.waitFor(() => expect(shown).toEqual(['new']))
  })
  test('느린 읽기 중 요청 3번 → 동시에 도는 읽기 1 · 끝난 뒤 한 번 더', async () => {
    let running = 0, peak = 0, total = 0
    const gates: Array<() => void> = []
    const feed = new SessionFeed(async () => { running++; total++; peak = Math.max(peak, running); await new Promise<void>((r) => gates.push(r)); running--; return total }, () => {})
    feed.request()
    feed.request(); feed.request(); feed.request()
    gates.shift()!()
    await vi.waitFor(() => expect(gates).toHaveLength(1))
    gates.shift()!()
    await vi.waitFor(() => expect(running).toBe(0))
    expect(peak).toBe(1)
    expect(total).toBe(2)
  })
  test('안 보일 때는 읽지 않고, 다시 보이면 한 번 · 닫은 뒤 응답은 버린다', async () => {
    let total = 0
    const shown: number[] = []
    const gate = deferred<number>()
    const feed = new SessionFeed(() => { total++; return total === 2 ? gate.promise : Promise.resolve(total) }, (r) => r.ok && shown.push(r.value))
    feed.setVisible(false)
    feed.request(); feed.request()
    expect(total).toBe(0)
    feed.setVisible(true)
    await vi.waitFor(() => expect(shown).toEqual([1]))
    feed.request()
    feed.dispose()
    gate.resolve(2)
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
    expect(shown).toEqual([1])
  })
})

describe('withDeadline — 연결하는 중 15초 한도', () => {
  test('한도가 지나면 오류, 늦게 온 응답은 무시된다', async () => {
    vi.useFakeTimers()
    try {
      let resolve!: (v: string) => void
      const slow = new Promise<string>((r) => (resolve = r))
      const seen: string[] = []
      const p = withDeadline(slow, 15_000, '응답이 없어요').then((v) => seen.push(v))
      const failed = p.catch((e: Error) => e.message)
      await vi.advanceTimersByTimeAsync(14_999)
      expect(seen).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      await expect(failed).resolves.toBe('응답이 없어요')
      resolve('late')
      await vi.advanceTimersByTimeAsync(10)
      expect(seen).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
  test('한도 안 응답은 그대로', async () => {
    await expect(withDeadline(Promise.resolve(7), 15_000, 'x')).resolves.toBe(7)
  })
})

describe('대화로 이어 하기 탭', () => {
  test('새 탭에 sessionId 를 가진 대화 pane · 세션 폴더 · 제목', () => {
    const state = emptyState()
    const task = { id: 't', name: 'T', cwd: '/proj', statusId: 'doing', groupId: null, color: null, tabs: [], activeTabId: null, panes: {}, createdAt: 1 } as unknown as (typeof state.tasks)[number]
    const ids = ['tab-1', 'pane-1']
    const next = addResumedChatTab(task, () => ids.shift()!, 'codex', ID, '/proj/sub', '가짜 요약')
    expect(next.activeTabId).toBe('tab-1')
    expect(next.tabs.at(-1)).toMatchObject({ id: 'tab-1', title: '가짜 요약', activePaneId: 'pane-1' })
    expect(next.panes['pane-1']).toEqual({ id: 'pane-1', cwd: '/proj/sub', kind: 'chat', chat: { agent: 'codex', sessionId: ID } })
  })
})
