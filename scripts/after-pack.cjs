// electron-builder afterPack: .app 안 node-pty 의 spawn-helper 에 실행 권한을 준다.
// npm 패키지에 권한이 빠져 있고(postinstall 이 개발 폴더만 고침), 복사가 권한을 그대로 옮긴다고 믿지 않는다 — 없으면 셸이 posix_spawnp failed.
const { chmodSync, existsSync, readdirSync } = require('node:fs')
const { join } = require('node:path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const pty = join(app, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', 'node-pty')
  if (!existsSync(pty)) throw new Error(`node-pty 가 asar 밖에 없음: ${pty}`)
  // node-pty 는 build/Release → build/Debug → prebuilds 순으로 찾는다 — 소스 빌드가 남아 있으면 그쪽 spawn-helper 를 쓴다
  const prebuilds = join(pty, 'prebuilds')
  const dirs = ['build/Release', 'build/Debug'].map((d) => join(pty, d))
  if (existsSync(prebuilds)) for (const platform of readdirSync(prebuilds)) dirs.push(join(prebuilds, platform))
  for (const dir of dirs) {
    const helper = join(dir, 'spawn-helper')
    if (existsSync(helper)) chmodSync(helper, 0o755)
  }
}
