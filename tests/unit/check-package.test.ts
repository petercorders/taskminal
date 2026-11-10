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
  cpSync(join(__dirname, '../../resources/shell'), join(res, 'shell'), { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const check = () => checkPackage(appPath, { arch: () => 'arm64' }) as Promise<string[]>

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
    const problems = (await checkPackage(appPath, { arch: () => 'x86_64' })) as string[]
    const all = problems.join('\n')
    expect(all).toContain('pty.node')
    expect(all).toContain('icon.icns')
    expect(all).toContain('arm64')
  })

  it('번들 id 가 다르면', async () => {
    writeFileSync(join(appPath, 'Contents/Info.plist'), '<plist><dict><key>CFBundleIdentifier</key><string>com.github.Electron</string><key>CFBundleIconFile</key><string>icon.icns</string></dict></plist>')
    expect((await check()).join('\n')).toContain('CFBundleIdentifier')
  })
})
