// 만든 .app 을 실행하지 않고 안을 읽어 확인한다 (14단계).
//   node scripts/check-package.mjs dist/mac-arm64/Taskminal.app
// 문제마다 한 줄, 있으면 exit 1. 실행 확인(셸 · which node · 한글)은 따로 — 이 검사는 '빠진 파일 · 권한' 을 잡는다.
import { listPackage } from '@electron/asar'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const BUNDLE_ID = 'io.peterbong.taskminal'
const ASAR_ENTRIES = ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html', 'package.json']
// zsh 가 ZDOTDIR 에서 읽는 점 파일 — 하나라도 빠지면 셸 통합 없이(또는 사용자 설정 없이) 뜬다
const SHELL_FILES = ['.zshenv', '.zprofile', '.zshrc', '.zlogin', 'taskminal-hooks.zsh']

const plistValue = (plist, key) => {
  const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(plist)
  return m ? m[1] : null
}

const lipoArch = (bin) => execFileSync('/usr/bin/lipo', ['-archs', bin], { encoding: 'utf8' }).trim()

/** @returns {Promise<string[]>} 문제 목록 (빈 배열 = 통과) */
export async function checkPackage(appPath, { arch = lipoArch } = {}) {
  const problems = []
  const c = join(appPath, 'Contents')
  const res = join(c, 'Resources')
  if (!existsSync(c)) return [`.app 이 아님 (Contents 없음): ${appPath}`]

  const plistPath = join(c, 'Info.plist')
  const plist = existsSync(plistPath) ? readFileSync(plistPath, 'utf8') : ''
  const id = plistValue(plist, 'CFBundleIdentifier')
  if (id !== BUNDLE_ID) problems.push(`Info.plist CFBundleIdentifier 가 ${BUNDLE_ID} 가 아님: ${id}`)
  const icon = plistValue(plist, 'CFBundleIconFile')
  const iconFile = icon ? (icon.endsWith('.icns') ? icon : `${icon}.icns`) : 'icon.icns'
  if (!existsSync(join(res, iconFile))) problems.push(`아이콘 파일 없음: Resources/${iconFile}`)

  const asar = join(res, 'app.asar')
  if (!existsSync(asar)) {
    problems.push('Resources/app.asar 없음')
  } else {
    const entries = new Set(listPackage(asar, {}).map((e) => e.replace(/^[/\\]/, '').replace(/\\/g, '/')))
    for (const e of ASAR_ENTRIES) if (!entries.has(e)) problems.push(`app.asar 안에 ${e} 없음`)
  }

  // node-pty: 네이티브 모듈 · spawn-helper 는 asar 밖에서만 실행된다. spawn-helper 에 실행 권한이 없으면 posix_spawnp failed
  const pty = join(res, 'app.asar.unpacked', 'node_modules', 'node-pty', 'prebuilds', 'darwin-arm64')
  for (const f of ['pty.node', 'spawn-helper']) if (!existsSync(join(pty, f))) problems.push(`asar 밖 node-pty 에 ${f} 없음 (asarUnpack)`)
  const helper = join(pty, 'spawn-helper')
  if (existsSync(helper) && (statSync(helper).mode & 0o111) === 0) problems.push('spawn-helper 에 실행 권한이 없음 — 셸이 posix_spawnp failed 로 안 뜬다')

  const zsh = join(res, 'shell', 'zsh')
  for (const f of SHELL_FILES) if (!existsSync(join(zsh, f))) problems.push(`셸 통합 파일 없음: Resources/shell/zsh/${f} (extraResources)`)

  const bin = join(c, 'MacOS', 'Taskminal')
  if (!existsSync(bin)) problems.push('실행 파일 없음: Contents/MacOS/Taskminal')
  else {
    let a = ''
    try {
      a = arch(bin)
    } catch (e) {
      a = `알 수 없음 (${e})`
    }
    if (!a.split(/\s+/).includes('arm64')) problems.push(`실행 파일이 arm64 가 아님: ${a}`)
  }
  return problems
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const app = process.argv[2]
  if (!app) {
    console.error('사용법: node scripts/check-package.mjs <Taskminal.app 경로>')
    process.exit(2)
  }
  const problems = await checkPackage(app)
  for (const p of problems) console.log(`✗ ${p}`)
  if (problems.length) process.exit(1)
  console.log(`✓ 패키지 검사 통과: ${app}`)
}
