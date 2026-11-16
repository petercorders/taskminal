import { createPackage } from '@electron/asar'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// @ts-expect-error — 빌드 도구 스크립트(.mjs)라 타입이 없다
import { checkPackage, checkRelease } from '../../scripts/check-package.mjs'

// 14단계: 만든 .app 을 실행하지 않고 안을 읽어 확인하는 검사기 — 가짜 .app 으로 판정을 본다.
let root: string
let appPath: string
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'taskminal-pkg-'))
  appPath = join(root, 'Taskminal.app')
  const c = join(appPath, 'Contents')
  const res = join(c, 'Resources')
  mkdirSync(join(c, 'MacOS'), { recursive: true })
  writeFileSync(join(c, 'MacOS', 'Taskminal'), '')
  writeFileSync(
    join(c, 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>io.peterbong.taskminal</string>
<key>CFBundleName</key><string>Taskminal</string>
<key>CFBundleIconFile</key><string>icon.icns</string>
</dict></plist>`,
  )
  mkdirSync(res, { recursive: true })
  writeFileSync(join(res, 'icon.icns'), 'x')
  // 18단계: 자동 업데이트가 읽는 받는 곳 (electron-builder publish)
  writeFileSync(join(res, 'app-update.yml'), 'owner: petercorders\nrepo: taskminal\nprovider: github\nupdaterCacheDirName: taskminal-updater\n')
  // asar: out/ 세 진입점
  const src = join(root, 'asar-src')
  for (const f of ['out/main/index.js', 'out/main/host.js', 'out/main/cli.js', 'out/main/server.js', 'out/preload/index.js', 'out/renderer/index.html', 'package.json', 'node_modules/@xterm/headless/package.json']) {
    mkdirSync(join(src, f, '..'), { recursive: true })
    writeFileSync(join(src, f), '')
  }
  await createPackage(src, join(res, 'app.asar'))
  const pty = join(res, 'app.asar.unpacked', 'node_modules', 'node-pty', 'prebuilds', 'darwin-arm64')
  mkdirSync(pty, { recursive: true })
  writeFileSync(join(pty, 'pty.node'), '')
  writeFileSync(join(pty, 'spawn-helper'), '')
  chmodSync(join(pty, 'spawn-helper'), 0o755)
  // 개발 폴더에 남은 기록 파일이 섞이지 않게, 넣을 파일만 복사한다
  mkdirSync(join(res, 'shell', 'zsh'), { recursive: true })
  for (const f of ['.zshenv', '.zprofile', '.zshrc', '.zlogin', 'taskminal-hooks.zsh']) cpSync(join(__dirname, '../../resources/shell/zsh', f), join(res, 'shell', 'zsh', f))
  // 24단계 taskminal 명령
  mkdirSync(join(res, 'bin'), { recursive: true })
  cpSync(join(__dirname, '../../resources/bin/taskminal'), join(res, 'bin', 'taskminal'))
  chmodSync(join(res, 'bin', 'taskminal'), 0o755)
  cpSync(join(__dirname, '../../resources/bin/taskminal-server'), join(res, 'bin', 'taskminal-server'))
  chmodSync(join(res, 'bin', 'taskminal-server'), 0o755)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const signed = () => undefined
const check = () => checkPackage(appPath, { arch: () => 'arm64', verify: signed }) as Promise<string[]>
const plist = (body: string) => writeFileSync(join(appPath, 'Contents/Info.plist'), `<plist><dict>${body}</dict></plist>`)
const ID = '<key>CFBundleIdentifier</key><string>io.peterbong.taskminal</string>'
const NAME = '<key>CFBundleName</key><string>Taskminal</string>'
const ICON = '<key>CFBundleIconFile</key><string>icon.icns</string>'
const ptyRoot = () => join(appPath, 'Contents/Resources/app.asar.unpacked/node_modules/node-pty')

describe('check-package (14단계)', () => {
  it('모두 갖춘 .app 은 문제 없음', async () => {
    expect(await check()).toEqual([])
  })
  it('Intel Mac은 x64 실행 파일과 같은 칩의 node-pty를 검사한다', async () => {
    renameSync(join(ptyRoot(), 'prebuilds/darwin-arm64'), join(ptyRoot(), 'prebuilds/darwin-x64'))
    expect(await checkPackage(appPath, { arch: () => 'x86_64', verify: signed, expectedArch: 'x64' })).toEqual([])
    expect((await checkPackage(appPath, { arch: (p: string) => p.endsWith('pty.node') ? 'arm64' : 'x86_64', verify: signed, expectedArch: 'x64' })).join('\n')).toContain('pty.node 가 x64 가 아님')
  })
  it('다른 OS의 node-pty를 함께 넣으면 거절한다', async () => {
    mkdirSync(join(ptyRoot(), 'prebuilds/win32-x64'), { recursive: true })
    expect((await check()).join('\n')).toContain('다른 OS/칩의 node-pty 포함: win32-x64')
  })

  it('taskminal 명령이 없거나 실행 권한이 없으면 (24단계)', async () => {
    const cli = join(appPath, 'Contents/Resources/bin/taskminal')
    chmodSync(cli, 0o644)
    expect(await check()).toEqual(['Resources/bin/taskminal 에 실행 권한이 없음'])
    rmSync(cli)
    expect(await check()).toEqual(['명령줄 도구 없음: Resources/bin/taskminal (extraResources)'])
  })

  it('spawn-helper 에 실행 권한이 없으면 — 셸이 posix_spawnp failed 로 안 뜬다', async () => {
    chmodSync(join(appPath, 'Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper'), 0o644)
    expect((await check()).join('\n')).toContain('spawn-helper')
  })

  it('셸 통합의 점 파일이 빠지면 — 셸 통합 없이 뜬다', async () => {
    rmSync(join(appPath, 'Contents/Resources/shell/zsh/.zshrc'))
    expect((await check()).join('\n')).toContain('.zshrc')
  })

  it('asar 안에 진입점이 없으면', async () => {
    const src = join(root, 'asar-src2')
    mkdirSync(join(src, 'out/main'), { recursive: true })
    writeFileSync(join(src, 'out/main/index.js'), '')
    await createPackage(src, join(appPath, 'Contents/Resources/app.asar'))
    const problems = (await check()).join('\n')
    expect(problems).toContain('out/preload/index.js')
    expect(problems).toContain('out/renderer/index.html')
    // 16단계: 셸 지킴이 입구 · 그것이 쓰는 headless — 빠지면 셸이 하나도 안 뜬다
    expect(problems).toContain('out/main/host.js')
    expect(problems).toContain('node_modules/@xterm/headless/package.json')
  })

  it('node-pty 가 asar 밖에 없으면 · 아이콘 · 번들 id · arm64 가 아니면', async () => {
    rmSync(join(appPath, 'Contents/Resources/app.asar.unpacked'), { recursive: true })
    rmSync(join(appPath, 'Contents/Resources/icon.icns'))
    const problems = (await checkPackage(appPath, { arch: () => 'x86_64', verify: signed })) as string[]
    const all = problems.join('\n')
    expect(all).toContain('pty.node')
    expect(all).toContain('icon.icns')
    expect(all).toContain('arm64')
  })

  it('번들 id 가 다르면', async () => {
    plist(`<key>CFBundleIdentifier</key><string>com.github.Electron</string>${NAME}${ICON}`)
    expect((await check()).join('\n')).toContain('CFBundleIdentifier')
  })

  // 14단계 리뷰
  it('앱 이름이 Taskminal 이 아니면 (productName 이 빠져 Electron)', async () => {
    plist(`${ID}<key>CFBundleName</key><string>Electron</string>${ICON}`)
    expect((await check()).join('\n')).toContain('CFBundleName')
  })

  it('CFBundleIconFile 이 없으면 icon.icns 가 있어도 문제 — Finder 가 기본 아이콘', async () => {
    plist(`${ID}${NAME}`)
    expect((await check()).join('\n')).toContain('CFBundleIconFile')
  })

  it('셸 폴더에 목록 밖 파일(.zsh_history)이 있으면 — 개발자 명령 기록이 실린다', async () => {
    writeFileSync(join(appPath, 'Contents/Resources/shell/zsh/.zsh_history'), 'export TOKEN=x')
    expect((await check()).join('\n')).toContain('.zsh_history')
  })

  it('build/Release 가 있으면 node-pty 는 그쪽을 쓰므로 그 spawn-helper 를 본다', async () => {
    const rel = join(ptyRoot(), 'build/Release')
    mkdirSync(rel, { recursive: true })
    writeFileSync(join(rel, 'pty.node'), '')
    writeFileSync(join(rel, 'spawn-helper'), '')
    chmodSync(join(rel, 'spawn-helper'), 0o644)
    expect((await check()).join('\n')).toContain('build/Release/spawn-helper')
    chmodSync(join(rel, 'spawn-helper'), 0o755)
    expect(await check()).toEqual([])
  })

  it('미리 빌드가 없어도 build/Release 만 있으면 통과 (작동하는 앱을 막지 않는다)', async () => {
    rmSync(join(ptyRoot(), 'prebuilds'), { recursive: true })
    const rel = join(ptyRoot(), 'build/Release')
    mkdirSync(rel, { recursive: true })
    writeFileSync(join(rel, 'pty.node'), '')
    writeFileSync(join(rel, 'spawn-helper'), '')
    chmodSync(join(rel, 'spawn-helper'), 0o755)
    expect(await check()).toEqual([])
  })

  it('서명 확인이 실패하면', async () => {
    const broken = () => {
      throw Object.assign(new Error('x'), { stderr: 'code has no resources but signature indicates they must be present' })
    }
    const problems = (await checkPackage(appPath, { arch: () => 'arm64', verify: broken })) as string[]
    expect(problems.join('\n')).toContain('code has no resources')
  })
})

describe('check-package (18단계)', () => {
  it('dir 패키징본(npm run package)은 app-update.yml 이 없어도 통과 — electron-builder 는 dmg · zip 일 때만 넣는다', async () => {
    rmSync(join(appPath, 'Contents/Resources/app-update.yml'))
    expect((await check()).join('\n')).not.toContain('app-update.yml')
  })

  describe('--release', () => {
    const DEV_ID = 'Executable=/x\nIdentifier=io.peterbong.taskminal\nCodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1\nAuthority=Developer ID Application: KiBong Kim (ABCDE12345)\nAuthority=Developer ID Certification Authority\nAuthority=Apple Root CA\nTeamIdentifier=ABCDE12345\n'
    let dist: string
    beforeEach(() => {
      dist = join(root, 'dist')
      mkdirSync(dist)
      writeFileSync(join(appPath, 'Contents/Info.plist'), `<plist><dict>${ID}${NAME}${ICON}<key>CFBundleShortVersionString</key><string>0.1.1</string></dict></plist>`)
      for (const f of ['Taskminal-0.1.1-arm64.dmg', 'Taskminal-0.1.1-arm64-mac.zip', 'latest-mac.yml']) writeFileSync(join(dist, f), 'x')
    })
    const ok = () => undefined
    const deps = (codesign: (p: string) => string, more: Record<string, unknown> = {}) => ({ codesign, spctl: ok, stapler: ok, ...more })
    const release = (d: Record<string, unknown>) => checkRelease(appPath, dist, d) as string[]

    it('Developer ID · 같은 팀 · hardened runtime · spctl · staple · 산출물이 다 있으면 통과', () => {
      expect(release(deps(() => DEV_ID))).toEqual([])
    })
    it('ad-hoc · Apple Development 서명이면 — 다른 Mac 에서 막힌다', () => {
      const adhoc = 'CodeDirectory v=20500 flags=0x10002(adhoc,runtime)\nSignature=adhoc\nTeamIdentifier=not set\n'
      const all = release(deps(() => adhoc)).join('\n')
      expect(all).toContain('Developer ID Application')
      expect(all).toContain('팀 ID')
    })
    it('spawn-helper · pty.node 가 다른 팀(또는 서명 없음)이면 — 공증이 거절한다', () => {
      const all = release(deps((p) => (p.endsWith('spawn-helper') ? DEV_ID.replace(/ABCDE12345/g, 'ZZZZZ99999') : DEV_ID))).join('\n')
      expect(all).toContain('spawn-helper')
      expect(all).not.toContain('pty.node')
    })
    it('hardened runtime 이 꺼져 있으면 — 공증이 거절한다', () => {
      expect(release(deps(() => DEV_ID.replace('flags=0x10000(runtime)', 'flags=0x0(none)'))).join('\n')).toContain('hardened runtime')
    })
    it('spctl · staple 이 실패하면', () => {
      const fail = () => {
        throw Object.assign(new Error('x'), { stderr: 'rejected\nsource=Unnotarized Developer ID' })
      }
      const all = release(deps(() => DEV_ID, { spctl: fail, stapler: fail })).join('\n')
      expect(all).toContain('spctl')
      expect(all).toContain('Unnotarized')
      expect(all).toContain('staple')
    })
    it('app-update.yml 이 없거나 받는 곳이 다르면 — 자동 업데이트가 엉뚱한 곳을 본다', () => {
      writeFileSync(join(appPath, 'Contents/Resources/app-update.yml'), 'provider: generic\nurl: http://nas.local/\n')
      expect(release(deps(() => DEV_ID)).join('\n')).toContain('app-update.yml')
      rmSync(join(appPath, 'Contents/Resources/app-update.yml'))
      expect(release(deps(() => DEV_ID)).join('\n')).toContain('app-update.yml')
    })
    it('dmg · zip · latest-mac.yml 이 그 버전으로 없으면', () => {
      rmSync(join(dist, 'Taskminal-0.1.1-arm64.dmg'))
      rmSync(join(dist, 'latest-mac.yml'))
      writeFileSync(join(dist, 'Taskminal-0.1.0-arm64-mac.zip'), 'x')
      rmSync(join(dist, 'Taskminal-0.1.1-arm64-mac.zip'))
      const all = release(deps(() => DEV_ID)).join('\n')
      expect(all).toContain('.dmg')
      expect(all).toContain('-mac.zip')
      expect(all).toContain('latest-mac.yml')
    })
  })
})

it('원격 서버 launcher 누락을 막는다', async () => {
  rmSync(join(appPath, 'Contents/Resources/bin/taskminal-server'))
  expect(await check()).toContain('원격 서버 도구 없음: Resources/bin/taskminal-server')
})
