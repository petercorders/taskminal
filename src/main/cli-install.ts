// 명령줄 도구 설치 (24단계) — 앱 메뉴에서 사용자가 눌렀을 때만 `<dir>/taskminal` → 앱 안 resources/bin/taskminal 링크.
// 사용자의 셸 설정(~/.zshrc 등)은 건드리지 않는다. 쓸 수 없는 폴더면 직접 칠 sudo 명령을 돌려준다.
import { lstatSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

export type InstallResult =
  | { kind: 'installed'; path: string }
  | { kind: 'already'; path: string }
  /** 우리 것이 아닌 파일이 그 자리에 있다 — 덮지 않는다 */
  | { kind: 'conflict'; path: string }
  /** 쓸 수 없다 — 사용자가 칠 명령 */
  | { kind: 'denied'; path: string; command: string }

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

export function installCli(source: string, dir: string): InstallResult {
  const path = join(dir, 'taskminal')
  let existing: string | null = null
  try {
    const st = lstatSync(path)
    if (!st.isSymbolicLink()) return { kind: 'conflict', path }
    existing = readlinkSync(path)
  } catch {
    // 없음
  }
  if (existing === source) return { kind: 'already', path }
  // 옛 앱 자리(옮긴 .app · 개발 폴더)를 가리키는 우리 링크면 바꾼다 — 끝이 bin/taskminal 인 링크만
  if (existing !== null && !/\/bin\/taskminal$/.test(existing)) return { kind: 'conflict', path }
  try {
    if (existing !== null) unlinkSync(path)
    symlinkSync(source, path)
    return { kind: 'installed', path }
  } catch {
    return { kind: 'denied', path, command: `sudo mkdir -p ${quote(dir)} && sudo ln -sf ${quote(source)} ${quote(path)}` }
  }
}
