import { describe, expect, it } from 'vitest'
import { defaultSettings, normalizeState } from '../../src/shared/model'
import { ACCENTS, FONT_FAMILIES, LONG_AFTER_CHOICES, parseExtraSettings, settingsMatch } from '../../src/shared/settings'

let n = 0
const newId = () => `id${++n}`
const load = (settings: Record<string, unknown>) => normalizeState({ version: 1, tasks: [], settings }, newId).settings

describe('설정 기본값', () => {
  it('새 칸의 기본값', () => {
    const d = defaultSettings()
    expect(d).toMatchObject({
      startup: 'restore',
      defaultCwd: '',
      defaultTemplateId: null,
      confirmQuit: true,
      dockBadge: true,
      theme: 'dark',
      accent: ACCENTS[0]!.color,
      lineHeight: 1,
      dimOpacity: 0.62,
      sidebarDensity: 'two',
      shellIntegration: true,
      scrollback: 5000,
      cursorStyle: 'bar',
      cursorBlink: true,
      optionAsMeta: false,
      copyOnSelect: false,
      longAfterSec: 30,
      muteViewed: true,
      keys: {},
    })
    expect(d.notify.wait).toEqual({ banner: true, sound: true })
    expect(d.notify.exit).toEqual({ banner: false, sound: false })
    expect(FONT_FAMILIES).toContain(d.fontFamily)
  })

  it('옛 저장 파일(새 칸 없음)은 기본값으로', () => {
    const s = load({ fontSize: 14 })
    expect(s.fontSize).toBe(14)
    expect(s.theme).toBe('dark')
    expect(s.notify).toEqual(defaultSettings().notify)
  })
})

describe('설정 검증', () => {
  it('맞는 값은 그대로', () => {
    const s = load({
      startup: 'list',
      defaultCwd: '~/code',
      confirmQuit: false,
      dockBadge: false,
      theme: 'light',
      accent: ACCENTS[2]!.color,
      fontFamily: 'Menlo',
      lineHeight: 1.3,
      dimOpacity: 0.4,
      sidebarDensity: 'one',
      shellIntegration: false,
      scrollback: 20000,
      cursorStyle: 'underline',
      cursorBlink: false,
      optionAsMeta: true,
      copyOnSelect: true,
      notify: { wait: { banner: false, sound: true }, long: { banner: true, sound: true }, fail: { banner: false, sound: false }, exit: { banner: true, sound: false } },
      longAfterSec: 300,
      muteViewed: false,
      keys: { 'new-tab': 'Command+Y', clear: '' },
    })
    expect(s).toMatchObject({
      startup: 'list',
      defaultCwd: '~/code',
      confirmQuit: false,
      dockBadge: false,
      theme: 'light',
      accent: ACCENTS[2]!.color,
      fontFamily: 'Menlo',
      lineHeight: 1.3,
      dimOpacity: 0.4,
      sidebarDensity: 'one',
      shellIntegration: false,
      scrollback: 20000,
      cursorStyle: 'underline',
      cursorBlink: false,
      optionAsMeta: true,
      copyOnSelect: true,
      longAfterSec: 300,
      muteViewed: false,
      keys: { 'new-tab': 'Command+Y', clear: '' },
    })
    expect(s.notify.exit).toEqual({ banner: true, sound: false })
  })

  it('모르는 값 · 범위 밖 · 틀린 형은 그 칸만 기본값', () => {
    const d = defaultSettings()
    const s = load({
      startup: 'later',
      defaultCwd: 3,
      confirmQuit: 'yes',
      theme: 'blue',
      accent: '#123456',
      fontFamily: 'Comic Sans',
      lineHeight: 3,
      dimOpacity: 0.1,
      sidebarDensity: 'zero',
      scrollback: 50,
      cursorStyle: 'beam',
      notify: { wait: { banner: 'x', sound: false }, long: 'no' },
      longAfterSec: 7,
      keys: { 'new-tab': 'Ctrl+Y', nope: 'Command+J', clear: 'Command+L', __proto__: 'Command+J' },
    })
    expect(s.startup).toBe(d.startup)
    expect(s.defaultCwd).toBe('')
    expect(s.confirmQuit).toBe(true)
    expect(s.theme).toBe('dark')
    expect(s.accent).toBe(d.accent)
    expect(s.fontFamily).toBe(d.fontFamily)
    expect(s.lineHeight).toBe(1)
    expect(s.dimOpacity).toBe(0.62)
    expect(s.sidebarDensity).toBe('two')
    expect(s.scrollback).toBe(5000)
    expect(s.cursorStyle).toBe('bar')
    // 칸 하나가 틀려도 다른 칸(sound)은 남긴다
    expect(s.notify.wait).toEqual({ banner: true, sound: false })
    expect(s.notify.long).toEqual(d.notify.long)
    expect(s.longAfterSec).toBe(30)
    expect(s.keys).toEqual({ clear: 'Command+L' }) // 모르는 명령 · ⌘ 없는 키는 버림
  })

  it('줄 간격은 0.1 단위, 흐림은 0.01 단위로 맞춘다', () => {
    expect(load({ lineHeight: 1.234 }).lineHeight).toBe(1.2)
    expect(load({ dimOpacity: 0.555 }).dimOpacity).toBe(0.56)
  })

  it('기본 템플릿은 있는 템플릿일 때만', () => {
    expect(load({ defaultTemplateId: 'tpl-claude' }).defaultTemplateId).toBe('tpl-claude')
    expect(load({ defaultTemplateId: 'gone' }).defaultTemplateId).toBeNull()
  })

  it('묶음 접기', () => {
    const s = load({ groups: [{ id: 'g1', name: 'A', collapsed: true }, { id: 'g2', name: 'B', collapsed: 'y' }] })
    expect(s.groups).toEqual([{ id: 'g1', name: 'A', collapsed: true }, { id: 'g2', name: 'B' }])
  })

  it('parseExtraSettings 는 객체가 아니면 기본값 전부', () => {
    expect(parseExtraSettings(null, ['tpl'])).toMatchObject({ theme: 'dark', keys: {} })
  })

  it('오래 걸린 명령 기준은 고를 수 있는 값만', () => {
    for (const sec of LONG_AFTER_CHOICES) expect(load({ longAfterSec: sec }).longAfterSec).toBe(sec)
  })
})

describe('settingsMatch (설정 찾기)', () => {
  it('공백으로 나눈 낱말이 모두 들어 있으면 맞음, 대소문자 무시', () => {
    expect(settingsMatch('커서 깜빡임', '커서')).toBe(true)
    expect(settingsMatch('Option 키를 Meta 로', 'option meta')).toBe(true)
    expect(settingsMatch('Option 키를 Meta 로', 'option 셸')).toBe(false)
    expect(settingsMatch('무엇이든', '  ')).toBe(true)
  })
})
