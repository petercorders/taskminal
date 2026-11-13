import { execFile } from 'node:child_process'
import { parseLsofCwd, parseStrictLsofCwds } from '../shared/cwd'

const LSOF = '/usr/sbin/lsof'
const TIMEOUT_MS = 2000

/**
 * 셸 통합(OSC 7)이 없는 셸의 작업 폴더 — lsof 를 한 번 부른다 (13단계).
 * 없는 pid 가 섞여 있으면 lsof 가 1 로 끝나도 찾은 것은 출력에 있다. 실패 · 시간 초과면 빈 결과.
 */
export function lsofCwds(pids: readonly number[]): Promise<Record<number, string>> {
  const list = pids.filter((p) => Number.isInteger(p) && p > 0)
  if (list.length === 0) return Promise.resolve({})
  return new Promise((resolve) => {
    // 로캘이 UTF-8 이 아니면(Finder 로 띄운 앱 · LANG 없음) lsof 가 한글 경로 바이트를 `\xNN` 글자로 찍는다(13단계 리뷰에서 재현)
    const env = { ...process.env, LC_ALL: 'en_US.UTF-8' }
    execFile(LSOF, ['-a', '-d', 'cwd', '-Fpn', '-p', list.join(',')], { timeout: TIMEOUT_MS, env }, (_error, stdout) => {
      resolve(parseLsofCwd(typeof stdout === 'string' ? stdout : ''))
    })
  })
}

/** Worktree mutation guard: every requested PID must have one unambiguous cwd.
 * Unlike the display probe above, partial output and process failures reject.
 */
export async function strictLsofCwds(pids: readonly number[]): Promise<Record<number, string>> {
  // Validate before invoking a process; duplicate identities are not silently lost.
  const list = [...pids]
  if (list.length === 0) return parseStrictLsofCwds('', list)
  if (list.length > 4096 || list.some(pid => !Number.isInteger(pid) || pid <= 0 || pid >= 2 ** 31) || new Set(list).size !== list.length) {
    throw new Error('실행 중인 셸의 PID를 확인하지 못했어요')
  }
  return new Promise((resolve, reject) => {
    const env = { ...process.env, LC_ALL: 'en_US.UTF-8' }
    execFile(LSOF, ['-a', '-d', 'cwd', '-F0pn', '-p', list.join(',')], { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env }, (error, stdout, stderr) => {
      if (error || stderr || typeof stdout !== 'string') {
        reject(new Error('실행 중인 셸의 폴더를 확인하지 못했어요. 정리하지 않았어요.'))
        return
      }
      try { resolve(parseStrictLsofCwds(stdout, list)) }
      catch (cause) { reject(cause) }
    })
  })
}
