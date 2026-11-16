import { describe, expect, it } from 'vitest'
import { SHORTCUTS } from '../../src/shared/keymap'
import { FIND_TOOLS, WORK_TOOLS, commandLabel, toolBlocked, toolByKind } from '../../src/shared/work-tools'

// 56단계: 위 도구 줄 · 좁은 창 고르기 칸 · 사이드바 고르기 칸 · 패널 머리 · ⌘P 가 같은 이름 · 같은 꺼짐 규칙을 쓴다
describe('work-tools', () => {
  it('도구 이름은 ⌘P(키 표) 이름과 같다 — 모든 도구 · 찾기가 키 표에 있다', () => {
    const labels = new Map(SHORTCUTS.map((s) => [s.command, s.label]))
    for (const t of [...WORK_TOOLS, ...FIND_TOOLS]) {
      expect(labels.has(t.command), t.command).toBe(true)
      expect(commandLabel(t.command)).toBe(labels.get(t.command))
    }
    expect(commandLabel('development')).toBe('환경 준비·확장')
  })

  it('일감 도구와 앱 도구로 나뉘고 종류가 겹치지 않는다', () => {
    expect(new Set(WORK_TOOLS.map((t) => t.kind)).size).toBe(WORK_TOOLS.length)
    expect(WORK_TOOLS.filter((t) => t.group === 'app').map((t) => t.kind)).toEqual(['accounts', 'remote'])
    expect(toolByKind('worktree')?.command).toBe('worktrees')
  })

  it('일감 도구는 일감이 없거나 원격 일감이면 막히고 이유를 준다 · 앱 도구는 늘 된다', () => {
    const files = toolByKind('files')!, accounts = toolByKind('accounts')!
    expect(toolBlocked(files, null)).toMatch(/일감을 먼저/)
    expect(toolBlocked(files, { host: 'dev-box' })).toMatch(/원격 일감/)
    expect(toolBlocked(files, {})).toBeNull()
    expect(toolBlocked(accounts, null)).toBeNull()
    expect(toolBlocked(accounts, { host: 'dev-box' })).toBeNull()
  })
})
