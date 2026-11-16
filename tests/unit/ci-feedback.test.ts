import { describe, expect, it } from 'vitest'
import { actionsIds, failedChecks, feedbackDraft, logTail, reviewNotes, type PrFeedback } from '../../src/shared/ci-feedback'

const REPO = 'o/r'
const run = (over: Record<string, unknown> = {}) => ({ __typename: 'CheckRun', name: 'build', workflowName: 'CI', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/o/r/actions/runs/111/job/222', ...over })

describe('actionsIds — 링크에서 숫자만', () => {
  it('같은 저장소의 Actions job 링크에서 run · job 번호를 꺼낸다', () => {
    expect(actionsIds('https://github.com/o/r/actions/runs/111/job/222', REPO)).toEqual({ runId: 111, jobId: 222 })
    expect(actionsIds('https://github.com/o/r/actions/runs/111/job/222?pr=7#step:3:1', REPO)).toEqual({ runId: 111, jobId: 222 })
  })
  it('다른 저장소 · 다른 호스트 · 숫자 아닌 조각 · 너무 큰 수는 버린다', () => {
    expect(actionsIds('https://github.com/x/r/actions/runs/111/job/222', REPO)).toBeNull()
    expect(actionsIds('https://example.com/o/r/actions/runs/111/job/222', REPO)).toBeNull()
    expect(actionsIds('https://github.com/o/r/actions/runs/1;rm -rf/job/2', REPO)).toBeNull()
    expect(actionsIds('https://github.com/o/r/actions/runs/--repo/job/2', REPO)).toBeNull()
    expect(actionsIds('https://github.com/o/r/actions/runs/99999999999999999999/job/2', REPO)).toBeNull()
    expect(actionsIds('https://github.com/o/r/actions/runs/111', REPO)).toBeNull()
  })
})

describe('failedChecks', () => {
  it('실패 · 오류 · 시간 초과만 고르고 통과 · 진행 중은 뺀다', () => {
    const list = failedChecks([
      run(),
      run({ name: 'lint', conclusion: 'SUCCESS' }),
      run({ name: 'slow', conclusion: null, status: 'IN_PROGRESS' }),
      run({ name: 'e2e', conclusion: 'TIMED_OUT', detailsUrl: 'https://github.com/o/r/actions/runs/5/job/6' }),
      { __typename: 'StatusContext', context: 'ci/circle', state: 'ERROR', targetUrl: 'https://circleci.com/x' },
      'junk',
      null,
    ], REPO)
    expect(list.map((c) => [c.name, c.workflow, c.runId, c.jobId])).toEqual([
      ['build', 'CI', 111, 222],
      ['e2e', 'CI', 5, 6],
      ['ci/circle', '', null, null],
    ])
    expect(list[2]!.url).toBe('https://circleci.com/x')
  })
  it('https 가 아닌 링크는 열 수 없게 비운다', () => {
    expect(failedChecks([run({ detailsUrl: 'javascript:alert(1)' })], REPO)[0]!.url).toBeNull()
    expect(failedChecks('nope', REPO)).toEqual([])
  })
})

describe('logTail', () => {
  const line = (i: number) => `build\tRun tests\t2026-11-13T16:01:26.2423400Z line ${i}`
  it('job · step · 시각 머리와 색 코드를 떼고 마지막 120줄만', () => {
    const raw = Array.from({ length: 300 }, (_, i) => line(i)).join('\n') + '\n'
    const out = logTail(raw)
    const lines = out.split('\n')
    expect(lines).toHaveLength(120)
    expect(lines[0]).toBe('line 180')
    expect(lines[119]).toBe('line 299')
    expect(logTail('build\tstep\t2026-11-13T16:01:26Z \x1b[31;1mFAIL\x1b[0m x')).toBe('FAIL x')
  })
  it('32KB 를 넘으면 앞줄부터 버리고, 한 줄이 넘치면 끝을 남긴다', () => {
    const big = Array.from({ length: 100 }, (_, i) => `${i} ${'가'.repeat(200)}`).join('\n')
    const out = logTail(big)
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(32 * 1024)
    expect(out.endsWith(`99 ${'가'.repeat(200)}`)).toBe(true)
    const one = logTail('x'.repeat(40_000) + 'END')
    expect(Buffer.byteLength(one)).toBeLessThanOrEqual(32 * 1024)
    expect(one.endsWith('END')).toBe(true)
  })
  it('가리기는 자르기 전에 줄 단위로 — 경계에서 비밀이 반쯤 남지 않는다', () => {
    const token = 'ghp_' + 'a'.repeat(36)
    const out = logTail(`ok\nGH_TOKEN=${token}\n`, (s) => s.replaceAll(token, '‹가림›'))
    expect(out).toBe('ok\nGH_TOKEN=‹가림›')
  })
})

describe('reviewNotes', () => {
  const view = {
    reviews: [
      { id: 'R1', author: { login: 'alice' }, state: 'CHANGES_REQUESTED', body: '', submittedAt: '2026-11-13T10:00:00Z' },
      { id: 'R2', author: { login: 'bob' }, state: 'APPROVED', body: '', submittedAt: '2026-11-13T11:00:00Z' },
      { id: 'R3', author: { login: 'bot' }, state: 'COMMENTED', body: '<!-- meta -->\n요약 의견', submittedAt: '2026-11-13T12:00:00Z' },
      { id: 'R4', author: { login: 'me' }, state: 'PENDING', body: '아직 안 보냄', submittedAt: null },
    ],
    comments: [{ id: 'C1', author: { login: 'carol' }, body: '대화 의견', createdAt: '2026-11-13T09:00:00Z', url: 'https://github.com/o/r/pull/7#issuecomment-1' }],
  }
  const lines = [
    { id: 9, user: { login: 'dave' }, path: 'src/a.ts', line: 12, original_line: 10, body: '여기 null 확인', created_at: '2026-11-13T13:00:00Z', html_url: 'https://github.com/o/r/pull/7#discussion_r9' },
    { id: 8, user: { login: 'erin' }, path: 'src/b.ts', line: null, original_line: 4, body: '옛 줄', created_at: '2026-11-13T08:00:00Z', html_url: 'https://github.com/o/r/pull/7#discussion_r8' },
  ]
  it('본문 없는 승인 · 보내지 않은 리뷰는 빼고, 최근 것부터 파일:줄과 함께', () => {
    const { notes, more } = reviewNotes(view, lines)
    expect(more).toBe(0)
    expect(notes.map((n) => [n.id, n.author, n.path ?? '', n.line ?? 0, n.body])).toEqual([
      ['line:9', 'dave', 'src/a.ts', 12, '여기 null 확인'],
      ['review:R3', 'bot', '', 0, '요약 의견'],
      ['review:R1', 'alice', '', 0, '(본문 없이 변경 요청)'],
      ['comment:C1', 'carol', '', 0, '대화 의견'],
      ['line:8', 'erin', 'src/b.ts', 4, '옛 줄'],
    ])
  })
  it('글은 2000자 · 개수는 50개까지', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: i, user: { login: 'z' }, path: 'a', line: i, body: 'x'.repeat(2500), created_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), html_url: 'https://github.com/o/r/pull/7' }))
    const { notes, more } = reviewNotes({ reviews: [], comments: [] }, many)
    expect(notes).toHaveLength(50)
    expect(more).toBe(10)
    expect(notes[0]!.line).toBe(59)
    expect(notes[0]!.body.length).toBe(2001)
    expect(notes[0]!.body.endsWith('…')).toBe(true)
  })
  it('가리기를 글 · 작성자 · 파일에 건다', () => {
    const { notes } = reviewNotes({ reviews: [], comments: [] }, [{ ...lines[0], body: 'token SECRET here' }], (s) => s.replaceAll('SECRET', '‹가림›'))
    expect(notes[0]!.body).toBe('token ‹가림› here')
  })
})

describe('feedbackDraft', () => {
  const fb: PrFeedback = {
    state: 'ok', number: 7, head: 'a'.repeat(40), at: 0, more: 0, lineComments: 'ok',
    checks: [{ id: 'check:0', name: 'build', workflow: 'CI', url: 'https://github.com/o/r/actions/runs/1/job/2', runId: 1, jobId: 2, log: 'FAIL: expected 2\n```inner```', logState: 'ok' }],
    notes: [
      { id: 'line:9', kind: 'line', author: 'dave', path: 'src/a.ts', line: 12, body: '여기 null 확인', at: 2 },
      { id: 'comment:C1', kind: 'comment', author: 'carol', body: '대화 의견', at: 1 },
    ],
  }
  it('고른 것만, 로그는 펜스가 깨지지 않게', () => {
    const { text, dropped } = feedbackDraft(fb, 'o/r', new Set(['check:0', 'line:9']))
    expect(dropped).toBe(0)
    expect(text).toContain('PR #7 (o/r)')
    expect(text).toContain('build · CI')
    expect(text).toContain('````\nFAIL: expected 2\n```inner```\n````')
    expect(text).toContain('dave · src/a.ts:12')
    expect(text).not.toContain('대화 의견')
  })
  it('길이 한도를 넘는 항목은 빼고 몇 개 뺐는지 알린다', () => {
    const { text, dropped } = feedbackDraft(fb, 'o/r', new Set(['check:0', 'line:9', 'comment:C1']), 200)
    expect(dropped).toBeGreaterThan(0)
    expect(text.length).toBeLessThanOrEqual(260)
    expect(text).toContain(`${dropped}개는 길이 때문에 뺐어요`)
  })
})
