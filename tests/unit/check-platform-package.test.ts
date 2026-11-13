import { createPackage } from '@electron/asar'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error — 빌드 검사 스크립트
import { checkPlatformPackage, nativeArchitecture } from '../../scripts/check-platform-package.mjs'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function binary(platform: string) {
  const b = Buffer.alloc(128)
  if (platform === 'win32') {
    b.write('MZ')
    b.writeUInt32LE(64, 60)
    b.write('PE\0\0', 64)
    b.writeUInt16LE(0x8664, 68)
  } else {
    b.write('7f454c46', 0, 'hex')
    b[4] = 2
    b[5] = 1
    b.writeUInt16LE(62, 18)
  }
  return b
}

async function fixture(platform: 'linux' | 'win32') {
  const root = mkdtempSync(join(tmpdir(), 'taskminal-native-fixture-'))
  roots.push(root)
  const res = join(root, 'app/resources')
  const src = join(root, 'asar-src')
  for (const f of ['out/main/index.js', 'out/main/host.js', 'out/main/cli.js', 'out/preload/index.js', 'out/renderer/index.html', 'node_modules/@xterm/headless/package.json']) {
    mkdirSync(join(src, f, '..'), { recursive: true })
    writeFileSync(join(src, f), '')
  }
  mkdirSync(res, { recursive: true })
  await createPackage(src, join(res, 'app.asar'))
  const app = join(root, 'app')
  const pty = join(res, 'app.asar.unpacked/node_modules/node-pty')
  const nativeDir = join(pty, `prebuilds/${platform}-x64`)
  mkdirSync(nativeDir, { recursive: true })
  const writeNative = (file: string) => { writeFileSync(file, binary(platform)); chmodSync(file, 0o755) }
  writeNative(join(app, platform === 'win32' ? 'Taskminal.exe' : 'taskminal'))
  for (const f of platform === 'win32' ? ['pty.node', 'conpty.node', 'conpty_console_list.node'] : ['pty.node']) writeNative(join(nativeDir, f))
  return { app, pty, nativeDir }
}

describe('Windows / Linux 배포 패키지 검사', () => {
  it.each(['linux', 'win32'] as const)('대상 %s 네이티브 파일과 진입점이 있으면 통과', async (platform) => {
    const { app } = await fixture(platform)
    expect(checkPlatformPackage(app, { platform, arch: 'x64' })).toEqual([])
  })
  it('다른 OS 네이티브 바이너리를 확장자만 바꿔 넣어도 거절한다', async () => {
    const { app, nativeDir } = await fixture('linux')
    writeFileSync(join(nativeDir, 'pty.node'), binary('win32'))
    expect(checkPlatformPackage(app, { platform: 'linux', arch: 'x64' }).join('\n')).toContain('OS/칩 불일치')
  })
  it('다른 칩·깨진 PE 오프셋은 x64로 간주하지 않는다', async () => {
    const { nativeDir } = await fixture('win32')
    const file = join(nativeDir, 'conpty.node')
    const wrongChip = binary('win32')
    wrongChip.writeUInt16LE(0xaa64, 68)
    writeFileSync(file, wrongChip)
    expect(nativeArchitecture(file, 'win32')).toBeNull()
    const malformed = binary('win32')
    malformed.writeUInt32LE(0xffffffff, 60)
    writeFileSync(file, malformed)
    expect(nativeArchitecture(file, 'win32')).toBeNull()
  })
  it('ConPTY 파일이 없으면 막고 Linux는 macOS 전용 spawn-helper를 요구하지 않는다', async () => {
    const win = await fixture('win32')
    rmSync(join(win.nativeDir, 'conpty_console_list.node'))
    expect(checkPlatformPackage(win.app, { platform: 'win32', arch: 'x64' }).join('\n')).toContain('conpty_console_list.node')
    const linux = await fixture('linux')
    expect(checkPlatformPackage(linux.app, { platform: 'linux', arch: 'x64' })).toEqual([])
  })
  it('패키지에 다른 OS 바이너리를 함께 넣어도 거절한다', async () => {
    const { app, pty } = await fixture('linux')
    mkdirSync(join(pty, 'prebuilds/darwin-arm64'))
    expect(checkPlatformPackage(app, { platform: 'linux', arch: 'x64' }).join('\n')).toContain('다른 OS/칩')
  })
})
