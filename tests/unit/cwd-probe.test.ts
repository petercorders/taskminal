import { describe, expect, it } from 'vitest'
import { lsofCwds } from '../../src/main/cwd-probe'

// 실제 lsof 로 시험한다 — 이 시험 프로세스의 작업 폴더를 읽는다.
describe('lsofCwds (13단계 — 셸 통합이 없는 셸의 폴더)', () => {
  it('pid 의 작업 폴더를 돌려준다', async () => {
    const got = await lsofCwds([process.pid])
    expect(got[process.pid]).toBe(process.cwd())
  })

  it('빈 목록이면 lsof 를 부르지 않고 빈 결과, 없는 pid 는 빠진다', async () => {
    expect(await lsofCwds([])).toEqual({})
    const got = await lsofCwds([process.pid, 999_999])
    expect(Object.keys(got)).toEqual([String(process.pid)])
  })
})
