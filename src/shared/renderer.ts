// 15e: 보이는 pane 만 WebGL — Chromium 은 창당 WebGL 컨텍스트가 ~16개라, 숨은 pane 은 놓고 DOM 으로 그린다.

export type RendererMode = 'webgl' | 'dom'

/** 한 창에서 동시에 WebGL 을 쓰는 pane 수 상한 — 한도(16)의 절반 */
export const MAX_WEBGL = 8
/** 이만큼 실패(만들다 던짐 · 컨텍스트 잃음)한 pane 은 이번 실행에서 다시 시도하지 않는다 */
export const MAX_WEBGL_FAILURES = 2

export function wantWebgl(o: { mode: RendererMode; visible: boolean; inUse: number; failures: number }): boolean {
  return o.mode === 'webgl' && o.visible && o.inUse < MAX_WEBGL && o.failures < MAX_WEBGL_FAILURES
}
