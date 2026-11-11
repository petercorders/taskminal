import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ErrorLog } from '../../src/main/errlog'
import { LOG_MAX_BYTES, logFileName } from '../../src/shared/errlog'

let root: string
let dir: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tm-errlog-'))
  dir = join(root, 'logs')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const NOW = new Date('2026-11-11T10:00:00').getTime()

describe('ErrorLog', () => {
  it('오늘 파일에 한 줄씩 — 폴더 0700 · 파일 0600, 읽으면 묶인 줄', () => {
    const log = new ErrorLog(dir, () => ({}), () => NOW)
    log.write('error', 'pty-spawn', '셸을 띄우지 못했어요', new Error('posix_spawnp failed'))
    log.write('error', 'pty-spawn', '셸을 띄우지 못했어요', new Error('posix_spawnp failed'))
    const file = join(dir, logFileName(NOW))
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(log.rows().map((r) => [r.key, r.count, r.detail])).toEqual([['pty-spawn', 2, 'posix_spawnp failed']])
  })

  it('글 · 원문의 비밀값은 가려서 쓴다 (디스크로 가는 새 길 — 17단계 규칙)', () => {
    const log = new ErrorLog(dir, () => ({}), () => NOW)
    log.write('error', 'x', '키 sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789', 'Bearer abcdefghijklmnopqrstuvwxyz012345')
    const text = readFileSync(join(dir, logFileName(NOW)), 'utf8')
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789')
    expect(text).not.toContain('Bearer abcdefghijklmnopqrstuvwxyz012345')
  })

  it('시작할 때 7일 지난 기록 파일을 지우고, 모르는 파일은 둔다', () => {
    const log = new ErrorLog(dir, () => ({}), () => NOW)
    log.write('warn', 'k', 'm')
    writeFileSync(join(dir, 'main-2026-10-01.log'), '')
    writeFileSync(join(dir, 'other.txt'), '')
    log.prune()
    expect(readdirSync(dir).sort()).toEqual([logFileName(NOW), 'other.txt'])
  })

  it('폴더가 상한(5MB)을 넘으면 더 쓰지 않는다 · 쓰기 실패는 던지지 않는다', () => {
    const log = new ErrorLog(dir, () => ({}), () => NOW)
    log.write('warn', 'k', 'm')
    writeFileSync(join(dir, 'main-2026-11-10.log'), Buffer.alloc(LOG_MAX_BYTES))
    const before = statSync(join(dir, logFileName(NOW))).size
    log.write('error', 'k2', 'm2')
    expect(statSync(join(dir, logFileName(NOW))).size).toBe(before)
    // 폴더 자리에 파일 — mkdir 이 실패해도 앱을 멈추지 않는다
    const broken = new ErrorLog(join(root, 'file-not-dir', 'logs'), () => ({}), () => NOW)
    writeFileSync(join(root, 'file-not-dir'), '')
    expect(() => broken.write('error', 'k', 'm')).not.toThrow()
    expect(broken.rows()).toEqual([])
  })

  it('폴더가 없으면 빈 목록', () => {
    expect(new ErrorLog(dir, () => ({}), () => NOW).rows()).toEqual([])
    expect(existsSync(dir)).toBe(false)
  })
})
