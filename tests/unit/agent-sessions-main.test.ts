import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync, appendFileSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentSessions, sessionRoots, type SessionRoot } from '../../src/main/agent-sessions'
import { HEAD_BYTES } from '../../src/shared/agent-sessions'

// 가짜 기록만 쓴다 — 실제 ~/.claude · ~/.codex 를 읽지 않는다.
let dir: string
let roots: SessionRoot[]
const uuid = (n: number) => `${n.toString(16).padStart(8, '0')}-2222-4333-8444-555555555555`
const jsonl = (...rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
const claudeFile = (n: number, opts: { cwd?: string; text?: string; mtime?: number; project?: string; body?: string } = {}) => {
  const project = join(dir, 'claude', 'projects', opts.project ?? '-tmp-proj')
  mkdirSync(project, { recursive: true })
  const path = join(project, `${uuid(n)}.jsonl`)
  writeFileSync(path, opts.body ?? jsonl({ type: 'session-owner', sessionId: uuid(n) }, { type: 'user', cwd: opts.cwd ?? dir, timestamp: new Date(1000 * n).toISOString(), message: { role: 'user', content: opts.text ?? `가짜 질문 ${n}` } }))
  const t = (opts.mtime ?? n) + 1_000_000
  utimesSync(path, t, t)
  return path
}
const codexFile = (n: number, opts: { cwd?: string; text?: string; source?: unknown; mtime?: number } = {}) => {
  const day = join(dir, 'codex', 'sessions', '2026', '02', '01')
  mkdirSync(day, { recursive: true })
  const path = join(day, `rollout-2026-02-01T00-00-00-${uuid(n)}.jsonl`)
  writeFileSync(path, jsonl({ type: 'session_meta', payload: { id: uuid(n), cwd: opts.cwd ?? dir, timestamp: '2026-02-01T00:00:00.000Z', source: opts.source ?? 'cli' } }, { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: opts.text ?? `가짜 코덱스 ${n}` }] } }))
  const t = (opts.mtime ?? n) + 1_000_000
  utimesSync(path, t, t)
  return path
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tm-agent-sessions-'))
  roots = [
    { agent: 'claude', dir: join(dir, 'claude', 'projects'), account: 'default-claude' },
    { agent: 'codex', dir: join(dir, 'codex', 'sessions'), account: 'default-codex' },
  ]
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('목록', () => {
  test('두 공급자 · 최신순 · 마지막 시각 = mtime · 공급자마다 300개', async () => {
    for (let i = 1; i <= 302; i++) claudeFile(i)
    codexFile(1, { mtime: 500 })
    const s = new AgentSessions(() => roots)
    const r = await s.list()
    const claude = r.sessions.filter((x) => x.agent === 'claude')
    expect(claude).toHaveLength(300)
    expect(claude[0]!.id).toBe(uuid(302))
    expect(claude.some((x) => x.id === uuid(1))).toBe(false)
    expect(r.sessions[0]).toMatchObject({ agent: 'codex', id: uuid(1), summary: '가짜 코덱스 1', updatedAt: (500 + 1_000_000) * 1000 })
  })
  test('파일마다 앞 256KB 만 — 그 뒤의 첫 글은 읽지 않는다', async () => {
    const body = jsonl({ type: 'user', cwd: dir, isMeta: true, message: { role: 'user', content: '<local-command-caveat>x</local-command-caveat>' } }, { type: 'attachment', pad: 'x'.repeat(HEAD_BYTES) }, { type: 'user', cwd: dir, message: { role: 'user', content: 'LATE-가짜-글' } })
    claudeFile(1, { body })
    const r = await new AgentSessions(() => roots).list()
    expect(r.sessions).toHaveLength(1)
    expect(r.sessions[0]!.summary).toBe('')
  })
  test('가린 뒤 160자 · 공백 접기 · 설정을 바꾸면 다음 목록에 바로', async () => {
    claudeFile(1, { text: `열쇠 INTERNAL-ABCDEF\n\n${'가'.repeat(400)}` })
    let custom = [{ name: '내부', pattern: 'INTERNAL-[A-Z]{6}' }]
    const s = new AgentSessions(() => roots, () => ({ custom }))
    const first = (await s.list()).sessions[0]!
    expect(first.summary).not.toContain('INTERNAL-ABCDEF')
    expect(first.summary.startsWith('열쇠 ‹가림:내부› 가')).toBe(true)
    expect(first.summary.length).toBeLessThanOrEqual(160)
    custom = []
    expect((await s.list()).sessions[0]!.summary).toContain('INTERNAL-ABCDEF')
  })
  test('손상 줄 · 빈 파일 · 세션 아닌 파일은 건너뛰고 수만 센다 · 하위 에이전트는 빼고 따로 센다 · 심볼릭 링크는 읽지 않는다', async () => {
    claudeFile(1, { body: '{broken\n' + jsonl({ type: 'user', cwd: dir, message: { role: 'user', content: '가짜' } }) })
    claudeFile(2, { body: '' })
    claudeFile(3, { body: jsonl({ type: 'summary' }) })
    codexFile(4, { source: { subagent: { thread_spawn: {} } } })
    symlinkSync(claudeFile(5), join(dir, 'claude', 'projects', '-tmp-proj', `${uuid(6)}.jsonl`))
    const r = await new AgentSessions(() => roots).list()
    expect(r.sessions.map((x) => x.id).sort()).toEqual([uuid(1), uuid(5)])
    expect(r.badLines).toBe(1)
    expect(r.skipped).toBe(3) // 빈 파일 · cwd 없음 · 링크
    expect(r.subagents).toBe(1)
  })
  test('(경로 · mtime · 크기) 캐시 — 바뀌지 않은 파일은 다시 읽지 않는다', async () => {
    const path = claudeFile(1)
    claudeFile(2)
    const s = new AgentSessions(() => roots)
    await s.list()
    expect(s.reads).toBe(2)
    await s.list()
    expect(s.reads).toBe(2)
    appendFileSync(path, jsonl({ type: 'assistant' }))
    utimesSync(path, 3_000_000, 3_000_000)
    await s.list()
    expect(s.reads).toBe(3)
  })
  test('읽기는 한 번에 하나 — 동시에 부르면 같은 결과를 기다린다', async () => {
    claudeFile(1)
    const s = new AgentSessions(() => roots)
    const [a, b] = await Promise.all([s.list(), s.list()])
    expect(a).toBe(b)
    expect(s.reads).toBe(1)
  })
  test('루트가 없으면 빈 목록 (오류 아님)', async () => {
    const r = await new AgentSessions(() => [{ agent: 'claude', dir: join(dir, 'nope'), account: 'default-claude' }]).list()
    expect(r.sessions).toEqual([])
  })
})

describe('이어 하기 대상 — main 이 id 로 다시 찾는다', () => {
  test('잘못된 id · pane · 방식은 막는다', async () => {
    const s = new AgentSessions(() => roots)
    await expect(s.target({ agent: 'claude', id: `${uuid(1)};rm -rf ~`, paneId: 'p1', how: 'chat' })).rejects.toThrow('세션')
    await expect(s.target({ agent: 'gpt' as 'claude', id: uuid(1), paneId: 'p1', how: 'chat' })).rejects.toThrow()
    await expect(s.target({ agent: 'claude', id: uuid(1), paneId: '../x', how: 'chat' })).rejects.toThrow()
    await expect(s.target({ agent: 'claude', id: uuid(1), paneId: 'p1', how: 'shell' as 'chat' })).rejects.toThrow()
  })
  test('목록을 안 불렀어도 찾고, 폴더 · 계정을 돌려준다', async () => {
    const work = join(dir, 'work')
    mkdirSync(work)
    claudeFile(1, { cwd: work })
    const r = await new AgentSessions(() => roots).target({ agent: 'claude', id: uuid(1), paneId: 'p1', how: 'chat' })
    expect(r).toEqual({ agent: 'claude', sessionId: uuid(1), cwd: work, account: 'default-claude', paneId: 'p1', how: 'chat' })
  })
  test('세션 폴더가 없으면 막고 안내', async () => {
    claudeFile(1, { cwd: join(dir, 'gone') })
    await expect(new AgentSessions(() => roots).target({ agent: 'claude', id: uuid(1), paneId: 'p1', how: 'terminal' })).rejects.toThrow('폴더')
  })
  test('목록 뒤 기록 파일이 사라지면 막고 안내', async () => {
    const path = claudeFile(1)
    const s = new AgentSessions(() => roots)
    await s.list()
    rmSync(path)
    rmdirSync(join(dir, 'claude', 'projects', '-tmp-proj'))
    await expect(s.target({ agent: 'claude', id: uuid(1), paneId: 'p1', how: 'chat' })).rejects.toThrow('찾지 못했어요')
  })
  test('같은 세션을 같은 프레임에 두 번 — main 도 하나로 (첫 요청의 pane 만)', async () => {
    claudeFile(1)
    const s = new AgentSessions(() => roots)
    const [a, b] = await Promise.all([
      s.target({ agent: 'claude', id: uuid(1), paneId: 'p1', how: 'chat' }),
      s.target({ agent: 'claude', id: uuid(1), paneId: 'p2', how: 'chat' }),
    ])
    expect(a).toBe(b)
    expect(b.paneId).toBe('p1')
  })
})

describe('루트', () => {
  const accounts = [{ id: 'aaaaaaaa-0000-4000-8000-000000000000', agent: 'claude' as const, name: '회사' }, { id: 'bbbbbbbb-0000-4000-8000-000000000000', agent: 'codex' as const, name: '개인' }]
  test('기본 ~/.claude/projects · ~/.codex/sessions + 추가 계정 폴더', () => {
    expect(sessionRoots({}, '/Users/me', accounts, '/data/accounts')).toEqual([
      { agent: 'claude', dir: '/Users/me/.claude/projects', account: 'default-claude' },
      { agent: 'codex', dir: '/Users/me/.codex/sessions', account: 'default-codex' },
      { agent: 'claude', dir: `/data/accounts/claude/${accounts[0]!.id}/projects`, account: accounts[0]!.id, accountName: '회사' },
      { agent: 'codex', dir: `/data/accounts/codex/${accounts[1]!.id}/sessions`, account: accounts[1]!.id, accountName: '개인' },
    ])
  })
  test('시험용 루트는 TASKMINAL_USER_DATA 가 있을 때만 받는다', () => {
    expect(sessionRoots({ TASKMINAL_AGENT_SESSIONS_HOME: '/fake' }, '/Users/me', [], '/a')[0]!.dir).toBe('/Users/me/.claude/projects')
    expect(sessionRoots({ TASKMINAL_AGENT_SESSIONS_HOME: '/fake', TASKMINAL_USER_DATA: '/tmp/u' }, '/Users/me', [], '/a').map((r) => r.dir)).toEqual(['/fake/.claude/projects', '/fake/.codex/sessions'])
  })
})
