// 네이티브 OS 러너에서 패키지를 만든다. 게시하지 않으며 실행 중인 dist/mac-arm64 를 덮어쓰지 않는다.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { checkPackage, checkRelease } from './check-package.mjs'
import { checkPlatformPackage } from './check-platform-package.mjs'

export function packagePlan({ platform, arch, version, output, identity }) {
  if (!(platform === 'darwin' && ['arm64', 'x64'].includes(arch)) && !(['win32', 'linux'].includes(platform) && arch === 'x64')) throw new Error(`지원하지 않는 플랫폼: ${platform}-${arch}`)
  const os = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : 'linux'
  const dir = output ?? `dist/releases/${version}-${os}-${arch}`
  const args = platform === 'darwin' ? ['--mac', 'dmg', 'zip'] : platform === 'win32' ? ['--win', 'nsis'] : ['--linux', 'AppImage', 'deb']
  args.push(`--${arch}`, '--publish', 'never', `-c.directories.output=${dir}`)
  if (platform === 'darwin' && identity) args.push(`-c.mac.identity=${identity}`)
  const app = platform === 'darwin' ? join(dir, arch === 'arm64' ? 'mac-arm64' : 'mac', 'Taskminal.app') : join(dir, platform === 'win32' ? 'win-unpacked' : 'linux-unpacked')
  const executable = platform === 'darwin' ? join(app, 'Contents', 'MacOS', 'Taskminal') : join(app, platform === 'win32' ? 'Taskminal.exe' : 'taskminal')
  return { platform, arch, version, output: dir, args, app, executable }
}

function run(args) {
  // Node로 CLI를 직접 호출해 Windows의 .cmd/cmd.exe가 인자를 다시 해석하지 않게 한다.
  const require = createRequire(import.meta.url)
  const name = args[0]
  const pkgPath = require.resolve(`${name}/package.json`)
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const cli = resolve(pkgPath, '..', typeof pkg.bin === 'string' ? pkg.bin : pkg.bin[name])
  const result = spawnSync(process.execPath, [cli, ...args.slice(1)], { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const opts = process.argv.slice(2)
  const value = (flag) => { const at = opts.indexOf(flag); return at < 0 ? undefined : opts[at + 1] }
  const arch = value('--arch') ?? process.arch
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version
  const plan = packagePlan({ platform: process.platform, arch, version, output: value('--output'), identity: process.env.TASKMINAL_SIGN_IDENTITY })
  if (process.platform !== 'darwin' && arch !== process.arch) throw new Error('네이티브 OS·칩 러너에서 빌드해야 합니다')
  if (existsSync(plan.output)) throw new Error(`기존 산출물을 덮어쓰지 않음: ${plan.output} — 다른 --output 을 지정하세요`)
  run(['electron-vite', 'build'])
  run(['electron-builder', ...plan.args])
  const problems = process.platform === 'darwin'
    ? [...await checkPackage(plan.app, { expectedArch: arch }), ...(opts.includes('--release') ? checkRelease(plan.app, plan.output, { expectedArch: arch }) : [])]
    : checkPlatformPackage(plan.app, { platform: process.platform, arch })
  if (problems.length) { for (const problem of problems) console.error(problem); process.exit(1) }
  mkdirSync(plan.output, { recursive: true })
  writeFileSync(join(plan.output, 'package-plan.json'), `${JSON.stringify({ ...plan, app: resolve(plan.app), executable: resolve(plan.executable) }, null, 2)}\n`)
  console.log(`패키지 정적 검사 완료: ${plan.executable}`)
}
