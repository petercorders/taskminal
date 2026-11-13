// Windows / Linux 패키지 구조와 실제 네이티브 바이너리의 OS·칩을 확인한다.
// 실제 셸 실행 검증은 tests/e2e/platform-smoke.spec.ts 에서 별도로 한다.
import { listPackage } from '@electron/asar'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export function nativeArchitecture(file, platform) {
  const b = readFileSync(file)
  if (platform === 'linux') {
    if (b.length < 20 || b.subarray(0, 4).toString('hex') !== '7f454c46' || b[4] !== 2 || b[5] !== 1) return null
    return b.readUInt16LE(18) === 62 ? 'x64' : null
  }
  if (platform === 'win32') {
    if (b.length < 64 || b.subarray(0, 2).toString() !== 'MZ') return null
    const offset = b.readUInt32LE(60)
    if (offset > b.length - 6 || b.subarray(offset, offset + 4).toString('hex') !== '50450000') return null
    return b.readUInt16LE(offset + 4) === 0x8664 ? 'x64' : null
  }
  return null
}

export function checkPlatformPackage(appPath, { platform, arch }) {
  const problems = []
  const res = join(appPath, 'resources')
  const asar = join(res, 'app.asar')
  if (!existsSync(asar)) return [`app.asar 없음: ${asar}`]
  const entries = new Set(listPackage(asar, {}).map((e) => e.replace(/^[/\\]/, '').replace(/\\/g, '/')))
  for (const f of ['out/main/index.js', 'out/main/host.js', 'out/main/cli.js', 'out/preload/index.js', 'out/renderer/index.html', 'node_modules/@xterm/headless/package.json']) {
    if (!entries.has(f)) problems.push(`app.asar 안에 ${f} 없음`)
  }
  const binary = join(appPath, platform === 'win32' ? 'Taskminal.exe' : 'taskminal')
  const verifyNative = (file) => {
    if (!existsSync(file)) problems.push(`네이티브 파일 없음: ${file}`)
    else if (nativeArchitecture(file, platform) !== arch) problems.push(`네이티브 OS/칩 불일치 (${platform}-${arch}): ${file}`)
  }
  verifyNative(binary)
  if (platform === 'linux' && existsSync(binary) && (statSync(binary).mode & 0o111) === 0) problems.push(`앱 실행 권한 없음: ${binary}`)
  const pty = join(res, 'app.asar.unpacked', 'node_modules', 'node-pty')
  const dirs = ['build/Release', 'build/Debug', `prebuilds/${platform}-${arch}`]
  const nativeDir = dirs.find((d) => existsSync(join(pty, d, 'pty.node')))
  if (!nativeDir) problems.push(`asar 밖 node-pty 없음: ${platform}-${arch}`)
  else {
    verifyNative(join(pty, nativeDir, 'pty.node'))
    if (platform === 'win32') {
      for (const name of ['conpty.node', 'conpty_console_list.node']) verifyNative(join(pty, nativeDir, name))
    }
  }
  const prebuilds = join(pty, 'prebuilds')
  if (existsSync(prebuilds)) for (const name of readdirSync(prebuilds)) {
    if (name !== `${platform}-${arch}`) problems.push(`다른 OS/칩의 node-pty 포함: ${name}`)
  }
  return problems
}
