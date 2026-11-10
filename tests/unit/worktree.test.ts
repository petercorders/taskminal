import { describe, expect, it } from 'vitest'
import { checkBranchName, worktreeDir } from '../../src/shared/worktree'

// 15f: worktree 일감의 브랜치 이름 · 폴더 자리
describe('checkBranchName', () => {
  it('보통 이름은 통과 (슬래시 · 한글 · 점 · 밑줄)', () => {
    for (const n of ['main2', 'stage/15', 'feat/영수증-주소', 'v1.2_fix']) expect(checkBranchName(n)).toBeNull()
  })
  it('나쁜 이름은 이유', () => {
    for (const n of ['', ' ', 'a b', 'a..b', '-x', '/x', 'x/', 'x.', 'x.lock', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', 'a@{b', '@', 'a//b', 'x'.repeat(101), 'a\tb', 'a\u202eb', 'a\u2066b', 'a\u200fb']) {
      expect(checkBranchName(n), n).not.toBeNull()
    }
  })
})

describe('worktreeDir', () => {
  it('저장소 뿌리 옆 <이름>-<브랜치 슬래시를 ->', () => {
    expect(worktreeDir('/Users/a/taskminal', 'stage/15')).toBe('/Users/a/taskminal-stage-15')
    expect(worktreeDir('/Users/a/찍계부', 'feat/주소')).toBe('/Users/a/찍계부-feat-주소')
    expect(worktreeDir('/Users/a/repo/', 'x')).toBe('/Users/a/repo-x')
  })
})
