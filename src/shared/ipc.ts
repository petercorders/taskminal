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
} as const

export interface AppInfo {
  name: string
  version: string
}

export interface PtySpawnOptions {
  cwd: string
  cols: number
  rows: number
}

export interface PtyExit {
  exitCode: number
  signal: number | null
}

export interface LoadedState {
  state: AppState
  /** 더 새 버전 앱이 만든 파일 — 이 앱은 그 파일을 절대 쓰지 않는다 */
  readOnly: boolean
  notice: null | 'corrupt' | 'newer'
}
