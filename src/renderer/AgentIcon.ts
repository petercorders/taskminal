// 59단계: AI 도구 로고(Claude · Codex) — 에이전트 이름 앞에 붙인다. icons.tsx 의 선 아이콘(16 상자 · stroke)과 달리 24 상자를 채워 그려서 따로 둔다.
// path · 색은 src/shared/agent-icons.ts — 출처: simple-icons 16.38.0 claude (CC0-1.0) · @lobehub/icons-static-svg 1.103.0 codex (MIT).
// 로고는 각 회사(Anthropic · OpenAI)의 상표이고, 어느 도구인지 알리는 데만 쓴다.
// JSX 없이 쓴다 — 단위 시험(tests/ 는 jsx 설정이 없는 tsconfig.node.json 으로 타입 검사)이 .tsx 를 import 하지 못한다(TS6142).
import { createElement } from 'react'
import { AGENT_ICONS, AGENT_ICON_VIEWBOX } from '../shared/agent-icons'
import type { ChatAgent } from '../shared/chat'

/** 이름 글자가 바로 옆에 있는 자리에 쓴다 — 그래서 화면 읽기에는 숨긴다. size 는 옆 글자 크기 이하로(줄 높이가 늘지 않게) */
export function AgentIcon({ agent, size = 14, className }: { agent: ChatAgent; size?: number; className?: string }) {
  const icon = AGENT_ICONS[agent]
  return createElement(
    'svg',
    { className: `agent-icon${className ? ` ${className}` : ''}`, width: size, height: size, viewBox: AGENT_ICON_VIEWBOX, fill: icon.fill, 'aria-hidden': true, focusable: false },
    createElement('path', { d: icon.d, ...(icon.evenOdd ? { fillRule: 'evenodd' as const } : {}) }),
  )
}
