import { describe, expect, it } from 'vitest'
import {
  buildPatch,
  commitWarnings,
  fileSig,
  filterFiles,
  folderGroups,
  foldReason,
  liveReverted,
  resolveReviewPath,
  parseDiff,
  parseStatus,
  untrackedDiff,
  unquotePath,
  wholePatch,
  type DiffFile,
} from '../../src/shared/review'

const NUL = '\0'

describe('parseStatus (porcelain v2 -z --branch)', () => {
  it('브랜치 · 커밋 · 새 파일 · 충돌을 읽는다 — 공백 · 한글 경로 그대로', () => {
    const z = [
      '# branch.oid 1234567890abcdef1234567890abcdef12345678',
      '# branch.head stage-15',
      '1 .M N... 100644 100644 100644 aaa bbb src/a b.ts',
      '2 R. N... 100644 100644 100644 aaa bbb R100 새 이름.ts',
      '옛 이름.ts',
      'u UU N... 100644 100644 100644 100644 a b c conflict.txt',
      '? 메모 임시.txt',
      '',
    ].join(NUL)
    const s = parseStatus(z)
    expect(s.branch).toBe('stage-15')
    expect(s.oid).toBe('1234567890abcdef1234567890abcdef12345678')
    expect(s.untracked).toEqual(['메모 임시.txt'])
    expect(s.conflicted).toEqual(['conflict.txt'])
    expect(s.staged).toEqual(['새 이름.ts'])
  })
  it('처음 커밋 전 · 떨어진 HEAD 는 null', () => {
    const s = parseStatus(['# branch.oid (initial)', '# branch.head (detached)', ''].join(NUL))
    expect(s.branch).toBeNull()
    expect(s.oid).toBeNull()
  })
})

const DIFF = `diff --git a/x.txt b/x.txt
index f9d9a01..1b560b1 100644
--- a/x.txt
+++ b/x.txt
@@ -1,7 +1,9 @@ head
 a
-b
+B1
+B2
 c
 d
-e
+E
 f
 g
+h
diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..2e65efe
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+one
+two
\\ No newline at end of file
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 2e65efe..0000000
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-x
diff --git a/img.png b/img.png
index 1111111..2222222 100644
Binary files a/img.png and b/img.png differ
diff --git "a/\\355\\225\\234.txt" "b/\\355\\225\\234.txt"
index 1..2 100644
--- "a/\\355\\225\\234.txt"
+++ "b/\\355\\225\\234.txt"
@@ -1 +1 @@
-가
+나
`

describe('parseDiff', () => {
  const files = parseDiff(DIFF)
  it('파일 · 종류 · 더함/뺌 수', () => {
    expect(files.map((f) => [f.path, f.kind, f.add, f.del])).toEqual([
      ['x.txt', 'M', 4, 2],
      ['new.txt', 'A', 2, 0],
      ['gone.txt', 'D', 0, 1],
      ['img.png', 'M', 0, 0],
      ['한.txt', 'M', 1, 1],
    ])
    expect(files[3]!.binary).toBe(true)
  })
  it('줄 번호 — 옛 · 새', () => {
    const lines = files[0]!.hunks[0]!.lines
    expect(lines[0]).toMatchObject({ t: ' ', text: 'a', oldNo: 1, newNo: 1 })
    expect(lines[1]).toMatchObject({ t: '-', text: 'b', oldNo: 2 })
    expect(lines[2]).toMatchObject({ t: '+', text: 'B1', newNo: 2 })
    expect(lines.at(-1)).toMatchObject({ t: '+', text: 'h', newNo: 9 })
    expect(files[0]!.hunks[0]!.header).toBe('@@ -1,7 +1,9 @@ head')
  })
  it('끝 줄바꿈 없음 표시를 그 줄에 단다', () => {
    expect(files[1]!.hunks[0]!.lines.at(-1)).toMatchObject({ text: 'two', noEol: true })
  })
  it('따옴표 · 8진 경로를 푼다', () => {
    expect(unquotePath('"a/\\355\\225\\234 \\"q\\".txt"')).toBe('a/한 "q".txt')
    expect(unquotePath('a/plain.txt')).toBe('a/plain.txt')
  })
})

describe('untrackedDiff', () => {
  it('새 파일 글을 + 줄로 · 끝 줄바꿈 없으면 표시', () => {
    const f = untrackedDiff('n.txt', 'a\nb')
    expect(f).toMatchObject({ path: 'n.txt', kind: 'A', add: 2, untracked: true })
    expect(f.hunks[0]!.lines.map((l) => [l.t, l.text, l.noEol ?? false])).toEqual([
      ['+', 'a', false],
      ['+', 'b', true],
    ])
  })
  it('빈 파일은 덩어리 없음', () => {
    expect(untrackedDiff('e.txt', '').hunks).toEqual([])
  })
})

describe('buildPatch — 고른 줄만 되돌리는 패치(문맥 방식)', () => {
  const x = parseDiff(DIFF)[0]!
  it('가운데 -e +E 만: 고르지 않은 + 는 문맥, 고르지 않은 - 는 뺌', () => {
    const p = buildPatch(x, new Set(['0:6', '0:7']))
    expect(p).toBe('diff --git a/x.txt b/x.txt\n--- a/x.txt\n+++ b/x.txt\n@@ -1,9 +1,9 @@\n a\n B1\n B2\n c\n d\n-e\n+E\n f\n g\n h\n')
  })
  it('끝 + 만', () => {
    expect(buildPatch(x, new Set(['0:10']))).toBe('diff --git a/x.txt b/x.txt\n--- a/x.txt\n+++ b/x.txt\n@@ -1,8 +1,9 @@\n a\n B1\n B2\n c\n d\n E\n f\n g\n+h\n')
  })
  it('끝 줄바꿈 없음 표시는 그 줄이 문맥이 되어도 따라간다', () => {
    const n = untrackedDiff('n.txt', 'a\nb')
    expect(buildPatch(n, new Set(['0:0']))).toBe('diff --git a/n.txt b/n.txt\n--- a/n.txt\n+++ b/n.txt\n@@ -1,1 +1,2 @@\n+a\n b\n\\ No newline at end of file\n')
  })
  it('고른 줄이 없거나 문맥 줄만이면 null', () => {
    expect(buildPatch(x, new Set())).toBeNull()
    expect(buildPatch(x, new Set(['0:0']))).toBeNull()
  })
  it('고르지 않은 덩어리는 넣지 않는다', () => {
    const two = parseDiff('diff --git a/t b/t\n--- a/t\n+++ b/t\n@@ -1,2 +1,2 @@\n-a\n+A\n z\n@@ -10,2 +10,2 @@\n y\n-b\n+B\n')[0]!
    const p = buildPatch(two, new Set(['1:1']))!
    expect(p).not.toContain('@@ -1,')
    expect(p).toContain('@@ -10,3 +10,2 @@\n y\n-b\n B\n')
  })
})

describe('wholePatch', () => {
  it('새 파일 — new file 머리로(되돌리면 지움)', () => {
    expect(wholePatch(untrackedDiff('n.txt', 'a\n'))).toBe('diff --git a/n.txt b/n.txt\nnew file mode 100644\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,1 @@\n+a\n')
  })
  it('지운 파일 — deleted file 머리로(되돌리면 되살림)', () => {
    expect(wholePatch(parseDiff(DIFF)[2]!)).toBe('diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\n--- a/gone.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-x\n')
  })
  it('이진 파일은 null(줄 패치로 못 함)', () => {
    expect(wholePatch(parseDiff(DIFF)[3]!)).toBeNull()
  })
})

describe('foldReason · fileSig · filterFiles · folderGroups', () => {
  const big: DiffFile = { ...untrackedDiff('package-lock.json', 'x\n'.repeat(5001)) }
  it('5000줄 넘거나 이진이면 접는다', () => {
    expect(foldReason(big)).toBe('big')
    expect(foldReason(parseDiff(DIFF)[3]!)).toBe('binary')
    expect(foldReason(parseDiff(DIFF)[0]!)).toBeNull()
  })
  it('같은 내용이면 같은 표지, 줄 하나가 바뀌면 다름', () => {
    expect(fileSig(untrackedDiff('a', 'x\ny'))).toBe(fileSig(untrackedDiff('a', 'x\ny')))
    expect(fileSig(untrackedDiff('a', 'x\ny'))).not.toBe(fileSig(untrackedDiff('a', 'x\nz')))
    expect(fileSig(untrackedDiff('a', 'x'))).not.toBe(fileSig(untrackedDiff('b', 'x')))
  })
  it('거르기는 경로의 글자들이 차례로 들어 있으면', () => {
    const fs = parseDiff(DIFF)
    expect(filterFiles(fs, 'nwt').map((f) => f.path)).toEqual(['new.txt'])
    expect(filterFiles(fs, '').length).toBe(fs.length)
  })
  it('폴더 보기 — 맨 위 폴더로 묶고 수를 더한다', () => {
    const fs = [untrackedDiff('src/a.ts', 'x\n'), untrackedDiff('src/b/c.ts', 'x\ny\n'), untrackedDiff('top.txt', 'z\n')]
    expect(folderGroups(fs).map((g) => [g.name, g.files.length, g.add])).toEqual([
      ['src/', 2, 3],
      ['', 1, 1],
    ])
  })
})

describe('commitWarnings', () => {
  const sec = untrackedDiff('notes/memo.txt', 'hello\nkey=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789\n')
  it('갈래 아닌 저장소의 main 에 바로 · 비밀값 줄', () => {
    const w = commitWarnings({ branch: 'main', worktree: false, files: [sec] })
    expect(w).toEqual([
      { kind: 'main', text: '⎇ main 에 바로 커밋해요 — 따로 갈래를 만들지 않은 일감이에요' },
      { kind: 'secret', text: '비밀값으로 보이는 줄이 1개 있어요 · notes/memo.txt 2번째 줄', path: 'notes/memo.txt', line: 2 },
    ])
  })
  it('worktree 거나 다른 브랜치면 main 경고 없음 · 지운 줄의 비밀값은 세지 않는다', () => {
    expect(commitWarnings({ branch: 'main', worktree: true, files: [] })).toEqual([])
    expect(commitWarnings({ branch: 'feat', worktree: false, files: [] })).toEqual([])
    const removed = parseDiff('diff --git a/k b/k\n--- a/k\n+++ b/k\n@@ -1 +1 @@\n-sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789\n+ok\n')
    expect(commitWarnings({ branch: 'feat', worktree: false, files: removed })).toEqual([])
  })
})

describe('resolveReviewPath — 대화 폴더 기준 → 저장소 뿌리 기준', () => {
  const files = [{ path: 'packages/app/src/x.ts' }, { path: 'README.md' }]
  it('일감 폴더가 하위 폴더면 앞에 붙인다 · 뿌리면 그대로 · 없으면 null', () => {
    expect(resolveReviewPath(files, '/r', '/r/packages/app', 'src/x.ts')).toBe('packages/app/src/x.ts')
    expect(resolveReviewPath(files, '/r', '/r/', 'README.md')).toBe('README.md')
    expect(resolveReviewPath(files, '/r', '/r/packages/app', 'nope.ts')).toBe(null)
    expect(resolveReviewPath(files, '/r', '/rx/packages/app', 'src/x.ts')).toBe(null)
  })
})

describe('liveReverted — 7일', () => {
  const day = 86_400_000
  it('7일 안 · 적용된 것만, 새것부터', () => {
    const now = 100 * day
    const rs = [
      { id: 'a', at: now - 7 * day + 1, applied: true },
      { id: 'b', at: now - 7 * day - 1, applied: true },
      { id: 'c', at: now - 1000, applied: false },
      { id: 'd', at: now - 10, applied: true },
    ]
    expect(liveReverted(rs, now).map((r) => r.id)).toEqual(['d', 'a'])
  })
})
