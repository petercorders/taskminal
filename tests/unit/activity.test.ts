import { describe, expect, it } from 'vitest'
import {
  applyActivity,
  formatDuration,
  parseCommandOsc,
  parseNotifyOsc,
  parseOsc133,
  taskActivity,
  unescapeCommand,
  type ActivityEvent,
  type PaneActivity,
} from '../../src/shared/activity'
import { integrationEnv } from '../../src/shared/pty'

const seen = { viewed: true, now: 1000 }
const away = { viewed: false, now: 1000 }
const run = (events: ActivityEvent[], ctx = away): PaneActivity | undefined =>
  events.reduce<PaneActivity | undefined>((a, e) => applyActivity(a, e, ctx), undefined)

describe('OSC 해석', () => {
  it('133: A 프롬프트 · C 시작 · D;코드 끝, 모르는 것은 null', () => {
    expect(parseOsc133('A')).toEqual({ type: 'prompt' })
    expect(parseOsc133('C')).toEqual({ type: 'start' })
    expect(parseOsc133('D;1')).toEqual({ type: 'end', code: 1 })
    expect(parseOsc133('D;0')).toEqual({ type: 'end', code: 0 })
    expect(parseOsc133('D')).toEqual({ type: 'end', code: null })
    expect(parseOsc133('B')).toBeNull()
    expect(parseOsc133('D;x')).toEqual({ type: 'end', code: null })
  })

  it('명령 글자: 셸 통합이 바꿔 보낸 ; · 줄바꿈 · \\ 를 되돌린다', () => {
    expect(unescapeCommand('false\\x3b echo "a\\x3bb"')).toBe('false; echo "a;b"')
    expect(unescapeCommand('a\\x0ab')).toBe('a\nb')
    expect(unescapeCommand('c:\\\\dir\\\\x3b')).toBe('c:\\dir\\x3b')
    expect(parseCommandOsc('cmd;ls -la')).toEqual({ type: 'command', text: 'ls -la' })
    expect(parseCommandOsc('other;x')).toBeNull()
  })

  it('알림: OSC 9 글자 · 777 notify, OSC 9;4 진행 표시는 무시', () => {
    expect(parseNotifyOsc(9, '입력이 필요합니다')).toEqual({ type: 'notify', text: '입력이 필요합니다' })
    expect(parseNotifyOsc(9, '4;1;50')).toBeNull()
    expect(parseNotifyOsc(777, 'notify;Claude;권한이 필요합니다')).toEqual({ type: 'notify', text: 'Claude: 권한이 필요합니다' })
    expect(parseNotifyOsc(777, 'notify;제목만')).toEqual({ type: 'notify', text: '제목만' })
    expect(parseNotifyOsc(777, 'other;x')).toBeNull()
  })
})

describe('applyActivity', () => {
  it('명령 글자 → 시작 → 끝 0 이면 done, 걸린 시간을 남긴다', () => {
    let a = applyActivity(undefined, { type: 'command', text: 'make' }, { viewed: false, now: 100 })
    a = applyActivity(a, { type: 'start' }, { viewed: false, now: 200 })
    expect(a).toMatchObject({ state: 'running', command: 'make', startedAt: 200, attention: false })
    a = applyActivity(a, { type: 'end', code: 0 }, { viewed: false, now: 1700 })
    expect(a).toMatchObject({ state: 'done', exitCode: 0, startedAt: 200, endedAt: 1700, attention: false })
  })

  it('실패는 보고 있지 않을 때만 확인 필요', () => {
    expect(run([{ type: 'start' }, { type: 'end', code: 1 }], away)).toMatchObject({ state: 'failed', exitCode: 1, attention: true })
    expect(run([{ type: 'start' }, { type: 'end', code: 1 }], seen)).toMatchObject({ state: 'failed', attention: false })
  })

  it('벨 · 알림은 보고 있지 않으면 입력 기다림 + 확인 필요, 보고 있으면 그대로', () => {
    expect(run([{ type: 'start' }, { type: 'bell' }], away)).toMatchObject({ state: 'waiting', attention: true })
    expect(run([{ type: 'start' }, { type: 'notify', text: '권한' }], away)).toMatchObject({ state: 'waiting', attention: true, message: '권한' })
    const before = run([{ type: 'start' }], seen)!
    expect(applyActivity(before, { type: 'bell' }, seen)).toBe(before)
  })

  it('벨이 울린 뒤 명령이 끝나도 확인 필요는 볼 때까지 남는다', () => {
    expect(run([{ type: 'start' }, { type: 'bell' }, { type: 'end', code: 0 }], away)).toMatchObject({ state: 'done', attention: true })
  })

  it('보면(viewed) 확인 필요가 꺼지고, 기다림은 명령 중이면 실행 중으로 · 아니면 쉼으로', () => {
    const waitingInCmd = run([{ type: 'start' }, { type: 'bell' }])!
    expect(applyActivity(waitingInCmd, { type: 'viewed' }, seen)).toMatchObject({ state: 'running', attention: false })
    const waitingAtPrompt = run([{ type: 'bell' }])!
    expect(applyActivity(waitingAtPrompt, { type: 'viewed' }, seen)).toMatchObject({ state: 'idle', attention: false })
    const failed = run([{ type: 'start' }, { type: 'end', code: 2 }])!
    expect(applyActivity(failed, { type: 'viewed' }, seen)).toMatchObject({ state: 'failed', attention: false })
  })

  it('새 명령 시작은 주의를 끄고 지난 결과를 지운다', () => {
    const failed = run([{ type: 'start' }, { type: 'end', code: 2 }])!
    const next = applyActivity(failed, { type: 'start' }, { viewed: false, now: 5000 })
    expect(next).toMatchObject({ state: 'running', attention: false, startedAt: 5000 })
    expect(next.exitCode).toBeUndefined()
    expect(next.endedAt).toBeUndefined()
  })

  it('끝(D) 없이 프롬프트(A)가 오면 실행 중을 쉼으로 — 끝을 놓친 명령이 영원히 실행 중이 아니게', () => {
    expect(run([{ type: 'start' }, { type: 'prompt' }])).toMatchObject({ state: 'idle' })
    const done = run([{ type: 'start' }, { type: 'end', code: 0 }])!
    expect(applyActivity(done, { type: 'prompt' }, away)).toBe(done)
  })

  it('바뀐 것이 없으면 같은 객체 — 같은 벨이 여러 번 와도 다시 그리지 않게', () => {
    const w = run([{ type: 'bell' }])!
    expect(applyActivity(w, { type: 'bell' }, away)).toBe(w)
    const idle = run([{ type: 'prompt' }])!
    expect(applyActivity(idle, { type: 'viewed' }, seen)).toBe(idle)
  })
})

describe('taskActivity', () => {
  const a = (state: PaneActivity['state'], attention = false): PaneActivity => ({ state, attention, busy: state === 'running' })
  it('우선순위 waiting > failed > running > done > idle, 주의는 하나라도 있으면 · 실행 중 개수', () => {
    expect(taskActivity([a('done'), a('running'), a('failed', true)])).toEqual({ state: 'failed', attention: true, running: 1 })
    expect(taskActivity([a('waiting', true), a('failed')])).toMatchObject({ state: 'waiting', attention: true })
    expect(taskActivity([a('running'), a('running'), undefined])).toEqual({ state: 'running', attention: false, running: 2 })
    expect(taskActivity([undefined])).toEqual({ state: 'idle', attention: false, running: 0 })
  })
  it('확인 필요인 pane 은 (실패가 아니면) 입력 기다림으로 보인다 — 벨 뒤 명령이 끝나 done 이어도 ✓ 로 보이지 않게', () => {
    expect(taskActivity([{ state: 'done', attention: true, busy: false }])).toMatchObject({ state: 'waiting', attention: true })
    expect(taskActivity([{ state: 'failed', attention: true, busy: false }])).toMatchObject({ state: 'failed' })
  })
})

describe('integrationEnv', () => {
  it('zsh 이면 ZDOTDIR 을 통합 폴더로, 원래 ZDOTDIR 은 넘긴다', () => {
    expect(integrationEnv({ PATH: '/bin' }, '/bin/zsh', '/app/zsh')).toEqual({ PATH: '/bin', ZDOTDIR: '/app/zsh' })
    expect(integrationEnv({ ZDOTDIR: '/me/.config/zsh' }, '/usr/local/bin/zsh', '/app/zsh')).toEqual({
      ZDOTDIR: '/app/zsh',
      TASKMINAL_USER_ZDOTDIR: '/me/.config/zsh',
    })
  })
  it('zsh 가 아니거나 통합 폴더가 없으면 그대로', () => {
    const env = { PATH: '/bin' }
    expect(integrationEnv(env, '/bin/bash', '/app/zsh')).toBe(env)
    expect(integrationEnv(env, '/bin/zsh', null)).toBe(env)
  })
})

describe('formatDuration', () => {
  it('초 · 분 초 · 시간 분, 1초 미만은 0초', () => {
    expect(formatDuration(400)).toBe('0초')
    expect(formatDuration(3_200)).toBe('3초')
    expect(formatDuration(65_000)).toBe('1분 5초')
    expect(formatDuration(3_725_000)).toBe('1시간 2분')
  })
})
