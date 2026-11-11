// 대화 pane 하나가 쓰는 에이전트 세션의 겉모양 — Claude(stream-json) · Codex(app-server) 가 같은 것을 낸다 (22단계)
import type { ChatDecision, ChatImage, ChatPermission } from '../../shared/chat'

export interface AgentSession {
  /** 턴이 열려 있다 (보냈고 끝 · 멈춤을 아직 못 받음) */
  readonly busy: boolean
  /** 새 턴을 보낸다. 턴이 열려 있으면 false (한 번에 하나) */
  send(text: string, images?: readonly ChatImage[]): boolean
  /** 허락 · 질문 답. 같은 요청에 두 번 · 그 사이 끝났으면 false */
  answer(requestId: string, d: ChatDecision): boolean
  interrupt(): boolean
  setPermission(p: ChatPermission): void
  /** 되감기 · 나누기 — 다음 보내기가 그 자리에서 갈라진 세션으로. at = null 이면 새 세션 */
  fork(sessionId: string | undefined, at: string | null): void
  kill(): void
}
