import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error — 배포 산출물 스크립트
import { artifactManifest } from '../../scripts/artifact-manifest.mjs'

const roots: string[] = []
const options = { version: '0.1.2', platform: 'win32', arch: 'x64', source: '0123456789abcdef0123456789abcdef01234567' }
function dir() { const path = mkdtempSync(join(tmpdir(), 'taskminal-manifest-')); roots.push(path); return path }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('배포 산출물 해시와 소스 기록', () => {
  it('배포 파일만 해시하고 버전·OS·칩·전체 소스 SHA와 함께 기록한다', async () => {
    const root = dir()
    const name = 'Taskminal-0.1.2-win-x64.exe'
    writeFileSync(join(root, name), 'verified installer')
    writeFileSync(join(root, 'latest.yml'), 'version: 0.1.2\n')
    writeFileSync(join(root, 'package-plan.json'), 'private local paths')
    const result = await artifactManifest(root, options)
    expect(result).toMatchObject(options)
    expect(result.files).toHaveLength(2)
    expect(result.files[0]).toEqual({ name, size: 18, sha256: createHash('sha256').update('verified installer').digest('hex') })
    expect(JSON.parse(readFileSync(join(root, 'manifest-win32-x64.json'), 'utf8'))).toEqual(result)
    expect(readFileSync(join(root, 'SHA256SUMS-win32-x64'), 'utf8')).toContain(`  ${name}\n`)
    expect(JSON.stringify(result)).not.toContain('private local paths')
  })
  it('다른 버전 파일·축약 소스 SHA·빈 디렉터리는 거절한다', async () => {
    const root = dir()
    await expect(artifactManifest(root, options)).rejects.toThrow(/산출물이 없음/)
    writeFileSync(join(root, 'Taskminal-0.1.1-win-x64.exe'), 'old')
    await expect(artifactManifest(root, options)).rejects.toThrow(/다른 버전/)
    await expect(artifactManifest(root, { ...options, source: '0123456' })).rejects.toThrow(/전체 소스/)
  })
})
