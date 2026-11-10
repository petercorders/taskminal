// main · preload 가 함께 쓰는 IPC 채널 이름. renderer 는 채널을 모르고 preload API 만 부른다.
export const IPC = {
  appInfo: 'app:info',
} as const

export interface AppInfo {
  name: string
  version: string
}
