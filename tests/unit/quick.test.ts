import { describe, expect, it } from 'vitest'
import type { PaneActivity } from '../../src/shared/activity'
import {
  QUICK_BAR_MAX,
  advanceRun,
  decideRun,
  parseQuickList,
  quickButtons,
  quickDefaults,
  quickError,
  quickStatus,
  removeQuick,
  restoreQuick,
  upsertQuick,
  type QuickCommand,
} from '../../src/shared/quick'

const qc = (p: Partial<QuickCommand> = {}): QuickCommand => ({ id: 'q1', label: '시험', command: 'npm test', where: 'current', ...p })

describe('parseQuickList — 저장 파일 검증', () => {
  it('틀린 항목 · 겹친 id · 여러 줄 명령은 버리고 나머지는 남긴다', () => {
    const list = parseQuickList([
      qc(),
      { ...qc({ id: 'q2' }), where: 'moon' },
      qc({ id: 'q1', label: '겹침' }),
      qc({ id: 'q3', command: 'a\nb' }),
      qc({ id: 'q4', label: '' }),
      qc({ id: 'q5', where: 'splitDown', cwd: 'web', confirm: true, fromTemplate: 'Spring 서버' }),
      'x',
    ])
    expect(list.map((q) => q.id)).toEqual(['q1', 'q5'])
    expect(list[1]).toEqual({ id: 'q5', label: '시험', command: 'npm test', where: 'splitDown', cwd: 'web', confirm: true, fromTemplate: 'Spring 서버' })
  })
  it('배열이 아니면 빈 목록', () => {
    expect(parseQuickList(undefined)).toEqual([])
    expect(parseQuickList({})).toEqual([])
  })
  it('confirm 이 true 가 아니면 칸을 두지 않는다', () => {
    expect(parseQuickList([{ ...qc(), confirm: 'yes' }])[0]).not.toHaveProperty('confirm')
  })
})

describe('quickError — 만들기 창', () => {
  it('이름 · 명령이 비었거나 명령에 줄바꿈이 있으면 이유', () => {
    expect(quickError({ label: ' ', command: 'ls' })).toMatch(/이름/)
    expect(quickError({ label: 'a', command: '  ' })).toMatch(/명령/)
    expect(quickError({ label: 'a', command: 'a\nb' })).toMatch(/&&/)
    expect(quickError({ label: 'a', command: 'ls' })).toBeNull()
  })
})

describe('quickDefaults — 위험 명령이면 실행 전 물어봐요를 켠다(19단계 표)', () => {
  it('deploy · rm · push 는 켜고 이유를 한 줄', () => {
    expect(quickDefaults('./deploy/nas/deploy.sh')).toEqual({ confirm: true, reason: expect.stringMatching(/위험/) })
    expect(quickDefaults('git push origin main').confirm).toBe(true)
    expect(quickDefaults('npm test')).toEqual({ confirm: false })
  })
})

describe('quickButtons — 단추 순서 · 출처 · 9개', () => {
  it('일감 것(템플릿에서 온 것 포함) 다음 모든 일감 것, 앞 9개에 ⌥1~9', () => {
    const task = { quickCommands: [qc({ id: 'a' }), qc({ id: 'b', fromTemplate: 'T' })] }
    const { shown, more } = quickButtons(task, [qc({ id: 'g' })])
    expect(shown.map((b) => [b.qc.id, b.source, b.key])).toEqual([
      ['a', 'task', 1],
      ['b', 'template', 2],
      ['g', 'all', 3],
    ])
    expect(more).toEqual([])
  })
  it('9개를 넘으면 나머지는 더 보기로 (키 없음)', () => {
    const many = Array.from({ length: 12 }, (_, i) => qc({ id: `q${i}` }))
    const { shown, more } = quickButtons({ quickCommands: many }, [])
    expect(shown).toHaveLength(QUICK_BAR_MAX)
    expect(shown.at(-1)!.key).toBe(9)
    expect(more.map((b) => [b.qc.id, b.key])).toEqual([
      ['q9', null],
      ['q10', null],
      ['q11', null],
    ])
  })
  it('같은 id 를 일감과 모든 일감이 함께 써도 단추 key(runKey)는 다르다', () => {
    const { shown } = quickButtons({ quickCommands: [qc({ id: 'x' })] }, [qc({ id: 'x' })])
    expect(new Set(shown.map((b) => b.runKey)).size).toBe(2)
  })
})

describe('advanceRun · quickStatus — 이 단추가 보낸 명령의 시작 · 끝만', () => {
  const act = (p: Partial<PaneActivity>): PaneActivity => ({ state: 'idle', busy: false, attention: false, ...p })
  const sent = { paneId: 'p1', sentAt: 1000 }
  it('실행 안 했으면 idle', () => {
    expect(quickStatus(undefined, true)).toEqual({ kind: 'idle' })
  })
  it('보낸 뒤 시작했으면 ● 실행 중 (시작 시각부터)', () => {
    const r = advanceRun(sent, act({ state: 'running', busy: true, startedAt: 1200 }))
    expect(quickStatus(r, true)).toEqual({ kind: 'running', since: 1200 })
  })
  it('끝났으면 ✓ · 실패면 ✗ 코드 — 한 번에 시작과 끝이 와도', () => {
    expect(quickStatus(advanceRun(sent, act({ startedAt: 1200, endedAt: 1500, exitCode: 0 })), true)).toEqual({ kind: 'done', at: 1500 })
    expect(quickStatus(advanceRun(sent, act({ startedAt: 1200, endedAt: 1500, exitCode: 2 })), true)).toEqual({ kind: 'failed', code: 2, at: 1500 })
  })
  it('굳힌 뒤 같은 pane 의 다음 명령이 실패해도 이 단추는 ✓ 그대로 (같은 객체)', () => {
    const done = advanceRun(sent, act({ startedAt: 1200, endedAt: 1500, exitCode: 0 }))
    expect(advanceRun(done, act({ startedAt: 2000, endedAt: 2100, exitCode: 3 }))).toBe(done)
    expect(quickStatus(done, true).kind).toBe('done')
  })
  it('끝을 못 본 채 다음 명령이 시작하면 끝을 놓침 → 상태 모름', () => {
    const running = advanceRun(sent, act({ busy: true, startedAt: 1200 }))
    const next = advanceRun(running, act({ busy: true, startedAt: 3000 }))
    expect(next).toMatchObject({ endedAt: 3000, code: null })
    expect(quickStatus(next, true)).toEqual({ kind: 'unknown' })
  })
  it('보내기 전에 끝난 명령의 결과는 이 단추 것이 아니다', () => {
    const r = advanceRun(sent, act({ state: 'failed', startedAt: 500, endedAt: 900, exitCode: 1 }))
    expect(r).toBe(sent)
    expect(quickStatus(r, true)).toEqual({ kind: 'running', since: 1000 })
  })
  it('셸 통합이 없는 pane 이면 상태 모름', () => {
    expect(quickStatus(sent, false)).toEqual({ kind: 'unknown' })
  })
})

describe('decideRun — 지금 pane 이 바쁘거나 결과를 모르면 끼워 넣지 않고 새 탭', () => {
  it('current: 한가하고 통합 있으면 그대로', () => {
    expect(decideRun('current', { busy: false, integrated: true })).toEqual({ where: 'current', fallback: false })
  })
  it('current: 바쁘거나 · 통합 없거나 · pane 이 없으면 새 탭으로 (fallback)', () => {
    expect(decideRun('current', { busy: true, integrated: true })).toEqual({ where: 'newTab', fallback: true })
    expect(decideRun('current', { busy: false, integrated: false })).toEqual({ where: 'newTab', fallback: true })
    expect(decideRun('current', null)).toEqual({ where: 'newTab', fallback: true })
  })
  it('다른 어디서는 그대로', () => {
    expect(decideRun('splitDown', { busy: true, integrated: true })).toEqual({ where: 'splitDown', fallback: false })
    expect(decideRun('insert', { busy: true, integrated: true })).toEqual({ where: 'insert', fallback: false })
  })
})

describe('upsert · remove · restore', () => {
  it('같은 id 면 그 자리에서 바꾸고, 없으면 끝에 더한다', () => {
    const list = [qc({ id: 'a' }), qc({ id: 'b' })]
    expect(upsertQuick(list, qc({ id: 'a', label: '바뀜' })).map((q) => q.label)).toEqual(['바뀜', '시험'])
    expect(upsertQuick(list, qc({ id: 'c' })).map((q) => q.id)).toEqual(['a', 'b', 'c'])
  })
  it('지운 자리에 되돌린다 · 이미 있으면 그대로', () => {
    const list = [qc({ id: 'a' }), qc({ id: 'b' }), qc({ id: 'c' })]
    const r = removeQuick(list, 'b')
    expect(r.list.map((q) => q.id)).toEqual(['a', 'c'])
    expect(r.index).toBe(1)
    expect(restoreQuick(r.list, r.removed!, r.index).map((q) => q.id)).toEqual(['a', 'b', 'c'])
    expect(restoreQuick(list, qc({ id: 'b' }), 0)).toBe(list)
    expect(removeQuick(list, 'zz').removed).toBeNull()
  })
})
