import { posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Renderer의 정확한 파일만 신뢰한다. Windows file URL은 /C:/… pathname과 실제 경로가 다르다. */
export function isAppPage(url: string, rendererFile: string, devServerUrl?: string, platform: string = process.platform): boolean {
  try {
    const u = new URL(url)
    if (devServerUrl) return u.origin === new URL(devServerUrl).origin
    if (u.protocol !== 'file:' || u.hostname || /%(?:2f|5c)/i.test(u.pathname)) return false
    const windows = platform === 'win32'
    const path = windows ? win32 : posix
    if (!path.isAbsolute(rendererFile)) return false
    const actual = path.normalize(fileURLToPath(u, { windows }))
    const expected = path.normalize(rendererFile)
    return windows ? actual.toLowerCase() === expected.toLowerCase() : actual === expected
  } catch {
    return false
  }
}
