import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { codexNoteToEvents, codexPolicy, codexRequestToEvents, foldBlocks, rewindPlan, type ChatEvent } from '../../src/shared/chat'

const CWD = '/tmp/work'
interface Line {
  dir: 'in' | 'out'
  msg: { id?: number; method?: string; params?: unknown; result?: unknown }
}
const fixture = (name: string): Line[] =>
  readFileSync(join(__dirname, '../fixtures/codex', `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Line)
const notes = (name: string) => fixture(name).filter((l) => l.dir === 'in' && l.msg.method && l.msg.id === undefined)

describe('codexNoteToEvents — 스파이크 fixture (로그인 없음)', () => {
  it('401 로 실패한 턴 → 로그인 오류 + 실패한 턴 끝(anchor = turn id)', () => {
    const done = notes('image-interrupt-fork').find((l) => l.msg.method === 'turn/completed' && JSON.stringify(l.msg.params).includes('"failed"'))!
    const ev = codexNoteToEvents(done.msg.method!, done.msg.params, CWD)
    expect(ev[0]).toMatchObject({ t: 'error', kind: 'login' })
    expect(ev[1]).toMatchObject({ t: 'turn_end', ok: false, anchor: expect.stringMatching(/^01a1c8e8/) })
  })
  it('멈춘 턴(interrupted) → stopped', () => {
    const done = notes('image-interrupt-fork').find((l) => l.msg.method === 'turn/completed' && JSON.stringify(l.msg.params).includes('"interrupted"'))!
    expect(codexNoteToEvents(done.msg.method!, done.msg.params, CWD)).toEqual([{ t: 'stopped' }])
  })
  it('다시 시도 중 오류(willRetry) · 경고 · 사용자 글 · 상태 알림은 이벤트가 없다', () => {
    for (const l of notes('nologin')) {
      if (l.msg.method === 'turn/completed') continue
      expect(codexNoteToEvents(l.msg.method!, l.msg.params, CWD)).toEqual([])
    }
  })
})

describe('codexNoteToEvents — 항목 (타입 모양, 로그인 필요라 미확인)', () => {
  const started = (item: object) => codexNoteToEvents('item/started', { threadId: 't', turnId: 'u', item }, CWD)
  const completed = (item: object) => codexNoteToEvents('item/completed', { threadId: 't', turnId: 'u', item }, CWD)
  it('글은 끝난 agentMessage 하나로(조각 delta 는 안 씀)', () => {
    expect(completed({ type: 'agentMessage', id: 'm1', text: '안녕하세요' })).toEqual([{ t: 'text', text: '안녕하세요' }])
    expect(started({ type: 'agentMessage', id: 'm1', text: '' })).toEqual([])
    expect(codexNoteToEvents('item/agentMessage/delta', { delta: '안' }, CWD)).toEqual([])
  })
  it('명령 실행: 시작 → Bash 줄, 끝 → 종료 코드 0 이면 ok · 꼬리', () => {
    expect(started({ type: 'commandExecution', id: 'c1', command: 'npm test', status: 'inProgress' })).toEqual([{ t: 'tool', id: 'c1', name: 'Bash', summary: 'npm test' }])
    expect(completed({ type: 'commandExecution', id: 'c1', command: 'npm test', status: 'completed', exitCode: 0, aggregatedOutput: 'a\nb\nc\nd\n' })).toEqual([{ t: 'tool_end', id: 'c1', ok: true, tail: 'b\nc\nd' }])
    expect(completed({ type: 'commandExecution', id: 'c2', command: 'false', status: 'failed', exitCode: 1, aggregatedOutput: '' })[0]).toMatchObject({ ok: false })
    expect(completed({ type: 'commandExecution', id: 'c3', command: 'x', status: 'completed', exitCode: 2, aggregatedOutput: null })[0]).toMatchObject({ ok: false })
  })
  it('파일 바꿈: 폴더 기준 경로', () => {
    expect(started({ type: 'fileChange', id: 'f1', changes: [{ path: '/tmp/work/a.ts', kind: { type: 'update' }, diff: '' }, { path: '/tmp/work/b.ts', kind: { type: 'add' }, diff: '' }], status: 'inProgress' })).toEqual([
      { t: 'tool', id: 'f1', name: 'Edit', summary: 'a.ts, b.ts' },
    ])
    expect(completed({ type: 'fileChange', id: 'f1', changes: [], status: 'completed' })).toEqual([{ t: 'tool_end', id: 'f1', ok: true, tail: '' }])
  })
  it('잘 끝난 턴 → 턴 끝(걸린 시간 · anchor · 대화 창 %)', () => {
    const ev = codexNoteToEvents('turn/completed', { threadId: 't', turn: { id: 'turn-9', status: 'completed', durationMs: 1500, error: null } }, CWD, { ctxPct: 12 })
    expect(ev).toEqual([{ t: 'turn_end', ok: true, ms: 1500, reason: 'completed', anchor: 'turn-9', ctxPct: 12 }])
  })
  it('한도 오류(usageLimitExceeded) → limit', () => {
    const ev = codexNoteToEvents('turn/completed', { threadId: 't', turn: { id: 'u', status: 'failed', error: { message: 'You hit your usage limit', codexErrorInfo: 'usageLimitExceeded' } } }, CWD)
    expect(ev[0]).toMatchObject({ t: 'error', kind: 'limit' })
  })
})

describe('codexRequestToEvents — 승인 · 질문', () => {
  it('명령 승인 → Bash 허락 카드, 위험 명령 · 폴더 밖 cwd 는 danger', () => {
    expect(codexRequestToEvents('item/commandExecution/requestApproval', 7, { threadId: 't', turnId: 'u', itemId: 'c1', command: 'touch a', cwd: CWD, reason: '파일 만들기' }, CWD)).toEqual([
      { t: 'permission', id: '7', tool: 'Bash', summary: 'touch a', why: '파일 만들기', danger: false },
    ])
    expect(codexRequestToEvents('item/commandExecution/requestApproval', 8, { command: 'rm -rf build', cwd: CWD }, CWD)[0]).toMatchObject({ danger: true })
    expect(codexRequestToEvents('item/commandExecution/requestApproval', 9, { command: 'ls', cwd: '/etc' }, CWD)[0]).toMatchObject({ danger: true })
  })
  it('파일 승인 → Edit 카드, 폴더 밖 grantRoot 는 danger', () => {
    expect(codexRequestToEvents('item/fileChange/requestApproval', 3, { reason: 'a.ts 고치기' }, CWD)[0]).toMatchObject({ t: 'permission', tool: 'Edit', summary: 'a.ts 고치기', danger: false })
    expect(codexRequestToEvents('item/fileChange/requestApproval', 4, { grantRoot: '/Users/x' }, CWD)[0]).toMatchObject({ danger: true })
  })
  it('질문 → 질문 카드 (선택지 없으면 빈 목록)', () => {
    const ev = codexRequestToEvents('item/tool/requestUserInput', 5, { questions: [{ id: 'q1', header: '색', question: '어느 색?', isOther: true, isSecret: false, options: [{ label: '빨강', description: '' }] }, { id: 'q2', header: '', question: '이름?', isOther: true, isSecret: false, options: null }] }, CWD)
    expect(ev).toEqual([
      {
        t: 'question',
        id: '5',
        questions: [
          { question: '어느 색?', header: '색', multi: false, options: [{ label: '빨강', description: '' }] },
          { question: '이름?', header: '', multi: false, options: [] },
        ],
      },
    ])
  })
  it('모르는 요청은 이벤트가 없다', () => {
    expect(codexRequestToEvents('item/tool/call', 1, {}, CWD)).toEqual([])
  })
})

describe('codexPolicy — 허락 방식 → approvalPolicy · sandbox', () => {
  it('ask · edits · auto', () => {
    expect(codexPolicy('ask')).toEqual({ approvalPolicy: 'untrusted', sandbox: 'workspace-write' })
    expect(codexPolicy('edits')).toEqual({ approvalPolicy: 'on-request', sandbox: 'workspace-write' })
    expect(codexPolicy('auto')).toEqual({ approvalPolicy: 'never', sandbox: 'workspace-write' })
  })
})

describe('rewindPlan — 되감기 · 나누기', () => {
  const ev: ChatEvent[] = [
    { t: 'session', id: 's1' },
    { t: 'user', text: '첫 글', at: 1 },
    { t: 'text', text: '답 1' },
    { t: 'turn_end', ok: true, ms: 1, reason: 'completed', anchor: 'a1' },
    { t: 'user', text: '둘째 글', at: 2 },
    { t: 'text', text: '답 2' },
    { t: 'turn_end', ok: true, ms: 1, reason: 'completed', anchor: 'a2' },
    { t: 'user', text: '셋째 ‹가림:sk-ant…›', at: 3 },
    { t: 'text', text: '답 3' },
    { t: 'turn_end', ok: true, ms: 1, reason: 'completed', anchor: 'a3' },
  ]
  it('되감기: 그 메시지 앞까지 남기고 앞 턴의 anchor 에서 갈라진다 · 글을 입력창에', () => {
    expect(rewindPlan(ev, 4, 'rewind')).toEqual({ keep: 4, forkAt: 'a1', refill: '둘째 글', removed: 4 })
  })
  it('첫 메시지로 되감으면 갈라질 곳이 없다(새 세션) · 세션 이벤트는 남긴다', () => {
    expect(rewindPlan(ev, 1, 'rewind')).toEqual({ keep: 1, forkAt: null, refill: '첫 글', removed: 6 })
  })
  it('가린 글이 든 메시지는 입력창에 다시 넣지 않는다', () => {
    expect(rewindPlan(ev, 7, 'rewind')).toMatchObject({ keep: 7, forkAt: 'a2', refill: null, masked: true })
  })
  it('나누기: 그 메시지의 턴 끝까지 남기고 그 턴의 anchor 에서 갈라진다', () => {
    expect(rewindPlan(ev, 4, 'branch')).toEqual({ keep: 7, forkAt: 'a2', refill: null, removed: 0 })
  })
  it('사용자 메시지가 아닌 자리 · 끝나지 않은 턴의 나누기는 null', () => {
    expect(rewindPlan(ev, 2, 'rewind')).toBeNull()
    expect(rewindPlan(ev, 99, 'rewind')).toBeNull()
    expect(rewindPlan([...ev, { t: 'user', text: '넷째', at: 4 }], 10, 'branch')).toBeNull()
  })
})

describe('foldBlocks — 22단계 더함', () => {
  it('사용자 블록에 이미지 이름 · 이벤트 자리(index)', () => {
    const b = foldBlocks([{ t: 'user', text: '봐 줘', at: 1, images: ['shot.png'] }])
    expect(b[0]).toMatchObject({ kind: 'user', text: '봐 줘', images: ['shot.png'], index: 0, at: 1 })
  })
})
