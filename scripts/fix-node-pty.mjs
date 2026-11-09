// node-pty 1.1.0 의 npm 패키지는 prebuilds/*/spawn-helper 에 실행 권한이 빠져 있어
// pty.spawn 이 "posix_spawnp failed" 로 실패한다. 설치 직후 권한을 되돌린다.
import { chmodSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const dir = join(import.meta.dirname, '..', 'node_modules', 'node-pty', 'prebuilds')
if (existsSync(dir)) {
  for (const platform of readdirSync(dir)) {
    const helper = join(dir, platform, 'spawn-helper')
    if (existsSync(helper)) chmodSync(helper, 0o755)
  }
}
