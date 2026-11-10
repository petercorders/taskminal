// electron-builder afterPack: .app 안 node-pty 의 spawn-helper 에 실행 권한을 준다.
// npm 패키지에 권한이 빠져 있고(postinstall 이 개발 폴더만 고침), 복사가 권한을 그대로 옮긴다고 믿지 않는다 — 없으면 셸이 posix_spawnp failed.
const { chmodSync, existsSync, readdirSync } = require('node:fs')
const { join } = require('node:path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const prebuilds = join(app, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', 'node-pty', 'prebuilds')
  if (!existsSync(prebuilds)) throw new Error(`node-pty prebuilds 가 asar 밖에 없음: ${prebuilds}`)
  for (const platform of readdirSync(prebuilds)) {
    const helper = join(prebuilds, platform, 'spawn-helper')
    if (existsSync(helper)) chmodSync(helper, 0o755)
  }
}
