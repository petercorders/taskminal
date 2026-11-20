import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error — Node CLI 스크립트에는 타입 선언이 없다.
import { runPrVerification } from '../../scripts/pr-verification.mjs'
import { parsePrVerification } from '../../src/shared/pr-verification'

const target = { repository: 'owner/repo', number: 24 }
const criterion = '전체 회귀 검사'
let temp: string
let repo: string
let output: string
let harness: string

function git(...args: string[]) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
}

function check(shell: string, outputPath = output) {
  writeFileSync(harness, shell)
  return runPrVerification([
    '--repo', target.repository, '--pr', String(target.number),
    '--criterion', criterion, '--output', outputPath,
  ], { cwd: repo, harness })
}

function readReport() {
  return readFileSync(output, 'utf8')
}

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'taskminal-pr-test-'))
  repo = join(temp, 'repo')
  output = join(temp, 'report.json')
  harness = join(temp, 'full-check.sh')
  mkdirSync(repo)
  git('init', '--quiet')
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '--allow-empty', '--quiet', '-m', 'initial')
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(temp, { recursive: true, force: true })
})

describe('PR verification report', () => {
  it.each([0, 1, 3, 4])('preserves harness exit %i in the CLI and PR panel', async (code) => {
    expect(await check(`exit ${code}`)).toBe(code)
    expect(parsePrVerification(readReport(), target)).toEqual({
      head: git('rev-parse', 'HEAD'),
      entries: [{ criterion, check: 'Electron full-check', exitCode: code }],
    })
  })

  it('passes the E2E skip flag through to the harness', async () => {
    vi.stubEnv('FULL_CHECK_NO_E2E', '1')
    expect(await check('test "$FULL_CHECK_NO_E2E" = 1 && exit 4; exit 1')).toBe(4)
  })

  it('keeps both SHAs when the committed revision changes', async () => {
    const startSha = git('rev-parse', 'HEAD')
    expect(await check("git -c user.name=Test -c user.email=test@example.invalid -c commit.gpgsign=false commit --allow-empty --quiet -m changed")).toBe(0)
    expect(JSON.parse(readReport())).toMatchObject({ startSha, endSha: git('rev-parse', 'HEAD') })
    expect(parsePrVerification(readReport(), target)?.head).toBeNull()
  })

  it('omits the starting SHA if an untracked change was present', async () => {
    writeFileSync(join(repo, 'draft'), 'untracked')
    expect(await check('rm draft')).toBe(0)
    expect(JSON.parse(readReport())).toMatchObject({ startSha: null, endSha: git('rev-parse', 'HEAD') })
  })

  it('omits the ending SHA after an untracked change', async () => {
    expect(await check('touch draft')).toBe(0)
    expect(JSON.parse(readReport())).toMatchObject({ startSha: git('rev-parse', 'HEAD'), endSha: null })
  })

  it('omits the ending SHA if Git cannot read the worktree', async () => {
    expect(await check('mv .git .git-unavailable')).toBe(0)
    expect(JSON.parse(readReport()).endSha).toBeNull()
  })

  it('rejects a malformed target before the harness runs', async () => {
    writeFileSync(harness, 'touch ran')
    expect(await runPrVerification([
      '--repo', 'owner/repo', '--pr', '0', '--criterion', criterion, '--output', output,
    ], { cwd: repo, harness })).toBe(2)
    expect(existsSync(join(repo, 'ran'))).toBe(false)
    expect(existsSync(output)).toBe(false)
  })

  it('leaves a pre-existing report intact and skips the harness', async () => {
    writeFileSync(output, 'original')
    expect(await check('touch ran')).toBe(2)
    expect(readReport()).toBe('original')
    expect(existsSync(join(repo, 'ran'))).toBe(false)
  })

  it.each([[0, 2], [4, 4]])('reports a write conflict after exit %i and returns %i', async (code, expected) => {
    expect(await check(`printf winner > ../report.json; exit ${code}`)).toBe(expected)
    expect(readReport()).toBe('winner')
  })

  it('does not issue a completed report for a signalled harness', async () => {
    expect(await check('kill -TERM $$')).toBe(143)
    expect(existsSync(output)).toBe(false)
  })
})
