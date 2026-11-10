import { execFile } from 'node:child_process'
import { parseLsofCwd } from '../shared/cwd'

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
    execFile(LSOF, ['-a', '-d', 'cwd', '-Fpn', '-p', list.join(',')], { timeout: TIMEOUT_MS }, (_error, stdout) => {
      resolve(parseLsofCwd(typeof stdout === 'string' ? stdout : ''))
    })
  })
}
