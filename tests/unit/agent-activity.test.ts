// 51단계: 에이전트 훅 사건이 pane 활동 · 알림에 들어가는 방식.
import { describe, expect, it } from 'vitest'
import { applyActivity, taskActivity, type ActivityEvent, type PaneActivity } from '../../src/shared/activity'
import { notifyKind } from '../../src/shared/notify'

const away = { viewed: false, now: 1000 }
const seen = { viewed: true, now: 1000 }
const running: PaneActivity = { state: 'running', busy: true, attention: false, command: 'claude', startedAt: 1 }
const ag = (phase: 'working' | 'permission' | 'input' | 'done' | 'failed' | 'ended', extra: Partial<ActivityEvent> = {}): ActivityEvent =>
  ({ type: 'agent', agent: 'claude', phase, ...extra }) as ActivityEvent

const chain = (evs: ActivityEvent[], ctx = away, from: PaneActivity | undefined = running): PaneActivity =>
  evs.reduce<PaneActivity | undefined>((a, ev) => applyActivity(a, ev, ctx), from)!

describe('에이전트 사건 → 활동', () => {
  it('작업 중 → 실행 중 · 주의 없음, 에이전트 상태를 단다', () => {
    const a = chain([ag('working')])
    expect(a).toMatchObject({ state: 'running', busy: true, attention: false, agent: { agent: 'claude', phase: 'working', at: 1000 } })
  })

  it('허락 · 입력 기다림: 보지 않을 때 확인 필요, 보고 있으면 상태만', () => {
    expect(chain([ag('working'), ag('permission')])).toMatchObject({ state: 'waiting', attention: true, agent: { phase: 'permission' } })
    expect(chain([ag('working'), ag('input')], seen)).toMatchObject({ state: 'waiting', attention: false, agent: { phase: 'input' } })
  })

  it('허락 기다림을 본 뒤에도 기다림 표시는 남고(주의만 꺼짐), 도구가 돌면 실행 중으로', () => {
    const waiting = chain([ag('working'), ag('permission')])
    const viewed = applyActivity(waiting, { type: 'viewed' }, seen)
    expect(viewed).toMatchObject({ state: 'waiting', attention: false, agent: { phase: 'permission' } })
    expect(applyActivity(viewed, ag('working'), seen)).toMatchObject({ state: 'running', attention: false, agent: { phase: 'working' } })
  })

  it('턴 끝: 보지 않을 때는 확인 필요(다음 지시를 기다림)로 보이고, 보면 끝남', () => {
    const done = chain([ag('working'), ag('done')])
    expect(done).toMatchObject({ state: 'done', busy: true, attention: true, agent: { phase: 'done' } })
    expect(taskActivity([done]).state).toBe('waiting')
    const viewed = applyActivity(done, { type: 'viewed' }, seen)
    expect(viewed).toMatchObject({ state: 'done', attention: false, agent: { phase: 'done' } })
    expect(chain([ag('working'), ag('done')], seen)).toMatchObject({ state: 'done', attention: false })
  })

  it('턴 실패 → 실패(보지 않을 때 주의)', () => {
    expect(chain([ag('working'), ag('failed')])).toMatchObject({ state: 'failed', attention: true, agent: { phase: 'failed' } })
  })

  it('세션 끝 → 에이전트 상태를 지우고 명령은 아직 실행 중', () => {
    const a = chain([ag('working'), ag('permission'), ag('ended')])
    expect(a.agent).toBeUndefined()
    expect(a).toMatchObject({ state: 'running', attention: false })
  })

  it('셸이 바쁘지 않던 pane(셸 통합 없음)의 세션 끝은 실행 중에 묶이지 않는다', () => {
    const quiet: PaneActivity = { state: 'idle', busy: false, attention: false }
    expect(chain([ag('working'), ag('ended')], away, quiet)).toMatchObject({ state: 'idle', busy: false })
    expect(chain([ag('working'), ag('done'), ag('ended')], seen, quiet)).toMatchObject({ state: 'done', busy: false })
    // 되살린 133;C 를 본 뒤면 셸 명령이 도는 중이다 — D 가 닫는다
    const restored = chain([ag('permission', { restore: true } as Partial<ActivityEvent>), { type: 'start' }], away, quiet)
    expect(applyActivity(restored, ag('ended'), away)).toMatchObject({ state: 'running', busy: true })
  })

  it('명령 끝(OSC 133 D) · 프롬프트는 남은 에이전트 상태를 닫는다(죽은 claude 의 작업 중이 남지 않게)', () => {
    expect(chain([ag('working'), { type: 'end', code: 0 }]).agent).toBeUndefined()
    expect(chain([ag('working'), { type: 'prompt' }]).agent).toBeUndefined()
  })

  it('셸 지킴이에 다시 붙을 때 되살린 명령 시작(133;C)은 복원한 에이전트 상태를 지우지 않는다', () => {
    const restored = chain([ag('permission', { restore: true } as Partial<ActivityEvent>)], away, undefined)
    expect(applyActivity(restored, { type: 'start' }, away)).toMatchObject({ state: 'waiting', busy: true, agent: { phase: 'permission' } })
  })

  it('다시 읽기(restore)로 넣은 상태는 주의를 켜지 않는다', () => {
    const a = chain([ag('done', { restore: true } as Partial<ActivityEvent>)], away, undefined)
    expect(a).toMatchObject({ state: 'done', attention: false, busy: true, agent: { phase: 'done' } })
  })

  it('같은 상태가 또 오면 같은 객체(다시 그리지 않음)', () => {
    const a = chain([ag('working')])
    expect(applyActivity(a, ag('working'), { viewed: false, now: 5000 })).toBe(a)
  })

  it('codex 는 작업 시작 훅이 없어 턴 끝 뒤 Enter 를 작업 중으로 본다 · claude 는 훅만 믿는다', () => {
    const codexDone = chain([{ type: 'agent', agent: 'codex', phase: 'done' } as ActivityEvent], seen)
    expect(applyActivity(codexDone, { type: 'submit' }, seen)).toMatchObject({ state: 'running', agent: { agent: 'codex', phase: 'working' } })
    const claudeDone = chain([ag('done')], seen)
    expect(applyActivity(claudeDone, { type: 'submit' }, seen)).toBe(claudeDone)
    expect(applyActivity(running, { type: 'submit' }, seen)).toBe(running)
  })
})

describe('에이전트 사건 → 알림', () => {
  const kind = (evs: ActivityEvent[], ctx = away): ReturnType<typeof notifyKind> => {
    let a: PaneActivity | undefined = running
    let k: ReturnType<typeof notifyKind> = null
    for (const ev of evs) {
      const next = applyActivity(a, ev, ctx)
      k = notifyKind(a, next, ev, 60_000)
      a = next
    }
    return k
  }
  it('허락 · 입력 · 턴 끝은 기다림 알림, 실패는 실패 알림', () => {
    expect(kind([ag('working'), ag('permission')])).toBe('wait')
    expect(kind([ag('working'), ag('input')])).toBe('wait')
    expect(kind([ag('working'), ag('done')])).toBe('wait')
    expect(kind([ag('working'), ag('failed')])).toBe('fail')
  })
  it('작업 중 · 같은 기다림 반복 · 보고 있을 때 · 다시 읽기는 알리지 않는다', () => {
    expect(kind([ag('working')])).toBeNull()
    expect(kind([ag('permission'), ag('permission')])).toBeNull()
    expect(kind([ag('working'), ag('done')], seen)).toBeNull()
    expect(kind([ag('done', { restore: true } as Partial<ActivityEvent>)])).toBeNull()
  })
})

describe('에이전트 상태 글자', () => {
  it('사이드바 둘째 줄은 명령 대신 에이전트 상태를 보인다', async () => {
    const { lastLine } = await import('../../src/renderer/sidebar-model')
    const task = { panes: { p1: {} } } as unknown as Parameters<typeof lastLine>[0]
    const at = (a: PaneActivity) => lastLine(task, { p1: a })
    expect(at(chain([ag('working')]))).toEqual({ text: '● Claude · 작업 중', tone: 'run' })
    expect(at(chain([ag('permission')]))).toEqual({ text: 'Claude · 허락 기다림', tone: 'wait' })
    expect(at(chain([ag('input')], seen))).toEqual({ text: 'Claude · 입력 기다림', tone: 'wait' })
    expect(at(chain([ag('done')], seen))).toEqual({ text: '✓ Claude · 끝남', tone: 'dim' })
    expect(at(chain([ag('failed')]))).toEqual({ text: '✗ Claude · 실패', tone: 'err' })
  })
})
