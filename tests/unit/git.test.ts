import { describe, expect, it } from 'vitest'
import { keepIfSame, parseGitdir, parseHead, taskDirs } from '../../src/shared/git'

// 15c: .git/HEAD · .git 파일(worktree) 읽기 — git 을 실행하지 않는다.
describe('parseHead', () => {
  it('브랜치 이름 (슬래시 · 한글 포함)', () => {
    expect(parseHead('ref: refs/heads/main\n')).toBe('main')
    expect(parseHead('ref: refs/heads/feat/x-1\n')).toBe('feat/x-1')
    expect(parseHead('ref: refs/heads/한글-브랜치')).toBe('한글-브랜치')
  })
  it('브랜치가 아닌 HEAD 는 커밋 앞 7자리 (sha1 · sha256)', () => {
    expect(parseHead('0123456789abcdef0123456789abcdef01234567\n')).toBe('0123456')
    expect(parseHead('a'.repeat(64))).toBe('aaaaaaa')
  })
  it('깨진 글 · 빈 글 · 다른 ref 는 null', () => {
    for (const t of ['', 'garbage', 'ref: ', 'ref: refs/heads/', 'ref: refs/tags/v1', '0123', 'g'.repeat(40)]) expect(parseHead(t)).toBeNull()
  })
})

describe('parseGitdir', () => {
  it('gitdir: 줄의 경로', () => {
    expect(parseGitdir('gitdir: /a/b/.git/worktrees/x\n')).toBe('/a/b/.git/worktrees/x')
    expect(parseGitdir('gitdir: ../main/.git/worktrees/x')).toBe('../main/.git/worktrees/x')
  })
  it('아니면 null', () => {
    expect(parseGitdir('')).toBeNull()
    expect(parseGitdir('gitdir: ')).toBeNull()
    expect(parseGitdir('something')).toBeNull()
  })
})

describe('keepIfSame · taskDirs', () => {
  it('같은 결과면 이전 객체, 하나라도 다르면(값 · 키 수 · null) 새 객체', () => {
    const prev = { '/a': 'main', '/b': null }
    expect(keepIfSame(prev, { '/a': 'main', '/b': null })).toBe(prev)
    const changed = { '/a': 'feat', '/b': null }
    expect(keepIfSame(prev, changed)).toBe(changed)
    const fewer = { '/a': 'main' }
    expect(keepIfSame(prev, fewer)).toBe(fewer)
    const other = { '/a': 'main', '/c': null }
    expect(keepIfSame(prev, other)).toBe(other)
  })
  it('일감 폴더 목록은 겹침 없이 정렬, 빈 글은 뺀다', () => {
    expect(taskDirs(['~/b', '~/a', '~/b', ''])).toEqual(['~/a', '~/b'])
  })
})
