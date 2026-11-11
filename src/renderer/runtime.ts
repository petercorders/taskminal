// 앱이 실행되는 동안만 쓰는 값 — 저장하지 않는다. App 이 appInfo 를 읽어 채운다.
import type { RendererMode } from '../shared/renderer'

export const runtime = {
  /** 이 Mac 이름 — OSC 7 의 호스트 비교 */
  host: '',
  /** 홈 폴더 — cwdLike */
  home: '',
  /** 셸 통합 없는 셸의 폴더를 lsof 로 묻는 주기 */
  cwdPollMs: 15_000,
  /** 포트 조사 주기 — 창에 포커스가 없으면 5배 (20단계) */
  portPollMs: 3000,
  /** 터미널 그리기 (15e) — appInfo 를 못 읽으면 DOM */
  renderer: 'dom' as RendererMode,
  /** 지난번 실행이 정상으로 끝나지 않았다 (18단계) */
  crashedLast: false,
  /** ⇧⌘J 에서 칠 claude 명령 (21단계) */
  claudeTui: 'claude',
  /** 같은 것 — codex (22단계) */
  codexTui: 'codex',
  /** 원격 다시 붙기 한 걸음 (25단계) */
  sshRetryMs: 1000,
}

/** 지금 WebGL 로 그리는 pane 수 · pane 마다 WebGL 실패 수 · 상한에 걸려 자리를 기다리는 pane 의 다시 해 보기 (15e) */
export const webgl = { inUse: 0, failures: new Map<string, number>(), waiting: new Set<() => void>() }

/** OSC 7 을 한 번이라도 보낸 pane — lsof 로 묻지 않는다 */
export const osc7Panes = new Set<string>()
/** 마지막 스크롤 저장 뒤 출력이 온 pane */
export const dirtyPanes = new Set<string>()
/** 이번 실행에서 이전 출력을 이미 되살린 pane — 다시 마운트 · StrictMode 두 번 마운트에도 한 번만 */
export const restoredPanes = new Set<string>()
/** 이전 출력이 실제로 있어 되살린 pane — 셸 지킴이 없이 새로 띄웠다는 안내를 보일지 (16단계) */
export const restoredWithText = new Set<string>()

/** ⌘F 찾기 막대가 열린 pane — 찾기가 만드는 선택은 '선택하면 복사' 로 클립보드에 넣지 않는다 (15d) */
export const findingPanes = new Set<string>()
/** 셸 통합 신호(OSC 133)를 한 번이라도 보낸 pane — 명령 기록이 비어 있는 이유를 알릴 때 (19단계) */
export const integratedPanes = new Set<string>()
/** 원격(ssh) pane — 로컬 pid 가 아니라 lsof 폴더 · 포트 조사에서 뺀다 (25단계) */
export const remotePanes = new Set<string>()
