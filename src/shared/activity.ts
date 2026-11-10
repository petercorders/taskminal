// pane 의 '활동' — 터미널이 알려 주는 것(실행 중 · 입력 기다림 · 끝남 · 실패). 사용자가 정하는 '상태'와 섞지 않는다.
// 저장하지 않는 런타임 값이다. 신호: 셸 통합의 OSC 133(A 프롬프트 · C 시작 · D;코드 끝) · OSC 6973;cmd(명령 글자) · 벨 · OSC 9/777 알림.

export type ActivityState = 'idle' | 'running' | 'waiting' | 'done' | 'failed'

export interface PaneActivity {
  state: ActivityState
  /** 명령이 도는 중(C 와 D 사이) — 기다림을 보고 나면 실행 중으로 돌아갈지 정한다 */
  busy: boolean
  /** 확인 필요(입력 기다림 · 보지 않을 때 실패) — 그 pane 을 보면 꺼진다 */
  attention: boolean
  command?: string
  startedAt?: number
  endedAt?: number
  exitCode?: number
  /** 알림 글자(OSC 9 · 777) */
  message?: string
}

export type ActivityEvent =
  | { type: 'prompt' }
  | { type: 'command'; text: string }
  | { type: 'start' }
  | { type: 'end'; code: number | null }
  | { type: 'bell' }
  | { type: 'notify'; text: string }
  /** 사용자가 이 pane 을 봤다(활성 일감 · 탭 · pane 이고 창에 포커스) */
  | { type: 'viewed' }

export interface ActivityContext {
  /** 사건이 온 지금 사용자가 이 pane 을 보고 있나 */
  viewed: boolean
  now: number
}

const IDLE: PaneActivity = { state: 'idle', busy: false, attention: false }

/** 바뀐 것이 없으면 같은 객체를 돌려준다 — 같은 벨이 여러 번 와도 다시 그리지 않게. */
export function applyActivity(prev: PaneActivity | undefined, ev: ActivityEvent, ctx: ActivityContext): PaneActivity {
  const a = prev ?? IDLE
  switch (ev.type) {
    case 'command':
      return a.command === ev.text ? a : { ...a, command: ev.text }
    case 'start': {
      const { exitCode: _e, endedAt: _t, message: _m, ...rest } = a
      return { ...rest, state: 'running', busy: true, attention: false, startedAt: ctx.now }
    }
    case 'end': {
      const failed = ev.code !== null && ev.code !== 0
      const next: PaneActivity = { ...a, state: failed ? 'failed' : 'done', busy: false, endedAt: ctx.now, attention: a.attention || (failed && !ctx.viewed) }
      if (ev.code === null) delete next.exitCode
      else next.exitCode = ev.code
      return next
    }
    case 'prompt':
      // 끝(D)을 놓친 명령이 영원히 실행 중으로 남지 않게
      return a.busy || a.state === 'running' ? { ...a, state: 'idle', busy: false } : a
    case 'bell':
    case 'notify': {
      if (ctx.viewed) return a
      const message = ev.type === 'notify' ? ev.text : a.message
      if (a.state === 'waiting' && a.attention && a.message === message) return a
      const next: PaneActivity = { ...a, state: 'waiting', attention: true }
      if (message !== undefined) next.message = message
      return next
    }
    case 'viewed': {
      if (!a.attention && a.state !== 'waiting') return a
      const state: ActivityState = a.state === 'waiting' ? (a.busy ? 'running' : 'idle') : a.state
      return { ...a, state, attention: false }
    }
  }
}

/** OSC 133 의 내용(`A` · `C` · `D;1`). B(입력 시작) 등은 쓰지 않는다. */
export function parseOsc133(data: string): ActivityEvent | null {
  const [kind, arg] = data.split(';')
  if (kind === 'A') return { type: 'prompt' }
  if (kind === 'C') return { type: 'start' }
  if (kind === 'D') {
    const code = arg !== undefined && /^\d+$/.test(arg) ? Number(arg) : null
    return { type: 'end', code }
  }
  return null
}

/** 셸 통합이 바꿔 보낸 글자를 되돌린다: `\xNN` → 그 글자, `\\` → `\`. */
export function unescapeCommand(s: string): string {
  return s.replace(/\\(\\|x([0-9a-fA-F]{2}))/g, (_m, all: string, hex: string | undefined) =>
    hex ? String.fromCharCode(parseInt(hex, 16)) : all,
  )
}

/** OSC 6973 (우리 셸 통합의 명령 글자): `cmd;<글자>` */
export function parseCommandOsc(data: string): ActivityEvent | null {
  if (!data.startsWith('cmd;')) return null
  return { type: 'command', text: unescapeCommand(data.slice(4)) }
}

/** 데스크톱 알림 OSC: 9 = 글자(iTerm2) — `9;4;…` 은 진행 표시(ConEmu · Windows Terminal)라 무시, 777 = `notify;제목;본문`. */
export function parseNotifyOsc(ident: 9 | 777, data: string): ActivityEvent | null {
  if (ident === 9) return /^4;/.test(data) ? null : { type: 'notify', text: data }
  const [sub, title, ...body] = data.split(';')
  if (sub !== 'notify') return null
  const text = body.length > 0 ? `${title ?? ''}: ${body.join(';')}` : (title ?? '')
  return { type: 'notify', text }
}

const RANK: Record<ActivityState, number> = { idle: 0, done: 1, running: 2, failed: 3, waiting: 4 }

/** 일감(또는 탭)의 활동 = pane 들의 합. 가장 급한 것 하나 · 주의가 하나라도 있으면 주의 · 실행 중 개수. */
export function taskActivity(panes: Array<PaneActivity | undefined>): { state: ActivityState; attention: boolean; running: number } {
  let state: ActivityState = 'idle'
  let attention = false
  let running = 0
  for (const p of panes) {
    if (!p) continue
    // 확인 필요의 이유는 벨 · 알림(기다림) 아니면 실패다 — 벨 뒤 명령이 끝나 done 이 됐어도 기다림으로 보인다
    const shown: ActivityState = p.attention && p.state !== 'failed' ? 'waiting' : p.state
    if (RANK[shown] > RANK[state]) state = shown
    attention ||= p.attention
    if (p.busy) running++
  }
  return { state, attention, running }
}

/** 경과 · 걸린 시간 글자: `3초` · `1분 5초` · `1시간 2분` */
export function formatDuration(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000))
  if (sec < 60) return `${sec}초`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}분 ${sec % 60}초`
  return `${Math.floor(min / 60)}시간 ${min % 60}분`
}
