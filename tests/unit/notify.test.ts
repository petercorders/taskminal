import { describe, expect, it } from 'vitest'
import { applyActivity, type ActivityEvent, type PaneActivity } from '../../src/shared/activity'
import { notifyKind } from '../../src/shared/notify'
import { pickShell } from '../../src/shared/pty'

const LONG = 30_000
const step = (prev: PaneActivity | undefined, ev: ActivityEvent, now: number, viewed = false) => {
  const next = applyActivity(prev, ev, { viewed, now })
  return { next, kind: notifyKind(prev, next, ev, LONG) }
}

describe('notifyKind', () => {
  it('벨 · 알림으로 새로 확인 필요가 되면 wait — 이미 기다리는 중이면 다시 안 알림', () => {
    const a = step(undefined, { type: 'bell' }, 0)
    expect(a.kind).toBe('wait')
    expect(step(a.next, { type: 'bell' }, 1).kind).toBeNull()
    expect(step(undefined, { type: 'notify', text: '권한' }, 0).kind).toBe('wait')
  })

  it('보고 있는 pane 의 벨은 확인 필요가 아니라 알리지 않음', () => {
    expect(step(undefined, { type: 'bell' }, 0, true).kind).toBeNull()
  })

  it('실패는 fail, 걸린 시간과 무관', () => {
    const run = step(undefined, { type: 'start' }, 0).next
    expect(step(run, { type: 'end', code: 1 }, 100).kind).toBe('fail')
  })

  it('성공이 기준 이상 걸렸으면 long, 짧으면 없음, 코드 모름(null)도 성공처럼', () => {
    const run = step(undefined, { type: 'start' }, 0).next
    expect(step(run, { type: 'end', code: 0 }, LONG).kind).toBe('long')
    expect(step(run, { type: 'end', code: 0 }, LONG - 1).kind).toBeNull()
    expect(step(run, { type: 'end', code: null }, LONG + 5).kind).toBe('long')
  })

  it('앞 명령이 끝난 뒤 시작(C) 없이 온 끝(D)은 앞 명령의 시작 시각으로 재지 않는다', () => {
    const run = step(undefined, { type: 'start' }, 0).next
    const done = step(run, { type: 'end', code: 0 }, 10).next
    expect(step(done, { type: 'end', code: 0 }, LONG * 2).kind).toBeNull()
  })

  it('시작을 못 본 끝(셸 통합 전 명령)은 long 아님, 다른 사건은 없음', () => {
    expect(step(undefined, { type: 'end', code: 0 }, LONG * 2).kind).toBeNull()
    expect(step(undefined, { type: 'prompt' }, 0).kind).toBeNull()
    expect(step(undefined, { type: 'command', text: 'ls' }, 0).kind).toBeNull()
  })
})

describe('pickShell', () => {
  const allowed = ['/bin/zsh', '/bin/bash', '/opt/homebrew/bin/fish']
  it('/etc/shells 에 있는 절대 경로만, 아니면 $SHELL, 그것도 없으면 /bin/zsh', () => {
    expect(pickShell('/opt/homebrew/bin/fish', '/bin/zsh', allowed)).toBe('/opt/homebrew/bin/fish')
    expect(pickShell('/tmp/evil', '/bin/bash', allowed)).toBe('/bin/bash')
    expect(pickShell('fish', '/bin/bash', allowed)).toBe('/bin/bash')
    expect(pickShell(null, '/bin/bash', allowed)).toBe('/bin/bash')
    expect(pickShell(null, undefined, allowed)).toBe('/bin/zsh')
  })
})
