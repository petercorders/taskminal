import { describe, expect, it } from 'vitest'
import { commandForKey, isAppCommand, repeatable, SHORTCUTS, stepFontSize, type KeyLike } from '../../src/shared/keymap'

const key = (code: string, mods: Partial<KeyLike> = {}, k = ''): KeyLike => ({
  key: k,
  code,
  metaKey: true,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  isComposing: false,
  ...mods,
})

describe('commandForKey', () => {
  it('iTerm 방식 단축키', () => {
    expect(commandForKey(key('KeyT'))).toBe('new-tab')
    expect(commandForKey(key('KeyN'))).toBe('new-task')
    expect(commandForKey(key('KeyW'))).toBe('close-pane')
    expect(commandForKey(key('KeyD'))).toBe('split-right')
    expect(commandForKey(key('KeyD', { shiftKey: true }))).toBe('split-down')
    expect(commandForKey(key('KeyK'))).toBe('clear')
  })

  it('⌘1~8 은 n번째 탭, ⌘9 는 마지막 탭', () => {
    expect(commandForKey(key('Digit1'))).toBe('tab-1')
    expect(commandForKey(key('Digit8'))).toBe('tab-8')
    expect(commandForKey(key('Digit9'))).toBe('last-tab')
  })

  it('⌘[ ] 는 pane, ⇧⌘[ ] 는 탭, ⌥⌘↑↓ 는 일감', () => {
    expect(commandForKey(key('BracketRight'))).toBe('next-pane')
    expect(commandForKey(key('BracketLeft'))).toBe('prev-pane')
    expect(commandForKey(key('BracketRight', { shiftKey: true }))).toBe('next-tab')
    expect(commandForKey(key('BracketLeft', { shiftKey: true }))).toBe('prev-tab')
    expect(commandForKey(key('ArrowDown', { altKey: true }))).toBe('next-task')
    expect(commandForKey(key('ArrowUp', { altKey: true }))).toBe('prev-task')
    expect(commandForKey(key('ArrowUp'))).toBeNull() // ⌥ 없이는 셸 몫
    expect(commandForKey(key('KeyA', { shiftKey: true }))).toBe('next-attention')
    expect(commandForKey(key('KeyA'))).toBeNull() // ⌘A 모두 선택은 네이티브
  })

  it('글꼴: ⌘= 와 ⌘+(⇧⌘=) 둘 다 크게, ⌘− 작게, ⌘0 기본', () => {
    expect(commandForKey(key('Equal'))).toBe('font-bigger')
    expect(commandForKey(key('Equal', { shiftKey: true }))).toBe('font-bigger')
    expect(commandForKey(key('Minus'))).toBe('font-smaller')
    expect(commandForKey(key('Digit0'))).toBe('font-reset')
  })

  it('한글 입력 상태에서도 물리 키로 잡는다 (⌘T 의 key 는 ㅅ)', () => {
    expect(commandForKey(key('KeyT', {}, 'ㅅ'))).toBe('new-tab')
    expect(commandForKey(key('KeyD', { shiftKey: true }, 'ㅇ'))).toBe('split-down')
  })

  it('한글을 조합하는 중에 누른 ⌘ 단축키도 버리지 않는다 (⌘ 없는 키는 어차피 단축키가 아니다)', () => {
    expect(commandForKey(key('KeyT', { isComposing: true }, 'Process'))).toBe('new-tab')
    expect(commandForKey(key('KeyT', { isComposing: true, metaKey: false }, 'Process'))).toBeNull()
  })

  it('⌘ 없음 · ⌃ 함께 · 표에 없는 키는 null (셸이나 네이티브 메뉴 몫)', () => {
    expect(commandForKey(key('KeyT', { metaKey: false }))).toBeNull()
    expect(commandForKey(key('KeyT', { ctrlKey: true }))).toBeNull()
    expect(commandForKey(key('KeyC'))).toBeNull() // 복사는 네이티브 role
    expect(commandForKey(key('KeyV'))).toBeNull()
    expect(commandForKey(key('KeyT', { altKey: true }))).toBeNull()
    expect(commandForKey(key('KeyW', { shiftKey: true }))).toBeNull() // ⇧⌘W 창 닫기는 네이티브
  })
})

describe('SHORTCUTS', () => {
  it('표의 모든 단축키가 자기 명령으로 풀린다 (메뉴 표시 = 실제 키)', () => {
    for (const s of SHORTCUTS) {
      const parts = s.accel.split('+')
      const last = parts.at(-1)!
      const code = /^[A-Z]$/.test(last)
        ? `Key${last}`
        : /^\d$/.test(last)
          ? `Digit${last}`
          : ({ '[': 'BracketLeft', ']': 'BracketRight', '=': 'Equal', '-': 'Minus', Up: 'ArrowUp', Down: 'ArrowDown' } as Record<string, string>)[last]
      expect(code, s.accel).toBeDefined()
      const ev = key(code!, { shiftKey: parts.includes('Shift'), altKey: parts.includes('Alt') })
      expect(commandForKey(ev), s.accel).toBe(s.command)
    }
  })

  it('단축키 · 명령이 겹치지 않는다', () => {
    expect(new Set(SHORTCUTS.map((s) => s.accel)).size).toBe(SHORTCUTS.length)
    expect(new Set(SHORTCUTS.map((s) => s.command)).size).toBe(SHORTCUTS.length)
  })

  it('isAppCommand 는 표에 있는 명령만', () => {
    for (const s of SHORTCUTS) expect(isAppCommand(s.command)).toBe(true)
    expect(isAppCommand('reload')).toBe(false)
    expect(isAppCommand(42)).toBe(false)
  })
})

describe('repeatable', () => {
  it('만들거나 지우는 명령은 키 반복으로 되풀이하지 않는다, 옮기기 · 글꼴은 된다', () => {
    for (const c of ['new-tab', 'new-task', 'split-right', 'split-down', 'close-pane'] as const) expect(repeatable(c), c).toBe(false)
    for (const c of ['next-pane', 'next-tab', 'font-bigger', 'next-task'] as const) expect(repeatable(c), c).toBe(true)
  })
})

describe('stepFontSize', () => {
  it('1씩, 8~32 안에서, reset 은 13', () => {
    expect(stepFontSize(13, 'bigger')).toBe(14)
    expect(stepFontSize(13, 'smaller')).toBe(12)
    expect(stepFontSize(32, 'bigger')).toBe(32)
    expect(stepFontSize(8, 'smaller')).toBe(8)
    expect(stepFontSize(20, 'reset')).toBe(13)
  })
})
