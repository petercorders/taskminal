// 만든 .app 을 실행하지 않고 안을 읽어 확인한다 (14단계).
//   node scripts/check-package.mjs dist/mac-arm64/Taskminal.app
// 문제마다 한 줄, 있으면 exit 1. 실행 확인(셸 · which node · 한글)은 따로 — 이 검사는 '빠진 파일 · 권한' 을 잡는다.
import { listPackage } from '@electron/asar'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const BUNDLE_ID = 'io.peterbong.taskminal'
// host.js = 셸 지킴이(16단계, ELECTRON_RUN_AS_NODE 로 asar 안에서 돈다) · cli.js = taskminal 명령(24단계) · @xterm/headless 는 지킴이가 require 한다(번들 밖 dependency)
const ASAR_ENTRIES = ['out/main/index.js', 'out/main/host.js', 'out/main/cli.js', 'out/preload/index.js', 'out/renderer/index.html', 'package.json', 'node_modules/@xterm/headless/package.json']
// zsh 가 ZDOTDIR 에서 읽는 점 파일 — 하나라도 빠지면 셸 통합 없이(또는 사용자 설정 없이) 뜬다
// 이 밖의 파일(개발 중 생긴 .zsh_history · .zcompdump …)이 들어가면 개발자의 명령 기록이 .app 에 실린다 — 목록 밖은 문제로 본다
const SHELL_FILES = ['.zshenv', '.zprofile', '.zshrc', '.zlogin', 'taskminal-hooks.zsh']
// node-pty(lib/utils.js loadNativeModule)가 pty.node 를 찾는 순서 — 처음 있는 곳의 spawn-helper 를 쓴다
const PTY_DIRS = ['build/Release', 'build/Debug', 'prebuilds/darwin-arm64']

const plistValue = (plist, key) => {
  const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(plist)
  return m ? m[1] : null
}

const lipoArch = (bin) => execFileSync('/usr/bin/lipo', ['-archs', bin], { encoding: 'utf8' }).trim()
// 서명이 없거나 깨졌으면 던진다 (ad-hoc 이면 통과)
const codesignVerify = (app) => execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' })

/** @returns {Promise<string[]>} 문제 목록 (빈 배열 = 통과) */
export async function checkPackage(appPath, { arch = lipoArch, verify = codesignVerify } = {}) {
  const problems = []
  const c = join(appPath, 'Contents')
  const res = join(c, 'Resources')
  if (!existsSync(c)) return [`.app 이 아님 (Contents 없음): ${appPath}`]

  const plistPath = join(c, 'Info.plist')
  const plist = existsSync(plistPath) ? readFileSync(plistPath, 'utf8') : ''
  const id = plistValue(plist, 'CFBundleIdentifier')
  if (id !== BUNDLE_ID) problems.push(`Info.plist CFBundleIdentifier 가 ${BUNDLE_ID} 가 아님: ${id}`)
  const name = plistValue(plist, 'CFBundleName')
  if (name !== 'Taskminal') problems.push(`Info.plist CFBundleName 이 Taskminal 이 아님: ${name}`)
  const icon = plistValue(plist, 'CFBundleIconFile')
  if (!icon) problems.push('Info.plist 에 CFBundleIconFile 없음 — Finder · Dock 이 기본 아이콘')
  else {
    const iconFile = icon.endsWith('.icns') ? icon : `${icon}.icns`
    if (!existsSync(join(res, iconFile))) problems.push(`아이콘 파일 없음: Resources/${iconFile}`)
  }

  const asar = join(res, 'app.asar')
  if (!existsSync(asar)) {
    problems.push('Resources/app.asar 없음')
  } else {
    const entries = new Set(listPackage(asar, {}).map((e) => e.replace(/^[/\\]/, '').replace(/\\/g, '/')))
    for (const e of ASAR_ENTRIES) if (!entries.has(e)) problems.push(`app.asar 안에 ${e} 없음`)
  }

  // node-pty: 네이티브 모듈 · spawn-helper 는 asar 밖에서만 실행된다. spawn-helper 에 실행 권한이 없으면 posix_spawnp failed
  const ptyRoot = join(res, 'app.asar.unpacked', 'node_modules', 'node-pty')
  const ptyDir = PTY_DIRS.find((d) => existsSync(join(ptyRoot, d, 'pty.node')))
  if (!ptyDir) problems.push(`asar 밖 node-pty 에 pty.node 없음 (asarUnpack, 찾는 곳: ${PTY_DIRS.join(' · ')})`)
  else {
    const helper = join(ptyRoot, ptyDir, 'spawn-helper')
    if (!existsSync(helper)) problems.push(`asar 밖 node-pty 에 spawn-helper 없음: ${ptyDir}`)
    else if ((statSync(helper).mode & 0o111) === 0) problems.push(`${ptyDir}/spawn-helper 에 실행 권한이 없음 — 셸이 posix_spawnp failed 로 안 뜬다`)
  }

  const zsh = join(res, 'shell', 'zsh')
  for (const f of SHELL_FILES) if (!existsSync(join(zsh, f))) problems.push(`셸 통합 파일 없음: Resources/shell/zsh/${f} (extraResources)`)
  if (existsSync(zsh)) for (const f of readdirSync(zsh)) if (!SHELL_FILES.includes(f)) problems.push(`셸 폴더에 넣지 말아야 할 파일: Resources/shell/zsh/${f}`)

  // taskminal 명령(24단계) — 실행 권한이 없으면 링크로 불러도 'permission denied'
  const cli = join(res, 'bin', 'taskminal')
  if (!existsSync(cli)) problems.push('명령줄 도구 없음: Resources/bin/taskminal (extraResources)')
  else if ((statSync(cli).mode & 0o111) === 0) problems.push('Resources/bin/taskminal 에 실행 권한이 없음')

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
  // 서명이 깨진 번들(Electron 링커 서명 그대로)은 권한이 'Electron' 이름에 묶이고, 격리 표시가 붙으면 '손상됨' 으로 막힌다
  try {
    verify(appPath)
  } catch (e) {
    problems.push(`서명 확인 실패 (codesign --verify): ${String(e.stderr ?? e).trim().split('\n')[0]}`)
  }
  return problems
}

const codesignInfo = (p) => {
  const r = spawnSync('/usr/bin/codesign', ['-dvv', p], { encoding: 'utf8' })
  return `${r.stdout ?? ''}${r.stderr ?? ''}`
}
const spctlAssess = (app) => execFileSync('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose', app], { stdio: 'pipe' })
const staplerValidate = (app) => execFileSync('/usr/bin/xcrun', ['stapler', 'validate', app], { stdio: 'pipe' })
const firstLine = (e) => String(e.stderr ?? e).trim().split('\n').filter(Boolean).slice(-1)[0] ?? String(e)

/**
 * 배포본 검사 (18단계, npm run release 끝) — Developer ID 서명 · 팀 ID 가 node-pty 까지 같은지 · hardened runtime ·
 * Gatekeeper(spctl) · 공증 staple · dmg/zip/latest-mac.yml. @returns {string[]} 문제 목록
 */
export function checkRelease(appPath, distDir, { codesign = codesignInfo, spctl = spctlAssess, stapler = staplerValidate } = {}) {
  const problems = []
  const info = codesign(appPath)
  const team = /TeamIdentifier=(\S+)/.exec(info)?.[1]
  if (!/Authority=Developer ID Application: /.test(info)) problems.push('앱이 Developer ID Application 으로 서명되지 않음 — 다른 Mac 에서 "확인되지 않은 개발자" 로 막힌다')
  if (!team || team === 'not') problems.push('앱 서명에 팀 ID 가 없음 (ad-hoc · 서명 없음)')
  if (!/flags=\S*\(\S*runtime\S*\)/.test(info)) problems.push('앱에 hardened runtime 이 꺼져 있음 — 공증이 거절한다')
  // 자동 업데이트의 받는 곳 — electron-builder 는 macOS 에서 dmg · zip 대상일 때만 넣는다(PublishManager). dir 패키징본엔 없는 게 맞다
  const updateYml = join(appPath, 'Contents', 'Resources', 'app-update.yml')
  const yml = existsSync(updateYml) ? readFileSync(updateYml, 'utf8') : null
  if (yml === null) problems.push('Resources/app-update.yml 없음 — 자동 업데이트가 받는 곳을 모른다 (electron-builder publish)')
  else if (!/provider: github/.test(yml) || !/owner: petercorders/.test(yml) || !/repo: taskminal/.test(yml)) problems.push(`app-update.yml 의 받는 곳이 GitHub petercorders/taskminal 이 아님: ${yml.trim().replace(/\n/g, ' · ')}`)
  const ptyRoot = join(appPath, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', 'node-pty')
  const ptyDir = PTY_DIRS.find((d) => existsSync(join(ptyRoot, d, 'pty.node')))
  if (ptyDir && team) {
    for (const f of ['spawn-helper', 'pty.node']) {
      const t = /TeamIdentifier=(\S+)/.exec(codesign(join(ptyRoot, ptyDir, f)))?.[1]
      if (t !== team) problems.push(`${ptyDir}/${f} 의 팀 ID(${t ?? '없음'}) 가 앱(${team})과 다름 — 공증이 거절하거나 셸이 안 뜬다`)
    }
  }
  try {
    spctl(appPath)
  } catch (e) {
    problems.push(`Gatekeeper 가 거절 (spctl --assess): ${firstLine(e)}`)
  }
  try {
    stapler(appPath)
  } catch (e) {
    problems.push(`공증 표가 붙지 않음 (stapler validate — staple): ${firstLine(e)}`)
  }
  const plistPath = join(appPath, 'Contents', 'Info.plist')
  const version = existsSync(plistPath) ? plistValue(readFileSync(plistPath, 'utf8'), 'CFBundleShortVersionString') : null
  const files = existsSync(distDir) ? readdirSync(distDir) : []
  if (!files.some((f) => f.endsWith('.dmg') && version && f.includes(`-${version}-`))) problems.push(`dist 에 ${version} 의 .dmg(설치용) 없음`)
  if (!files.some((f) => f.endsWith('-mac.zip') && version && f.includes(`-${version}-`))) problems.push(`dist 에 ${version} 의 -mac.zip(자동 업데이트용) 없음`)
  if (!files.includes('latest-mac.yml')) problems.push('dist 에 latest-mac.yml(자동 업데이트 목록) 없음')
  return problems
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const app = process.argv[2]
  if (!app) {
    console.error('사용법: node scripts/check-package.mjs <Taskminal.app 경로> [--release <dist 폴더>]')
    process.exit(2)
  }
  const releaseAt = process.argv.indexOf('--release')
  const problems = [...(await checkPackage(app)), ...(releaseAt > 0 ? checkRelease(app, process.argv[releaseAt + 1] ?? 'dist') : [])]
  for (const p of problems) console.log(`✗ ${p}`)
  if (problems.length) process.exit(1)
  console.log(`✓ 패키지 검사 통과: ${app}`)
}
