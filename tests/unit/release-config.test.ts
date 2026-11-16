import { describe, expect, it } from 'vitest'
// @ts-expect-error — 스크립트(.mjs)라 타입 선언이 없다
import { builderArgs, developerIdOf, missingSteps, NOTARY_PROFILE } from '../../scripts/release-config.mjs'

const OUT_DEV_ONLY = `  1) 0123 "Apple Development: kkp02052@gmail.com (8R7SSQ5MPF)"
     1 valid identities found`
const OUT_WITH_ID = `  1) 0123 "Apple Development: KiBong Kim (U5J264U7GV)"
  2) 4567 "Developer ID Application: KiBong Kim (ABCDE12345)"
     2 valid identities found`

describe('release-config', () => {
  it('Developer ID Application 만 고른다 (Apple Development 는 배포에 못 쓴다)', () => {
    expect(developerIdOf(OUT_DEV_ONLY)).toBeNull()
    expect(developerIdOf(OUT_WITH_ID)).toBe('KiBong Kim (ABCDE12345)')
  })
  it('electron-builder 인자: dmg + zip · arm64 · 게시 안 함 · 그 인증서', () => {
    expect(builderArgs('KiBong Kim (ABCDE12345)')).toEqual(['--mac', 'dmg', 'zip', '--arm64', '--publish', 'never', '-c.mac.identity=KiBong Kim (ABCDE12345)'])
  })
  it('Intel Mac과 두 칩 빌드 인자를 지원하고 알 수 없는 칩은 거절한다', () => {
    expect(builderArgs('team', 'x64')).toContain('--x64')
    expect(builderArgs('team', 'x64')).not.toContain('--arm64')
    expect(builderArgs('team', 'all')).toEqual(['--mac', 'dmg', 'zip', '--arm64', '--x64', '--publish', 'never', '-c.mac.identity=team'])
    expect(() => builderArgs('team', 'ia32')).toThrow(/지원/)
  })
  it('빠진 준비물마다 무엇을 할지 — 앱 암호는 묻지 않고 사용자가 터미널에서', () => {
    expect(missingSteps({ identity: 'x', profileOk: true })).toEqual([])
    const steps = missingSteps({ identity: null, profileOk: false }) as string[]
    expect(steps).toHaveLength(2)
    expect(steps[0]).toContain('security find-identity -v -p codesigning')
    expect(steps[1]).toContain(`xcrun notarytool store-credentials ${NOTARY_PROFILE}`)
    expect(steps[1]).toContain('채팅 · 파일에 붙이지 마세요')
  })
})
