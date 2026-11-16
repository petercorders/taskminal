// npm run release 의 판단(18단계) — 인증서 고르기 · electron-builder 인자 · 빠진 준비물 안내. 실행은 scripts/release.mjs.
// 비밀값(앱 암호)은 다루지 않는다 — 공증은 키체인 프로필(APPLE_KEYCHAIN_PROFILE)을 electron-builder 가 읽는다.

export const NOTARY_PROFILE = 'taskminal-notary'

/** `security find-identity -v -p codesigning` 출력에서 'Developer ID Application' 인증서 이름(접두사 뺀 것) */
export function developerIdOf(findIdentityOutput) {
  const m = /"Developer ID Application: ([^"]+)"/.exec(findIdentityOutput)
  return m ? m[1] : null
}

/** electron-builder 인자 — 배포용 dmg(설치) + zip(자동 업데이트) · 지정한 칩 · 게시하지 않음 */
export function builderArgs(identity, arch = 'arm64') {
  if (!['arm64', 'x64', 'all'].includes(arch)) throw new Error(`지원하지 않는 Mac 칩: ${arch}`)
  return ['--mac', 'dmg', 'zip', ...(arch === 'all' ? ['--arm64', '--x64'] : [`--${arch}`]), '--publish', 'never', `-c.mac.identity=${identity}`]
}

/** 시작 전에 사용자가 해야 할 일 — 빈 배열이면 진행 */
export function missingSteps({ identity, profileOk, profile = NOTARY_PROFILE }) {
  const steps = []
  if (!identity) {
    steps.push(
      "키체인에 'Developer ID Application' 인증서가 없어요. Xcode › Settings › Accounts › (팀) › Manage Certificates › + › 'Developer ID Application' 으로 만들거나, " +
        'developer.apple.com › Certificates 에서 만들어 내려받은 .cer 를 두 번 눌러 키체인에 넣으세요. 확인: security find-identity -v -p codesigning',
    )
  }
  if (!profileOk) {
    steps.push(
      `공증 프로필 '${profile}' 이 키체인에 없어요. 터미널에서 직접: xcrun notarytool store-credentials ${profile} --apple-id <Apple ID 이메일> --team-id <팀 ID> ` +
        '— 앱 암호는 그 명령이 물을 때 입력하세요(appleid.apple.com › 로그인 및 보안 › 앱 암호에서 만듦). 채팅 · 파일에 붙이지 마세요.',
    )
  }
  return steps
}
