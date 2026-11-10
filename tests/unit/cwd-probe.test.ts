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

describe('lsofCwds — 로캘이 없어도 한글 폴더 (13단계 리뷰)', () => {
  it('LANG · LC_ALL 이 없는 환경(Finder 실행)에서도 한글 경로를 그대로', async () => {
    const { mkdtempSync, mkdirSync, realpathSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { spawn } = await import('node:child_process')
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'taskminal-lsof-')))
    const folder = join(root, '한글 a%b')
    mkdirSync(folder)
    const child = spawn('/bin/sleep', ['5'], { cwd: folder })
    const saved = { LANG: process.env['LANG'], LC_ALL: process.env['LC_ALL'], LC_CTYPE: process.env['LC_CTYPE'] }
    for (const k of Object.keys(saved)) delete process.env[k]
    try {
      const got = await lsofCwds([child.pid!])
      expect(got[child.pid!]).toBe(folder)
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v
      child.kill()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
