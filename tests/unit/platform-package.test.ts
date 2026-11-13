import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error — 실행 가능한 패키징 스크립트
import { packagePlan } from '../../scripts/platform-package.mjs'
// @ts-expect-error — afterPack 은 electron-builder 의 CommonJS 훅
import { preparePty } from '../../scripts/after-pack.cjs'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('OS별 배포 패키징', () => {
  it('Windows·Linux 파일은 구분된 출력에 만들고 앱 실행 경로도 맞춘다', () => {
    const win = packagePlan({ platform: 'win32', arch: 'x64', version: '0.1.2' })
    expect(win.args).toEqual(['--win', 'nsis', '--x64', '--publish', 'never', '-c.directories.output=dist/releases/0.1.2-win-x64'])
    expect(win.executable).toBe(join('dist/releases/0.1.2-win-x64', 'win-unpacked', 'Taskminal.exe'))
    const linux = packagePlan({ platform: 'linux', arch: 'x64', version: '0.1.2' })
    expect(linux.args).toContain('AppImage')
    expect(linux.args).toContain('deb')
    expect(linux.executable).toBe(join('dist/releases/0.1.2-linux-x64', 'linux-unpacked', 'taskminal'))
  })
  it('Mac 의 칩에 맞는 검사와 실행 경로를 고르고 서명값은 명시할 때만 쓴다', () => {
    const intel = packagePlan({ platform: 'darwin', arch: 'x64', version: '0.1.2', identity: 'A (TEAM)' })
    expect(intel.args).toContain('--x64')
    expect(intel.args).toContain('-c.mac.identity=A (TEAM)')
    expect(intel.app).toBe(join('dist/releases/0.1.2-mac-x64', 'mac', 'Taskminal.app'))
    const arm = packagePlan({ platform: 'darwin', arch: 'arm64', version: '0.1.2' })
    expect(arm.app).toContain('mac-arm64')
    expect(arm.args.some((x: string) => /identity=/.test(x))).toBe(false)
  })
  it('지원하지 않는 조합은 만들지 않는다', () => {
    for (const platform of ['win32', 'linux']) expect(() => packagePlan({ platform, arch: 'arm64', version: '0.1.2' })).toThrow(/지원/)
    expect(() => packagePlan({ platform: 'darwin', arch: 'ia32', version: '0.1.2' })).toThrow(/지원/)
  })
  it('다른 OS·칩의 node-pty 와 앞서 만든 소스 빌드를 패키지에서 제거한다', () => {
    const root = mkdtempSync(join(tmpdir(), 'taskminal-platform-pty-'))
    roots.push(root)
    for (const dir of ['prebuilds/darwin-arm64', 'prebuilds/darwin-x64', 'prebuilds/win32-x64', 'build/Release']) {
      mkdirSync(join(root, dir), { recursive: true })
      writeFileSync(join(root, dir, 'pty.node'), '')
      writeFileSync(join(root, dir, 'spawn-helper'), '')
    }
    preparePty(root, 'darwin', 'x64')
    expect(existsSync(join(root, 'prebuilds/darwin-x64/pty.node'))).toBe(true)
    expect(existsSync(join(root, 'prebuilds/darwin-arm64'))).toBe(false)
    expect(existsSync(join(root, 'prebuilds/win32-x64'))).toBe(false)
    expect(existsSync(join(root, 'build'))).toBe(false)
  })
  it('Linux 소스 빌드를 보존하고 없는 대상 네이티브 모듈은 거절한다', () => {
    const root = mkdtempSync(join(tmpdir(), 'taskminal-platform-linux-'))
    roots.push(root)
    mkdirSync(join(root, 'build/Release'), { recursive: true })
    writeFileSync(join(root, 'build/Release/pty.node'), '')
    preparePty(root, 'linux', 'x64')
    expect(existsSync(join(root, 'build/Release/pty.node'))).toBe(true)
    rmSync(join(root, 'build'), { recursive: true })
    expect(() => preparePty(root, 'linux', 'x64')).toThrow(/node-pty/)
  })
})
