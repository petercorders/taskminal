import type { AppState } from './types'

// main · preload 가 함께 쓰는 IPC 채널 이름. renderer 는 채널을 모르고 preload API 만 부른다.
export const IPC = {
  appInfo: 'app:info',
  ptySpawn: 'pty:spawn', // invoke
  ptyWrite: 'pty:write', // send
  ptyResize: 'pty:resize', // send
  ptyKill: 'pty:kill', // send
  ptyData: 'pty:data', // main → renderer
  ptyExit: 'pty:exit', // main → renderer
  stateLoad: 'state:load', // invoke
  stateSave: 'state:save', // send (main 이 디바운스)
  stateError: 'state:error', // main → renderer: 저장 실패
  pickFolder: 'dialog:pick-folder', // invoke → 경로 또는 null
  appCommand: 'app:command', // main → renderer: 메뉴에서 고른 명령 (AppCommand)
  quitGuard: 'app:quit-guard', // send: 실행 중 명령 수 (끄기 전 확인이 꺼져 있으면 0)
  badge: 'app:badge', // send: Dock 배지 수 (0 = 지움)
  beep: 'app:beep', // send: 알림 소리만
  menuKeys: 'menu:keys', // send: 바꾼 단축키 (settings.keys) → 메뉴 표시를 다시 만든다
} as const

export interface AppInfo {
  name: string
  version: string
}

export interface PtySpawnOptions {
  cwd: string
  cols: number
  rows: number
  /** 설정의 셸 경로 (null = 로그인 셸). main 이 /etc/shells 에 있는 것만 받는다 */
  shell?: string | null
  /** 셸 통합(zsh) — 끄면 사용자 설정만 읽는다 */
  integration?: boolean
}

export interface PtyExit {
  exitCode: number
  signal: number | null
}

export interface LoadedState {
  state: AppState
  /** 더 새 버전 앱이 만든 파일 — 이 앱은 그 파일을 절대 쓰지 않는다 */
  readOnly: boolean
  /** corrupt: JSON 이 아니라 옮겨 둠 · repaired: 검증이 일부를 버려 원본을 복사해 둠 · newer: 모르는 형식이라 읽기 전용 */
  notice: null | 'corrupt' | 'repaired' | 'newer'
}
