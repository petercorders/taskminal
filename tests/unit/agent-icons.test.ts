import { createHash } from 'node:crypto'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentIcon } from '../../src/renderer/AgentIcon'
import { AGENT_ICONS, AGENT_ICON_VIEWBOX } from '../../src/shared/agent-icons'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

describe('에이전트 로고 데이터', () => {
  it('두 path 가 비어 있지 않고 서로 다르다', () => {
    expect(AGENT_ICONS.claude.d.length).toBeGreaterThan(0)
    expect(AGENT_ICONS.codex.d.length).toBeGreaterThan(0)
    expect(AGENT_ICONS.claude.d).not.toBe(AGENT_ICONS.codex.d)
  })
  it('Claude 는 주황 #D97757, Codex 는 글자색 · evenodd', () => {
    expect(AGENT_ICONS.claude.fill).toBe('#D97757')
    expect(AGENT_ICONS.claude.evenOdd).toBeUndefined()
    expect(AGENT_ICONS.codex.fill).toBe('currentColor')
    expect(AGENT_ICONS.codex.evenOdd).toBe(true)
  })
  // 원본 SVG(simple-icons 16.38.0 claude · @lobehub/icons-static-svg 1.103.0 codex)의 d 를 한 글자도 고치지 않았다 — 두 path 가 뒤바뀌어도 여기서 걸린다
  it('path 는 원본 그대로다(길이 · 해시)', () => {
    expect(AGENT_ICONS.claude.d.startsWith('m4.7144 15.9555 4.7174-2.6471')).toBe(true)
    expect(AGENT_ICONS.claude.d).toHaveLength(1811)
    expect(sha(AGENT_ICONS.claude.d)).toBe('0442033dcc3824e52ffb0a07849c46becbeeacd75d1287f9081c00510e3bbf84')
    expect(AGENT_ICONS.codex.d.startsWith('M8.086.457a6.105 6.105 0 013.046-.415')).toBe(true)
    expect(AGENT_ICONS.codex.d).toHaveLength(1147)
    expect(sha(AGENT_ICONS.codex.d)).toBe('667c7f51889219b60d4b67260502b52583a29c188bde0c38fe5ac0123ce30f76')
  })
  it('두 원본 모두 24 상자다', () => {
    expect(AGENT_ICON_VIEWBOX).toBe('0 0 24 24')
  })
})

describe('AgentIcon', () => {
  const draw = (props: Parameters<typeof AgentIcon>[0]) => renderToStaticMarkup(createElement(AgentIcon, props))

  it('에이전트마다 자기 path · 채움색으로 그린다', () => {
    const claude = draw({ agent: 'claude' })
    expect(claude).toContain(`d="${AGENT_ICONS.claude.d}"`)
    expect(claude).not.toContain(AGENT_ICONS.codex.d)
    expect(claude).toContain('fill="#D97757"')
    const codex = draw({ agent: 'codex' })
    expect(codex).toContain(`d="${AGENT_ICONS.codex.d}"`)
    expect(codex).not.toContain(AGENT_ICONS.claude.d)
    expect(codex).toContain('fill="currentColor"')
    expect(codex).not.toContain('#D97757')
  })
  it('Codex 만 evenodd 로 채운다(안쪽 글자 모양이 뚫린다)', () => {
    expect(draw({ agent: 'codex' })).toContain('fill-rule="evenodd"')
    expect(draw({ agent: 'claude' })).not.toContain('fill-rule')
  })
  it('크기는 기본 14, size 로 바꾼다 — 상자는 24 그대로', () => {
    const base = draw({ agent: 'claude' })
    expect(base).toContain('width="14"')
    expect(base).toContain('height="14"')
    expect(base).toContain('viewBox="0 0 24 24"')
    const small = draw({ agent: 'codex', size: 12 })
    expect(small).toContain('width="12"')
    expect(small).toContain('height="12"')
    expect(small).toContain('viewBox="0 0 24 24"')
  })
  it('이름 글자가 옆에 있으니 화면 읽기에는 숨기고 포커스도 받지 않는다', () => {
    for (const agent of ['claude', 'codex'] as const) {
      const html = draw({ agent })
      expect(html).toContain('aria-hidden="true"')
      expect(html).toContain('focusable="false"')
      expect(html).not.toContain('<title')
    }
  })
  it('agent-icon 클래스는 늘 붙고 className 을 더한다', () => {
    expect(draw({ agent: 'claude' })).toContain('class="agent-icon"')
    expect(draw({ agent: 'claude', className: 'x' })).toContain('class="agent-icon x"')
  })
  it('svg 하나에 path 하나만 그린다', () => {
    const html = draw({ agent: 'codex' })
    expect(html.startsWith('<svg ')).toBe(true)
    expect(html.match(/<path /g)).toHaveLength(1)
  })
})
