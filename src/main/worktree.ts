// 15f: 새 일감을 git worktree 에서 — 사용자가 '만들기' 를 누를 때 한 번 git 을 부른다.
import { execFile } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { expandHome } from '../shared/cwd'
import { checkBranchName, worktreeDir, type WorktreeResult } from '../shared/worktree'
import { repoRoot } from './git-branch'

// 큰 저장소 · LFS 체크아웃은 정상이어도 오래 걸린다 — 죽이면 반쯤 만든 worktree 가 남으므로 넉넉히
const TIMEOUT_MS = 120_000

export async function addWorktree(dir: string, branch: string, home: string): Promise<WorktreeResult> {
  const bad = checkBranchName(branch)
  if (bad) return { ok: false, error: bad }
  // 앞뒤 빈칸을 떼고(끝 빈칸이면 없는 폴더라 위로 올라가 바깥 저장소에 만든다), 상대 경로는 받지 않는다(main 의 지금 폴더 기준이 된다) — 15f 리뷰
  const start = expandHome(dir.trim(), home)
  if (!isAbsolute(start)) return { ok: false, error: '작업 폴더는 절대 경로(또는 ~)여야 합니다' }
  const root = await repoRoot(start)
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
        // 시간이 넘으면 git 이 어디까지 했는지 모른다 — 사용자가 확인하게 경로 · 브랜치를 알려 준다
        if (error.killed) {
          return resolve({ ok: false, error: `시간이 넘었습니다 — 폴더 · 브랜치가 만들어졌을 수 있어요: ${path} (${branch}) · git worktree list 로 확인` })
        }
        // post-checkout 훅(husky · LFS)이 실패해도 git 은 worktree 를 다 만든 뒤 1 로 끝난다 — 실제로 생겼으면 성공
        void registered(root, path).then((made) => {
          if (made) return resolve({ ok: true, path })
          const lines = String(stderr).split('\n').map((l) => l.trim())
          const line = lines.find((l) => l.startsWith('fatal:') || l.startsWith('error:')) ?? lines.filter(Boolean).pop() ?? '알 수 없는 오류'
          resolve({ ok: false, error: `git worktree 를 만들지 못했습니다 — ${line}` })
        })
      },
    )
  })
}

/** 그 경로가 저장소의 worktree 로 등록됐는지 (`git worktree list --porcelain`) */
function registered(root: string, path: string): Promise<boolean> {
  if (!existsSync(path)) return Promise.resolve(false)
  return new Promise((resolve) => {
    execFile('git', ['-C', root, 'worktree', 'list', '--porcelain'], { timeout: 10_000, env: { ...process.env, LC_ALL: 'C' } }, (error, stdout) => {
      // git 은 실제 경로로 적는다(/var → /private/var 같은 링크)
      const real = realpathSync(path)
      resolve(!error && String(stdout).split('\n').some((l) => l === `worktree ${path}` || l === `worktree ${real}`))
    })
  })
}
