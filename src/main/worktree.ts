// 15f: 새 일감을 git worktree 에서 — 사용자가 '만들기' 를 누를 때 한 번 git 을 부른다.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { expandHome } from '../shared/cwd'
import { checkBranchName, worktreeDir, type WorktreeResult } from '../shared/worktree'
import { repoRoot } from './git-branch'

const TIMEOUT_MS = 30_000

export async function addWorktree(dir: string, branch: string, home: string): Promise<WorktreeResult> {
  const bad = checkBranchName(branch)
  if (bad) return { ok: false, error: bad }
  const root = await repoRoot(expandHome(dir, home))
  if (!root) return { ok: false, error: '작업 폴더가 git 저장소가 아닙니다' }
  const path = worktreeDir(root, branch)
  if (existsSync(path)) return { ok: false, error: `이미 있는 폴더라 만들 수 없습니다: ${path}` }
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', root, 'worktree', 'add', '-b', branch, path],
      { timeout: TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } },
      (error, _stdout, stderr) => {
        if (!error) return resolve({ ok: true, path })
        // 시간이 넘으면 git 이 폴더를 만들었는지 모른다 — 사용자가 확인하게 경로를 알려 준다
        if (error.killed) return resolve({ ok: false, error: `시간이 넘었습니다 — 폴더가 만들어졌을 수 있어요: ${path}` })
        const line = String(stderr).split('\n').find((l) => l.startsWith('fatal:') || l.startsWith('error:')) ?? String(error.message)
        resolve({ ok: false, error: `git worktree 를 만들지 못했습니다 — ${line.trim()}` })
      },
    )
  })
}
