import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { agentGuide } from '../../src/shared/agent-guide'
import { isCliRequest, parseArgs } from '../../src/shared/cli'
import { redact } from '../../src/shared/redact'

/** 안내 글의 명령 — `taskminal` 로 시작하는 줄에서 ` # 설명` 을 떼고 `&&` 로 나눈다 */
function commands(guide: string): string[] {
  return guide
    .split('\n')
    .filter((l) => l.startsWith('taskminal '))
    .flatMap((l) => l.split(/\s+#\s/)[0]!.split(' && '))
    .map((c) => c.trim())
}

// 실행할 때 정해지는 값의 자리 — 셸이 풀어 줄 변수와, 앞 명령의 출력에서 얻는 id
const SAMPLE: Record<string, string> = { $TASKMINAL_TASK_ID: 'task-1', PANE: 'pane-1', TAB: 'tab-1' }

/** 셸처럼 나눈 인자 (큰따옴표 묶음 · 자리 값 채움) — 맨 앞 `taskminal` 은 뺀다 */
function argv(command: string): string[] {
  return [...command.matchAll(/"([^"]*)"|(\S+)/g)]
    .map((m) => m[1] ?? m[2]!)
    .map((t) => SAMPLE[t] ?? t)
    .slice(1)
}

describe('agentGuide (58b)', () => {
  const guide = agentGuide()

  it('안내에 나온 모든 taskminal 명령은 CLI 해석기가 오류 없이 읽는다', () => {
    const list = commands(guide)
    // 줄 머리 · && 뒤가 아닌 곳에 적힌 명령은 이 시험이 보지 못한다 — 그런 곳이 없어야 한다
    expect(guide.match(/taskminal /g)).toHaveLength(list.length)
    const ops: string[] = []
    for (const command of list) {
      const parsed = parseArgs(argv(command))
      expect(parsed.kind === 'usage' ? `${command} → ${parsed.error}` : parsed.kind, command).toMatch(/^(request|help)$/)
      if (parsed.kind !== 'request') continue
      expect(isCliRequest(parsed.req), command).toBe(true) // 앱(소켓)이 받는 모양이기도 하다
      ops.push(parsed.req.op === 'browser' ? `browser ${parsed.req.action}` : parsed.req.op)
    }
    // 메모 · 알림 · 다른 대화 만들기/보내기/기다리기/읽기 · 브라우저
    for (const op of ['task.note', 'notify', 'chat.new', 'chat.send', 'chat.wait', 'chat.read', 'browser tabs']) expect(ops).toContain(op)
  })

  it('열 줄 · 800자 안쪽', () => {
    expect(guide.split('\n').length).toBeLessThanOrEqual(10)
    expect(guide.length).toBeLessThanOrEqual(800)
    expect(guide).toBe(guide.trim())
  })

  it('사용자 경로 · 홈 경로 · 비밀값이 없다', () => {
    expect(guide).not.toContain('/Users/')
    expect(guide).not.toContain('/home/')
    expect(guide).not.toContain(homedir())
    expect(guide).not.toContain('~')
    expect(guide).not.toContain('$HOME')
    expect(redact(guide)).toBe(guide)
  })
})
