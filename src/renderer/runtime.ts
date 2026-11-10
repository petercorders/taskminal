// 앱이 실행되는 동안만 쓰는 값 — 저장하지 않는다. App 이 appInfo 를 읽어 채운다.

export const runtime = {
  /** 이 Mac 이름 — OSC 7 의 호스트 비교 */
  host: '',
  /** 홈 폴더 — cwdLike */
  home: '',
  /** 셸 통합 없는 셸의 폴더를 lsof 로 묻는 주기 */
  cwdPollMs: 15_000,
}

/** OSC 7 을 한 번이라도 보낸 pane — lsof 로 묻지 않는다 */
export const osc7Panes = new Set<string>()
/** 마지막 스크롤 저장 뒤 출력이 온 pane */
export const dirtyPanes = new Set<string>()
/** 이번 실행에서 이전 출력을 이미 되살린 pane — 다시 마운트 · StrictMode 두 번 마운트에도 한 번만 */
export const restoredPanes = new Set<string>()
