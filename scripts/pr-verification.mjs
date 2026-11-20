import { spawn, spawnSync } from 'node:child_process'
import {
  accessSync, constants, linkSync, lstatSync, mkdtempSync, realpathSync, rmSync, rmdirSync, statSync, writeFileSync,
} from 'node:fs'
import { constants as osConstants, homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const USAGE = 'npm run verify:pr -- --repo owner/repo --pr 24 --criterion "전체 회귀 검사" --output /tmp/pr-24-verification.json'
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const HARNESS_CODES = new Set([0, 1, 3, 4])

function git(cwd, ...args) {
  const result = spawnSync('git', ['--no-optional-locks', ...args], { cwd, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

function cleanHead(cwd) {
  if (git(cwd, 'rev-parse', '--show-prefix') !== '') return null
  const head = git(cwd, 'rev-parse', '--verify', 'HEAD')
  if (!head || !SHA.test(head)) return null
  const status = git(cwd, 'status', '--porcelain=v1', '--untracked-files=normal', '--ignore-submodules=none')
  return status === '' && head === git(cwd, 'rev-parse', '--verify', 'HEAD') ? head : null
}

function runHarness(harness, log, cwd) {
  const child = spawn('bash', [harness, log], { cwd, stdio: 'inherit' })
  let interrupted
  const interrupt = (signal) => {
    interrupted ??= signal
    child.kill(signal)
  }
  const onInt = () => interrupt('SIGINT')
  const onTerm = () => interrupt('SIGTERM')
  process.on('SIGINT', onInt)
  process.on('SIGTERM', onTerm)
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal: interrupted ?? signal }))
  }).finally(() => {
    process.off('SIGINT', onInt)
    process.off('SIGTERM', onTerm)
  })
}

function outputPath(cwd, name) {
  const path = resolve(cwd, name)
  const output = join(realpathSync(dirname(path)), basename(path))
  try {
    lstatSync(output)
  } catch (error) {
    if (error.code === 'ENOENT') return output
    throw error
  }
  throw new Error(`이미 파일이 있습니다: ${output}`)
}

function publishReport(output, report) {
  const staging = mkdtempSync(join(dirname(output), '.taskminal-pr-'))
  try {
    const file = join(staging, 'report.json')
    writeFileSync(file, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    // 하드링크는 완성된 파일을 공개하며 동시에 같은 이름을 사용해도 기존 파일을 덮지 않는다.
    linkSync(file, output)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

export async function runPrVerification(args, {
  cwd = process.cwd(),
  harness = join(homedir(), '.claude/skills/harness-engineering/stacks/electron/scripts/full-check.sh'),
} = {}) {
  let repository, pullRequest, criterion, output, log
  try {
    const { values } = parseArgs({ args, options: {
      repo: { type: 'string' },
      pr: { type: 'string' },
      criterion: { type: 'string' },
      output: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    } })
    if (values.help) {
      console.log(USAGE)
      return 0
    }
    repository = values.repo
    pullRequest = Number(values.pr)
    criterion = values.criterion?.trim()
    if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
        !/^[1-9]\d*$/.test(values.pr ?? '') || !Number.isSafeInteger(pullRequest) ||
        !criterion || criterion.length > 400 || !values.output) {
      throw new Error('저장소(owner/repo), 양의 PR 번호, 인수 조건(400자 이하), 출력 경로를 지정해 주세요.')
    }
    output = outputPath(cwd, values.output)
    accessSync(harness, constants.R_OK)
    if (!statSync(harness).isFile()) throw new Error(`하네스 파일이 아닙니다: ${harness}`)
    log = join(mkdtempSync(join(tmpdir(), 'taskminal-pr-check-')), 'full-check.log')
  } catch (error) {
    console.error(error.message)
    console.error(USAGE)
    return 2
  }

  const startSha = cleanHead(cwd)
  let result
  try {
    result = await runHarness(harness, log, cwd)
  } catch (error) {
    console.error(`하네스를 실행하지 못했습니다: ${error.message}`)
    return 2
  } finally {
    try { rmdirSync(dirname(log)) } catch { /* 로그가 남아 있으면 디렉터리도 보존한다. */ }
  }
  const { code, signal } = result
  if (signal) {
    console.error(`하네스가 ${signal} 신호로 중단되었습니다. 로그: ${log}`)
    return 128 + (osConstants.signals[signal] ?? 0)
  }
  if (!HARNESS_CODES.has(code)) {
    console.error(`하네스가 예상과 다른 종료 코드(${code})를 반환했습니다. 로그: ${log}`)
    return code ?? 2
  }
  const endSha = cleanHead(cwd)
  try {
    publishReport(output, {
      version: 1,
      repository,
      pullRequest,
      startSha,
      endSha,
      entries: [{ criterion, check: 'Electron full-check', exitCode: code }],
    })
  } catch (error) {
    console.error(`하네스 종료 코드 ${code}. 리포트를 만들지 못했습니다 (${output}): ${error.message}`)
    return code === 0 ? 2 : code
  }
  if (!startSha || !endSha || startSha !== endSha) console.error('검사 대상 커밋 미확인: 검사 전후 Git 상태를 확인해 주세요.')
  console.log(`리포트: ${output} (하네스 종료 코드 ${code})`)
  return code
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await runPrVerification(process.argv.slice(2))
}
