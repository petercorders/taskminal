import { describe, expect, it } from 'vitest'
import { defaultSettings } from '../../src/shared/model'
import { parseTemplateJson, templateToJson } from '../../src/shared/template-json'

const errorsOf = (text: string) => {
  const r = parseTemplateJson(text)
  if (r.ok) throw new Error('오류가 나야 한다')
  return r.errors
}

describe('parseTemplateJson — 문법 오류는 줄 번호와 함께', () => {
  it('빠진 쉼표', () => {
    const text = '{\n  "name": "A"\n  "tabs": []\n}'
    expect(errorsOf(text)).toEqual([{ line: 3, message: expect.stringContaining('쉼표') }])
  })

  it('닫히지 않은 문자열 · 끝난 글', () => {
    expect(errorsOf('{\n  "name": "A\n}')[0]!.line).toBe(2)
    expect(errorsOf('{\n  "name": "A",\n')[0]!.message).toContain('끝')
  })

  it('끝에 남는 글 · 끝 쉼표', () => {
    expect(errorsOf('{"name":"A","tabs":[{"layout":{"pane":{}}}]}\nx')[0]!.line).toBe(2)
    expect(errorsOf('{\n "name": "A",\n "tabs": [],\n}')[0]!.line).toBe(4)
  })

  it('빈 글', () => {
    expect(errorsOf('   ')[0]).toEqual({ line: 1, message: expect.any(String) })
  })
})

describe('parseTemplateJson — 모양 오류도 그 줄', () => {
  const ok = (layout: string) => `{\n  "name": "A",\n  "tabs": [\n    { "layout": ${layout} }\n  ]\n}`

  it('모르는 키는 오타일 수 있다 → 쓸 수 있는 키와 함께', () => {
    const [e] = errorsOf(ok('{ "pane": {\n "comand": "x" } }'))
    expect(e).toEqual({ line: 5, message: expect.stringMatching(/comand.*command/) })
  })

  it('이름 · 탭 · 형', () => {
    expect(errorsOf('{\n  "name": "  ",\n  "tabs": [{ "layout": { "pane": {} } }]\n}')).toEqual([{ line: 2, message: expect.stringContaining('name') }])
    expect(errorsOf('{\n  "name": "A",\n  "tabs": []\n}')).toEqual([{ line: 3, message: expect.stringContaining('하나 이상') }])
    expect(errorsOf('{ "tabs": [{ "layout": { "pane": {} } }] }')[0]!.message).toContain('name')
    expect(errorsOf('[1]')[0]!.message).toContain('객체')
    expect(errorsOf(ok('{ "pane": { "command": 3 } }'))[0]).toEqual({ line: 4, message: expect.stringContaining('command') })
  })

  it('분할: 방향 · 비율 · a/b · pane 과 split 을 함께', () => {
    expect(errorsOf(ok('{ "split": "left", "a": { "pane": {} }, "b": { "pane": {} } }'))[0]!.message).toContain('right')
    expect(errorsOf(ok('{ "split": "down", "ratio": 1.5, "a": { "pane": {} }, "b": { "pane": {} } }'))[0]!.message).toContain('0.1')
    expect(errorsOf(ok('{ "split": "down", "a": { "pane": {} } }'))[0]!.message).toContain('"b"')
    expect(errorsOf(ok('{ "pane": {}, "split": "down" }'))[0]!.message).toContain('하나만')
    expect(errorsOf(ok('{}'))[0]!.message).toContain('pane')
  })

  it('같은 키 두 번 · 여러 오류는 모두 줄 순서대로', () => {
    const errs = errorsOf('{\n  "name": "A",\n  "name": "B",\n  "tabs": [{ "title": 1, "layout": { "pane": { "cwd": 2 } } }]\n}')
    expect(errs.map((e) => e.line)).toEqual([3, 4, 4])
    // 맨 바깥의 모르는 키(4번째 줄)는 이름 검사(2번째 줄)보다 먼저 발견된다 — 그래도 줄 순서로
    const later = errorsOf('{\n  "name": "",\n  "tabs": [{ "layout": { "pane": {} } }],\n  "x": 1\n}')
    expect(later.map((e) => e.line)).toEqual([2, 4])
  })
})

describe('templateToJson ↔ parseTemplateJson', () => {
  it('기본 템플릿은 모두 왕복한다 (id 는 빼고)', () => {
    const templates = defaultSettings().templates
    expect(templates.length).toBeGreaterThanOrEqual(3)
    for (const t of templates) {
      const text = templateToJson(t)
      expect(text).not.toContain('"id"')
      expect(parseTemplateJson(text)).toEqual({ ok: true, value: { name: t.name, tabs: t.tabs } })
    }
  })

  it('이름 앞뒤 공백은 지운다', () => {
    const r = parseTemplateJson('{"name":" A ","tabs":[{"title":"t","layout":{"split":"right","ratio":0.3,"a":{"pane":{"command":"c","cwd":"x"}},"b":{"pane":{}}}}]}')
    expect(r).toEqual({
      ok: true,
      value: { name: 'A', tabs: [{ title: 't', layout: { split: 'right', ratio: 0.3, a: { pane: { command: 'c', cwd: 'x' } }, b: { pane: {} } } }] },
    })
  })
})
