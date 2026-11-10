import { createPackage } from '@electron/asar'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// @ts-expect-error — 빌드 도구 스크립트(.mjs)라 타입이 없다
import { checkPackage } from '../../scripts/check-package.mjs'

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
  // asar: out/ 세 진입점
  const src = join(root, 'asar-src')
  for (const f of ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html', 'package.json']) {
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
