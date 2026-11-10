// 15c: 폴더의 git 브랜치를 파일로 읽는다 — /usr/bin/git 은 Command Line Tools 가 없으면 설치 창을 띄우고, 주기마다 프로세스를 만들지 않으려고.
import { open, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { expandHome } from '../shared/cwd'
import { parseGitdir, parseHead } from '../shared/git'

const MAX_FILE = 4096 // HEAD · .git 파일은 한 줄
const MAX_DEPTH = 64

async function readSmall(path: string): Promise<string | null> {
  let f
  try {
    f = await open(path, 'r')
    const buf = Buffer.alloc(MAX_FILE)
    const { bytesRead } = await f.read(buf, 0, MAX_FILE, 0)
    return buf.subarray(0, bytesRead).toString('utf8')
  } catch {
    return null
  } finally {
    await f?.close().catch(() => {}) // 닫기 실패가 다른 폴더의 결과까지 막지 않게
  }
}

/** dir 에서 위로 `.git` 을 찾아 HEAD 를 푼다. 저장소가 아니거나 못 읽으면 null */
export async function branchOf(dir: string): Promise<string | null> {
  let d = resolve(dir)
  for (let i = 0; i < MAX_DEPTH; i++) {
    const dotGit = join(d, '.git')
    let st
    try {
      st = await stat(dotGit)
    } catch (e) {
      // 없음(ENOENT · ENOTDIR)만 위로 — 권한 · 입출력 오류는 '모름' (위쪽 저장소의 브랜치로 잘못 보이지 않게)
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null
      st = null
    }
    if (st?.isDirectory()) return parseOr(await readSmall(join(dotGit, 'HEAD')))
    if (st?.isFile()) {
      // worktree: `.git` 파일이 진짜 git 폴더를 가리킨다 (상대 경로는 그 폴더 기준)
      const gitdir = parseGitdir((await readSmall(dotGit)) ?? '')
      if (!gitdir) return null
      return parseOr(await readSmall(join(isAbsolute(gitdir) ? gitdir : resolve(d, gitdir), 'HEAD')))
    }
    const up = dirname(d)
    if (up === d) return null
    d = up
  }
  return null
}

const parseOr = (text: string | null): string | null => (text === null ? null : parseHead(text))

/** 여러 폴더 — `~` 는 home 으로 풀어 읽고, 결과는 받은 글자 그대로를 키로 */
export async function branchesOf(dirs: readonly string[], home: string): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {}
  await Promise.all(
    dirs.map(async (raw) => {
      const path = expandHome(raw, home)
      out[raw] = isAbsolute(path) ? await branchOf(path) : null
    }),
  )
  return out
}
