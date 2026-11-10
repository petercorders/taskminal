// 15e: 보이는 pane 만 WebGL — Chromium 은 창당 WebGL 컨텍스트가 ~16개라, 숨은 pane 은 놓고 DOM 으로 그린다.

export type RendererMode = 'webgl' | 'dom'

/** 한 창에서 동시에 WebGL 을 쓰는 pane 수 상한 — 한도(16)의 절반 */
export const MAX_WEBGL = 8
/** 이만큼 실패(만들다 던짐 · 컨텍스트 잃음)한 pane 은 이번 실행에서 다시 시도하지 않는다 */
export const MAX_WEBGL_FAILURES = 2

type WebglInput = { mode: RendererMode; visible: boolean; inUse: number; failures: number }

export function wantWebgl(o: WebglInput): boolean {
  return webglBlock(o) === null
}

/** WebGL 을 못 쓰는 이유 — 'cap' 이면 자리가 나면 다시 해 볼 수 있다 (15e 리뷰) */
export function webglBlock(o: WebglInput): 'mode' | 'hidden' | 'failed' | 'cap' | null {
  if (o.mode !== 'webgl') return 'mode'
  if (!o.visible) return 'hidden'
  if (o.failures >= MAX_WEBGL_FAILURES) return 'failed'
  if (o.inUse >= MAX_WEBGL) return 'cap'
  return null
}
