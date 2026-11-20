import { describe, expect, it } from 'vitest'
import { MAX_PR_REPORT_BYTES, parsePrVerification, prVerificationStatus } from '../../src/shared/pr-verification'

const head = 'a'.repeat(40)
const next = 'b'.repeat(40)
const target = { repository: 'o/r', number: 7 }
const entries = [
  { criterion: '가져오기 버튼이 겹치지 않는다', check: 'import-repo.spec.ts', exitCode: 0 },
  { criterion: '이름을 바꿔도 올바른 일감을 정리한다', check: 'worktree-cleanup.spec.ts', exitCode: null },
]
const report = { version: 1, repository: 'O/R', pullRequest: 7, startSha: head, endSha: head, entries }
const parse = (value: unknown) => parsePrVerification(JSON.stringify(value), target)

describe('PR 검증 보고서', () => {
  it('PR과 대소문자 구분 없이 저장소를 맞추고 검사 결과를 유지한다', () => {
    expect(parse(report)).toEqual({ head, entries })
    expect(prVerificationStatus(head, head)).toBe('current')
    expect(prVerificationStatus(head, next)).toBe('previous')
    expect(prVerificationStatus(head, null)).toBe('pr-unavailable')
    expect(prVerificationStatus(head, 'abc')).toBe('pr-unavailable')
  })

  it('검사 시작·종료 SHA가 다르거나 어느 한쪽을 모르면 커밋 미확인이다', () => {
    for (const patch of [{ endSha: next }, { startSha: undefined }, { endSha: 'abc' }, { endSha: `${head}a` }]) {
      const result = parse({ ...report, ...patch })
      expect(result?.head).toBeNull()
      expect(prVerificationStatus(result?.head ?? null, head)).toBe('report-unverified')
    }
  })

  it('형식·크기·다른 저장소나 PR·잘못된 검사 결과를 거절한다', () => {
    for (const patch of [
      { version: 2 }, { repository: 'o/else' }, { pullRequest: 8 }, { entries: [] },
      { entries: Array(51).fill(entries[0]) }, { entries: [{ ...entries[0], criterion: ' ' }] },
      { entries: [{ ...entries[0], check: 'a'.repeat(201) }] },
      { entries: [{ ...entries[0], exitCode: '0' }] }, { entries: [{ ...entries[0], exitCode: -1 }] },
      { entries: [{ ...entries[0], exitCode: 256 }] },
    ]) expect(parse({ ...report, ...patch })).toBeNull()
    expect(parsePrVerification('a'.repeat(MAX_PR_REPORT_BYTES + 1), target)).toBeNull()
    expect(parse({
      ...report,
      entries: Array(50).fill({ criterion: '가'.repeat(400), check: '나'.repeat(200), exitCode: 0 }),
    })).toBeNull()
    expect(parsePrVerification('{', target)).toBeNull()
  })

  it('불안정·e2e 미실행 종료 코드도 원문 그대로 읽는다', () => {
    for (const exitCode of [1, 3, 4]) {
      expect(parse({ ...report, entries: [{ ...entries[0], exitCode }] })?.entries[0]?.exitCode).toBe(exitCode)
    }
  })
})
