import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { devNull, tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { isWorktreeOid } from '../shared/worktree-management'
import { validComparisonRequest, type WorktreeCandidate, type WorktreeChange, type WorktreeComparison } from '../shared/worktree-comparison'
import { makeWorktreeGit } from './worktree-management'

const sourceGit = makeWorktreeGit()
const limit = 250

export async function compareWorktrees(root: string, request: unknown): Promise<WorktreeComparison> {
  if (!validComparisonRequest(request)) throw new Error('비교할 커밋의 전체 SHA를 확인해 주세요.')
  const { left, right } = request
  const [objects, format] = await Promise.all([
    sourceGit(root, ['rev-parse', '--path-format=absolute', '--git-path', 'objects']),
    sourceGit(root, ['rev-parse', '--show-object-format']),
  ])
  const objectsDir = objects.stdout.replace(/\r?\n$/, '')
  const objectFormat = format.stdout.trim()
  if (objects.code !== 0 || !isAbsolute(objectsDir) || /[\r\n]/.test(objectsDir) || format.code !== 0 || !['sha1', 'sha256'].includes(objectFormat)) {
    throw new Error('Git 저장소를 확인하지 못했어요.')
  }

  const temporary = await mkdtemp(join(tmpdir(), 'taskminal-merge-'))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  Object.assign(env, {
    LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  })
  const run = (args: string[]) => new Promise<{ code: number; stdout: string }>((resolve) => {
    execFile('git', ['-C', temporary, ...args], { env, encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => resolve({ code: error ? typeof error.code === 'number' ? error.code : -1 : 0, stdout }))
  })
  try {
    // 기존 객체는 읽기만 한다. Git 설정과 쓰는 객체는 임시 bare 저장소에 격리한다.
    const init = await run(['init', '--bare', '--template=', '--quiet', `--object-format=${objectFormat}`])
    if (init.code !== 0) throw new Error('임시 Git 저장소를 준비하지 못했어요.')
    await writeFile(join(temporary, 'objects', 'info', 'alternates'), objectsDir + '\n')
    const common = await run(['merge-base', left, right])
    if (common.code !== 0) throw new Error('두 커밋의 공통 조상을 확인하지 못했어요.')
    const base = request.base ?? common.stdout.trim()
    if (!isWorktreeOid(base)) throw new Error('비교 기준 커밋을 확인하지 못했어요.')
    if (request.base) {
      const checks = await Promise.all([left, right].map(head => run(['merge-base', '--is-ancestor', base, head])))
      if (checks.some(check => check.code !== 0)) throw new Error('비교 기준은 두 커밋의 공통 조상이어야 해요.')
    }

    const readDiff = (sha: string) => run(['diff', '--name-status', '-z', '--no-ext-diff', '--no-textconv', '-M', base, sha, '--'])
    const readCandidate = (sha: string, diff: Awaited<ReturnType<typeof run>>): WorktreeCandidate => {
      if (diff.code !== 0) throw new Error('변경 파일을 읽지 못했어요.')
      const fields = diff.stdout.split('\0')
      const changes: WorktreeChange[] = []
      let total = 0
      for (let index = 0; index < fields.length - 1;) {
        const status = fields[index++]!
        const from = /^[RC]/.test(status) ? fields[index++] : undefined
        const path = fields[index++]!
        if (++total <= limit) changes.push({ status, path, ...(from ? { from } : {}) })
      }
      return { sha, changes, total }
    }

    const [leftDiff, rightDiff, output] = await Promise.all([
      readDiff(left), readDiff(right), run(['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', left, right]),
    ])
    const paths = output.code === 1 ? [...new Set(output.stdout.split('\0').slice(1).filter(Boolean))].slice(0, limit) : []
    return {
      base, left: readCandidate(left, leftDiff), right: readCandidate(right, rightDiff),
      merge: { state: output.code === 0 ? 'clean' : output.code === 1 ? 'conflicts' : 'unknown', paths },
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
