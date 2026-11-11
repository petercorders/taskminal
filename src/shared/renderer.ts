// 15e: 보이는 pane 만 WebGL — Chromium 은 창당 WebGL 컨텍스트가 ~16개라, 숨은 pane 은 놓고 DOM 으로 그린다.

/** webgl = 보이고 배율 2 이상이면 WebGL · webgl-always = 배율과 상관없이(시험) · dom = 늘 DOM */
export type RendererMode = 'webgl' | 'webgl-always' | 'dom'

/** TASKMINAL_RENDERER 값 → 모드. 'webgl' 을 일부러 준 시험만 배율을 보지 않는다 */
export function rendererFromEnv(v: string | undefined): RendererMode {
  return v === 'dom' ? 'dom' : v === 'webgl' ? 'webgl-always' : 'webgl'
}

/** 한 창에서 동시에 WebGL 을 쓰는 pane 수 상한 — 한도(16)의 절반 */
export const MAX_WEBGL = 8
/** 이만큼 실패(만들다 던짐 · 컨텍스트 잃음)한 pane 은 이번 실행에서 다시 시도하지 않는다 */
export const MAX_WEBGL_FAILURES = 2

/** dpr: window.devicePixelRatio */
type WebglInput = { mode: RendererMode; visible: boolean; inUse: number; failures: number; dpr: number }

export function wantWebgl(o: WebglInput): boolean {
  return webglBlock(o) === null
}

/** WebGL 을 못 쓰는 이유 — 'cap' 이면 자리가 나면 다시 해 볼 수 있다 (15e 리뷰) */
export function webglBlock(o: WebglInput): 'mode' | 'hidden' | 'lowdpi' | 'failed' | 'cap' | null {
  if (o.mode === 'dom') return 'mode'
  if (!o.visible) return 'hidden'
  // 27단계: 배율 1 화면에서 WebGL 은 글자를 칸보다 작게 그려 띄엄띄엄 보인다(xterm 6 · addon-webgl 0.19, 이 Mac 실측) → DOM
  if (o.mode === 'webgl' && o.dpr < 2) return 'lowdpi'
  if (o.failures >= MAX_WEBGL_FAILURES) return 'failed'
  if (o.inUse >= MAX_WEBGL) return 'cap'
  return null
}
