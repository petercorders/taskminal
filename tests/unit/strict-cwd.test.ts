import { describe, expect, it } from 'vitest'
import { parseStrictLsofCwds } from '../../src/shared/cwd'

const row = (pid: number, path: string) => `p${pid}\0\nfcwd\0n${path}\0\n`

describe('strict lsof cwd records for destructive worktree operations', () => {
  it('accepts complete NUL records and ordinary Unicode paths for every requested PID', () => {
    expect(parseStrictLsofCwds(row(202, '/한글 폴더/a%b') + row(101, '/tmp'), [101, 202]))
      .toEqual({ 101: '/tmp', 202: '/한글 폴더/a%b' })
    expect(parseStrictLsofCwds('', [])).toEqual({})
  })

  it.each(['/tmp/a\\nb', '/tmp/a\\x0ab', '/tmp/a^Jb', '/tmp/a\nb', '/tmp/a\tb', '/tmp/a\u007fb', '/tmp/a\u0085b', '/tmp/a\uFFFDb', '/tmp/a (deleted)'])('rejects ambiguous cwd %j rather than claiming verification', path => {
    expect(() => parseStrictLsofCwds(row(101, path), [101])).toThrow()
  })

  it.each([
    '', row(101, '/tmp') + row(101, '/other'), row(202, '/tmp'),
    row(101, 'relative'), row(101, '/tmp').slice(0, -1),
    row(101, '/tmp').slice(0, -2), 'p101\nfcwd\nn/tmp\n',
    row(101, '/tmp') + 'junk', 'p101\0\nfcwd\0n/tmp\0n/other\0\n',
    'p101\0\nftxt\0n/tmp\0\n', 'p0101\0\nfcwd\0n/tmp\0\n',
  ])('rejects incomplete, unexpected or duplicate records %j', out => {
    expect(() => parseStrictLsofCwds(out, [101])).toThrow()
  })

  it('rejects missing requested PIDs and invalid or duplicate requested identities', () => {
    expect(() => parseStrictLsofCwds(row(101, '/tmp'), [101, 202])).toThrow()
    for (const pids of [[101, 101], [0], [-1], [1.5], [NaN], [2 ** 31]]) {
      expect(() => parseStrictLsofCwds('', pids)).toThrow()
    }
  })
})
