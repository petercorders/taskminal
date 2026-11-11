// npm run release — Developer ID 서명 · 공증 · dmg + zip + latest-mac.yml (18단계).
// 1) 준비물 확인(인증서 · 공증 프로필) — 없으면 할 일을 알리고 멈춘다 2) 빌드 3) check-package --release.
// GitHub 릴리스 게시는 하지 않는다(--publish never) — 게시 · push 는 사용자 확인 뒤 손으로.
import { execFileSync, spawnSync } from 'node:child_process'
import { builderArgs, developerIdOf, missingSteps, NOTARY_PROFILE } from './release-config.mjs'

const profile = process.env['APPLE_KEYCHAIN_PROFILE'] || NOTARY_PROFILE
const identity = developerIdOf(execFileSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' }))
const profileOk = spawnSync('/usr/bin/xcrun', ['notarytool', 'history', '--keychain-profile', profile], { stdio: 'ignore' }).status === 0
const steps = missingSteps({ identity, profileOk, profile })
if (steps.length) {
  console.error('배포 빌드를 시작하지 않았어요 — 먼저 할 일:')
  for (const s of steps) console.error(`  · ${s}`)
  process.exit(1)
}

const run = (cmd, args, env = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } })
  if (r.status !== 0) process.exit(r.status ?? 1)
}
run('npx', ['electron-vite', 'build'])
// 공증: APPLE_KEYCHAIN_PROFILE 을 electron-builder(app-builder-lib MacTargetHelper)가 읽어 notarytool → staple
run('npx', ['electron-builder', ...builderArgs(identity)], { APPLE_KEYCHAIN_PROFILE: profile })
run('node', ['scripts/check-package.mjs', 'dist/mac-arm64/Taskminal.app', '--release', 'dist'])
