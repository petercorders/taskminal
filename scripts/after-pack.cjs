// electron-builder afterPack: .app 안 node-pty 의 spawn-helper 에 실행 권한을 준다.
// npm 패키지에 권한이 빠져 있고(postinstall 이 개발 폴더만 고침), 복사가 권한을 그대로 옮긴다고 믿지 않는다 — 없으면 셸이 posix_spawnp failed.
const { chmodSync, existsSync, readdirSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { Arch } = require('builder-util')

// 이 경로는 복사된 패키지 내부여야 한다. 개발용 node_modules 를 바꾸지 않는다.
function preparePty(pty, platform, arch) {
  if (!existsSync(pty)) throw new Error(`node-pty 가 asar 밖에 없음: ${pty}`)
  const prebuilds = join(pty, 'prebuilds')
  const target = `${platform}-${arch}`
  const selected = join(prebuilds, target)
  const hasPrebuild = existsSync(join(selected, 'pty.node'))
  if (existsSync(prebuilds)) {
    for (const name of readdirSync(prebuilds)) {
      if (name !== target) rmSync(join(prebuilds, name), { recursive: true, force: true })
    }
  }
  // node-pty 는 build 를 prebuilds 보다 먼저 읽는다. 교차 아키텍처 빌드에서
  // 개발 머신의 바이너리가 대상 prebuild 를 가로채지 못하게 한다.
  if (hasPrebuild) rmSync(join(pty, 'build'), { recursive: true, force: true })
  const dirs = hasPrebuild ? [selected] : ['build/Release', 'build/Debug'].map((d) => join(pty, d))
  const nativeDir = dirs.find((d) => existsSync(join(d, 'pty.node')))
  if (!nativeDir) throw new Error(`대상 ${target} 의 node-pty 네이티브 모듈이 없음`)
  if (platform === 'darwin') {
    const helper = join(nativeDir, 'spawn-helper')
    if (!existsSync(helper)) throw new Error(`node-pty spawn-helper 없음: ${helper}`)
    chmodSync(helper, 0o755)
  } else if (platform === 'win32' && !existsSync(join(nativeDir, 'conpty.node'))) {
    throw new Error(`node-pty conpty.node 없음: ${nativeDir}`)
  }
}

exports.preparePty = preparePty

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName
  const resources = platform === 'darwin'
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : join(context.appOutDir, 'resources')
  preparePty(join(resources, 'app.asar.unpacked', 'node_modules', 'node-pty'), platform, Arch[context.arch])
}
