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
    // 리뷰(19단계): 되돌릴 수 없는 것들
    'terraform destroy',
    'terraform apply -auto-approve',
    'kubectl delete pod api-0',
    'git reset --hard HEAD~1',
    'git clean -fdx',
    'dd if=/dev/zero of=/dev/disk4',
    'sudo mkfs.ext4 /dev/sdb1',
    'diskutil eraseDisk APFS X disk4',
  ])('위험: %s', (cmd) => expect(isDangerous(cmd)).toBe(true))

  it.each(['git status', 'npm test -- settlement', 'ls -la', 'echo removed', 'dropbox-cli status', 'git pushd', 'docker compose ps', 'trm x', 'terraform plan', 'kubectl get pods', 'git reset HEAD file', 'git clean -n', 'add x'])(
    '안전: %s',
    (cmd) => expect(isDangerous(cmd)).toBe(false),
  )
})
