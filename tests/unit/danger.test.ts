import { describe, expect, it } from 'vitest'
import { isDangerous } from '../../src/shared/danger'

describe('위험 명령 표 (19 기록 · 20 빠른 명령 공유)', () => {
  it.each([
    './deploy/nas/make-env.sh --ocr-deadline PT12S',
    'rm -rf build',
    'sudo rm file',
    'git push origin main',
    'git push',
    'psql -c "DROP TABLE x"',
    'docker compose up -d api',
    'ssh nas "docker compose up -d api"',
    'docker-compose up',
  ])('위험: %s', (cmd) => expect(isDangerous(cmd)).toBe(true))

  it.each(['git status', 'npm test -- settlement', 'ls -la', 'echo removed', 'dropbox-cli status', 'git pushd', 'docker compose ps', 'trm x'])(
    '안전: %s',
    (cmd) => expect(isDangerous(cmd)).toBe(false),
  )
})
