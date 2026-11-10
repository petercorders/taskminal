import { describe, expect, it } from 'vitest'
import { accelFromEvent, accelLabel, commandForKey, isAccel, isAppCommand, keyConflicts, repeatable, shortcutTable, SHORTCUTS, stepFontSize, type KeyLike } from '../../src/shared/keymap'

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
    expect(commandForKey(key('KeyF'))).toBe('find') // 15d — 설정 디자인 '터미널 · 찾기 ⌘F'
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
    expect(commandForKey(key('KeyP'))).toBe('palette')
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
    for (const s of SHORTCUTS.filter((x) => x.accel !== '')) {
      const parts = s.accel.split('+')
      const last = parts.at(-1)!
      const code = /^[A-Z]$/.test(last)
        ? `Key${last}`
        : /^\d$/.test(last)
          ? `Digit${last}`
          : ({ '[': 'BracketLeft', ']': 'BracketRight', '=': 'Equal', '-': 'Minus', ',': 'Comma', Up: 'ArrowUp', Down: 'ArrowDown' } as Record<string, string>)[last]
      expect(code, s.accel).toBeDefined()
      const ev = key(code!, { shiftKey: parts.includes('Shift'), altKey: parts.includes('Alt') })
      expect(commandForKey(ev), s.accel).toBe(s.command)
    }
  })

  it('단축키 · 명령이 겹치지 않는다', () => {
    const keyed = SHORTCUTS.filter((s) => s.accel !== '') // 키 없는 명령(⌘P 로만 — 셸 지킴이 보기 등)은 빼고
    expect(new Set(keyed.map((s) => s.accel)).size).toBe(keyed.length)
    expect(new Set(SHORTCUTS.map((s) => s.command)).size).toBe(SHORTCUTS.length)
  })

  it('셸 지킴이 명령: ⌥⌘Q 모두 끝내기 · 키 없는 보기 · 정리 (16단계)', () => {
    expect(commandForKey(key('KeyQ', { altKey: true }))).toBe('quit-all')
    expect(commandForKey(key('KeyQ'))).toBeNull() // ⌘Q 는 표에 없다 — 네이티브 끝내기(셸은 남음)
    expect(SHORTCUTS.find((s) => s.command === 'host-view')?.accel).toBe('')
    expect(SHORTCUTS.find((s) => s.command === 'host-orphans')?.accel).toBe('')
  })

  it('isAppCommand 는 표에 있는 명령만', () => {
    for (const s of SHORTCUTS) expect(isAppCommand(s.command)).toBe(true)
    expect(isAppCommand('reload')).toBe(false)
    expect(isAppCommand(42)).toBe(false)
  })
})

describe('repeatable', () => {
  it('만들거나 지우는 명령은 키 반복으로 되풀이하지 않는다, 옮기기 · 글꼴은 된다', () => {
    for (const c of ['new-tab', 'new-task', 'split-right', 'split-down', 'close-pane', 'palette'] as const) expect(repeatable(c), c).toBe(false)
    for (const c of ['next-pane', 'next-tab', 'font-bigger', 'next-task'] as const) expect(repeatable(c), c).toBe(true)
  })
})

describe('accelLabel', () => {
  it('맥 기호로', () => {
    expect(accelLabel('Shift+Command+D')).toBe('⇧⌘D')
    expect(accelLabel('Alt+Command+Down')).toBe('⌥⌘↓')
    expect(accelLabel('Command+-')).toBe('⌘−')
    expect(accelLabel('Command+P')).toBe('⌘P')
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

describe('단축키 바꾸기 (11단계)', () => {
  it('shortcutTable: 덮어쓴 키 · 비운 키, 나머지는 기본', () => {
    const table = shortcutTable({ 'new-tab': 'Command+Y', clear: '' })
    expect(table.find((s) => s.command === 'new-tab')!.accel).toBe('Command+Y')
    expect(table.find((s) => s.command === 'clear')!.accel).toBe('')
    expect(table.find((s) => s.command === 'split-right')!.accel).toBe('Command+D')
  })

  it('commandForKey 는 바꾼 표를 따른다 — 옛 키 · 비운 키는 아무것도 아님', () => {
    const table = shortcutTable({ 'new-tab': 'Command+Y', clear: '' })
    expect(commandForKey(key('KeyY'), table)).toBe('new-tab')
    expect(commandForKey(key('KeyT'), table)).toBeNull()
    expect(commandForKey(key('KeyK'), table)).toBeNull()
    expect(commandForKey(key('KeyT'))).toBe('new-tab') // 표를 안 주면 기본
  })

  it('⌘+ (⇧⌘=) 는 글자 크게가 ⌘= 일 때만', () => {
    expect(commandForKey(key('Equal', { shiftKey: true }))).toBe('font-bigger')
    const table = shortcutTable({ 'font-bigger': 'Command+U' })
    expect(commandForKey(key('Equal', { shiftKey: true }), table)).toBeNull()
  })

  it('accelFromEvent: 물리 키로 — 한글 입력 상태여도 같은 키, ⌘ 없거나 ⌃ 함께면 null, 꾸밈키만이면 null', () => {
    expect(accelFromEvent(key('KeyY', {}, 'ㅛ'))).toBe('Command+Y')
    expect(accelFromEvent(key('KeyD', { shiftKey: true, altKey: true }))).toBe('Shift+Alt+Command+D')
    expect(accelFromEvent(key('BracketRight', { shiftKey: true }))).toBe('Shift+Command+]')
    expect(accelFromEvent(key('ArrowLeft', { altKey: true }))).toBe('Alt+Command+Left')
    expect(accelFromEvent(key('Comma'))).toBe('Command+,')
    expect(accelFromEvent(key('KeyY', { metaKey: false }))).toBeNull()
    expect(accelFromEvent(key('KeyY', { ctrlKey: true }))).toBeNull()
    expect(accelFromEvent(key('MetaLeft'))).toBeNull()
    expect(accelFromEvent(key('F13'))).toBeNull()
  })

  it('accelFromEvent 로 만든 키는 commandForKey 로 되돌아온다', () => {
    for (const code of ['KeyY', 'Digit5', 'BracketLeft', 'Equal', 'Minus', 'ArrowUp', 'Comma', 'Period', 'Slash', 'Semicolon', 'Quote', 'Backquote', 'Backslash']) {
      const ev = key(code, { shiftKey: true, altKey: true }) // 기본 표와 겹치지 않는 조합
      const table = shortcutTable({ palette: accelFromEvent(ev)! })
      expect(commandForKey(ev, table), code).toBe('palette')
    }
  })

  it('isAccel: ⌘ 가 든 알려진 키만, 빈 글자는 키 없음으로 허용', () => {
    expect(isAccel('Command+Y')).toBe(true)
    expect(isAccel('Shift+Alt+Command+Left')).toBe(true)
    expect(isAccel('')).toBe(true)
    expect(isAccel('Ctrl+Y')).toBe(false)
    expect(isAccel('Command+F13')).toBe(false)
    expect(isAccel('Y')).toBe(false)
    expect(isAccel(3)).toBe(false)
  })

  it('keyConflicts: 같은 키의 두 명령 서로에게, 시스템 키(복사 · 끝내기 …), 비운 키는 겹치지 않음', () => {
    const c = keyConflicts(shortcutTable({ 'new-tab': 'Command+K', 'split-right': 'Command+C' }))
    expect(c.get('new-tab')).toBe('‘화면 지우기’와 겹쳐요')
    expect(c.get('clear')).toBe('‘새 탭’과 겹쳐요')
    expect(c.get('split-right')).toBe('시스템 키(복사)와 겹쳐요')
    // 화면 지우기를 비우면 ⌘K 는 새 탭만 — 겹침 없음
    expect(keyConflicts(shortcutTable({ 'new-tab': 'Command+K', clear: '' })).size).toBe(0)
    expect(keyConflicts(shortcutTable({})).size).toBe(0)
  })

  it('settings(⌘,) 명령이 있다', () => {
    expect(commandForKey(key('Comma'))).toBe('settings')
  })
})
