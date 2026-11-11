// 작은 고침(2026-11-11): 칸 머리 · 사이드바 등 화면에 보이는 명령 글을 가린다
import { describe, expect, it } from 'vitest'
import { maskActivity, textMasker } from '../../src/renderer/activity-mask'
import type { PaneActivity } from '../../src/shared/activity'

const KEY = 'sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKEFAKE0123456789'
const act = (extra: Partial<PaneActivity>): PaneActivity => ({ state: 'running', busy: true, attention: false, ...extra })

describe('textMasker', () => {
  it('비밀값을 ‹가림:종류› 로 바꾸고, 같은 글은 캐시에서', () => {
    const m = textMasker({})
    const first = m(`echo ${KEY}`)
    expect(first).toMatch(/^echo ‹가림:[^›]+›$/)
    expect(m(`echo ${KEY}`)).toBe(first)
    expect(m('ls -la')).toBe('ls -la')
  })
  it('허용한 값 · 끈 종류는 그대로 (화면 가리기 설정을 따른다)', () => {
    const off = textMasker({ toggles: new Set() })
    expect(off(`echo ${KEY}`)).toBe(`echo ${KEY}`)
  })
})

describe('maskActivity', () => {
  it('명령 · 기다림 메시지만 바꾼 사본, 다른 칸은 그대로', () => {
    const m = textMasker({})
    const a = { p1: act({ command: `curl -H "x-api-key: ${KEY}"`, message: `토큰 ${KEY} 확인`, startedAt: 5 }), p2: act({ command: 'ls' }) }
    const out = maskActivity(a, m)
    expect(out['p1']!.command).not.toContain(KEY)
    expect(out['p1']!.message).not.toContain(KEY)
    expect(out['p1']!.startedAt).toBe(5)
    expect(out['p1']!.busy).toBe(true)
    expect(out['p2']).toBe(a.p2) // 바뀐 것이 없으면 같은 객체
    expect(a.p1.command).toContain(KEY) // 원래 활동은 그대로(판단용)
  })
  it('명령은 깨끗하고 기다림 메시지에만 비밀값이 있어도 가린다', () => {
    const a = { p1: act({ state: 'waiting', command: 'claude', message: `토큰 ${KEY} 을 넣을까요?` }) }
    const out = maskActivity(a, textMasker({}))
    expect(out['p1']!.message).not.toContain(KEY)
    expect(out['p1']!.command).toBe('claude')
  })
  it('가리개가 없으면(화면 가리기 꺼짐) 원래 객체를 그대로 돌려준다', () => {
    const a = { p1: act({ command: `echo ${KEY}` }) }
    expect(maskActivity(a, null)).toBe(a)
  })
  it('바뀐 칸이 하나도 없으면 원래 객체 (다시 그리기를 줄인다)', () => {
    const a = { p1: act({ command: 'ls' }), p2: act({}) }
    expect(maskActivity(a, textMasker({}))).toBe(a)
  })
})
