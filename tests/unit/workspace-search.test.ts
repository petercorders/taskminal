import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { WorkspaceSearch } from '../../src/main/workspace-search'
import { dirOf, GREP_LINE_CHARS, GREP_MAX, GrepParser, grepNotes, grepQuery, parseFileList, parseGrepLine, rangeAt } from '../../src/shared/workspace-search'

// 65단계 — 파일 빨리 열기 · 내용 찾기. 임시 git 저장소로 실제 git 을 부른다.

describe('순수: 찾을 글 · git 출력 해석', () => {
  it('찾을 글은 앞뒤 공백을 뗀 2~200자 — 줄바꿈 · NUL · 다른 타입은 받지 않는다', () => {
    expect(grepQuery('  ab  ')).toBe('ab')
    expect(grepQuery('-rf')).toBe('-rf')
    for (const bad of ['a', ' a ', '', 'a\nb', 'a\0b', 'x'.repeat(201), 5, null, undefined]) expect(grepQuery(bad)).toBeNull()
  })

  it('`경로\\0줄\\0글` 한 줄을 읽고, 모양이 다른 줄은 버리고, 긴 글은 자른다', () => {
    expect(parseGrepLine('src/a b.ts\x0012\x00  const x = 1')).toEqual({ path: 'src/a b.ts', line: 12, text: '  const x = 1' })
    expect(parseGrepLine('a.ts\x003\x00x:y\x00z')).toEqual({ path: 'a.ts', line: 3, text: 'x:y\x00z' }) // 글 안의 것은 그대로
    for (const bad of ['', 'no separators', 'a.ts\x00x\x00text', 'a.ts\x000\x00text', '\x001\x00text', 'a.ts\x001']) expect(parseGrepLine(bad)).toBeNull()
    expect(parseGrepLine(`a.ts\x001\x00${'가'.repeat(GREP_LINE_CHARS + 50)}`)!.text).toHaveLength(GREP_LINE_CHARS)
  })

  it('조각이 줄 가운데서 끊겨도 이어 붙인다', () => {
    const p = new GrepParser()
    expect(p.push('a.ts\x001\x00fir')).toEqual([])
    expect(p.push('st\nb.ts\x002\x00second\nc.ts\x003')).toEqual([{ path: 'a.ts', line: 1, text: 'first' }, { path: 'b.ts', line: 2, text: 'second' }])
    expect(p.push('\x00third\n')).toEqual([{ path: 'c.ts', line: 3, text: 'third' }])
  })

  it('파일 목록은 NUL 로 나누고, 거른 것은 빼고, 상한에서 멈춘다', () => {
    expect(parseFileList('a.ts\x00.env\x00b c.ts\x00', (p) => p !== '.env')).toEqual(['a.ts', 'b c.ts'])
    expect(parseFileList('a\x00b\x00c\x00d', () => true, 2)).toEqual(['a', 'b'])
    // 충돌 중인 파일은 ls-files 가 단계마다(1 · 2 · 3) 한 번씩 낸다 — 한 줄로, 상한도 다른 경로 수로 센다
    expect(parseFileList('a\x00c.ts\x00c.ts\x00c.ts\x00b\x00', () => true, 3)).toEqual(['a', 'c.ts', 'b'])
    expect(parseFileList('', () => true)).toEqual([])
  })
})

describe('순수: 화면에 보일 것', () => {
  const hit = { path: 'a.ts', line: 1, text: 'x' }
  it('안내: 찾는 중 · 없음 · 상한 · 시간 한도 · 실패', () => {
    expect(grepNotes(null, false, false)).toEqual([])
    expect(grepNotes(null, true, false)).toEqual(['찾는 중…'])
    expect(grepNotes({ hits: [hit], more: false, timedOut: false }, true, false)).toEqual(['찾는 중…']) // 앞 결과가 보이는 동안에도
    expect(grepNotes({ hits: [], more: false, timedOut: false }, false, false)).toEqual(['맞는 줄이 없어요.'])
    expect(grepNotes({ hits: [hit], more: false, timedOut: false }, false, false)).toEqual([])
    expect(grepNotes({ hits: [hit], more: true, timedOut: false }, false, false)).toEqual([`결과가 많아 처음 ${GREP_MAX}줄만 보여요. 글을 더 길게 적어 보세요.`])
    expect(grepNotes({ hits: [], more: false, timedOut: true }, false, false)).toEqual(['시간이 넘어 멈췄어요. 찾은 데까지만 보여요.'])
    expect(grepNotes(null, false, true)).toEqual(['찾지 못했어요. 다시 시도해 주세요.'])
  })

  it('파일의 폴더 · 그 줄을 보이는 범위(위로 세 줄 함께)', () => {
    expect(dirOf('src/deep/a.ts')).toBe('src/deep')
    expect(dirOf('README.md')).toBe('')
    expect(rangeAt(undefined, 250)).toEqual({ from: 1, to: 100 })
    expect(rangeAt(undefined, 7)).toEqual({ from: 1, to: 7 })
    expect(rangeAt(120, 250)).toEqual({ from: 117, to: 216 })
    expect(rangeAt(2, 250)).toEqual({ from: 1, to: 100 })
    expect(rangeAt(999, 50)).toEqual({ from: 47, to: 50 }) // 그 사이 파일이 짧아졌다
  })
})

describe('WorkspaceSearch (실제 git)', () => {
  let repo: string
  let plain: string
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  beforeAll(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'tm-search-')))
    plain = realpathSync(mkdtempSync(join(tmpdir(), 'tm-search-plain-')))
    git('init', '-q')
    mkdirSync(join(repo, 'src/deep'), { recursive: true })
    mkdirSync(join(repo, 'node_modules/pkg'), { recursive: true })
    writeFileSync(join(repo, '.gitignore'), 'node_modules\nignored.txt\n')
    writeFileSync(join(repo, 'src/app.ts'), 'const Needle = 1\nconst other = 2\n// needle again -rf\n')
    writeFileSync(join(repo, 'src/deep/한글 파일.md'), '# 제목\nneedle 은 여기에도\n')
    writeFileSync(join(repo, 'untracked.txt'), 'needle in a new file\n')
    writeFileSync(join(repo, 'ignored.txt'), 'needle ignored\n')
    writeFileSync(join(repo, 'node_modules/pkg/index.js'), 'needle in deps\n')
    writeFileSync(join(repo, '.env'), 'NEEDLE_TOKEN=needle\n')
    writeFileSync(join(repo, 'secret.txt'), 'needle token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB\n')
    writeFileSync(join(repo, 'bin.dat'), Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00, 0x01, 0x02]))
    writeFileSync(join(repo, 'many.txt'), Array.from({ length: GREP_MAX + 40 }, (_, i) => `flood ${i}`).join('\n') + '\n')
    git('add', 'src', '.gitignore', 'secret.txt', 'bin.dat', 'many.txt')
    writeFileSync(join(plain, 'a.txt'), 'needle\n')
  })
  const search = new WorkspaceSearch()

  it('파일 목록: 추적 파일 + 무시되지 않은 새 파일. 무시된 것 · 민감 파일은 없다', async () => {
    const files = await search.files(repo)
    expect(files).toEqual(expect.arrayContaining(['.gitignore', 'src/app.ts', 'src/deep/한글 파일.md', 'untracked.txt', 'secret.txt']))
    for (const no of ['ignored.txt', 'node_modules/pkg/index.js', '.env']) expect(files).not.toContain(no)
  })

  it('하위 폴더를 주면 그 폴더 기준 경로로, git 저장소가 아니면 빈 목록', async () => {
    expect(await search.files(join(repo, 'src'))).toEqual(expect.arrayContaining(['app.ts', 'deep/한글 파일.md']))
    expect(await search.files(plain)).toEqual([])
    expect(await search.files(join(plain, 'no-such-dir'))).toEqual([])
  })

  it('내용 찾기: 대소문자 무시 · 줄 번호 · 새 파일 포함. 무시된 것 · 민감 파일 · 이진 파일은 빼고 비밀값은 가린다', async () => {
    const r = await search.grep(repo, 'needle')
    expect(r.more).toBe(false)
    expect(r.timedOut).toBe(false)
    const at = r.hits.map((h) => `${h.path}:${h.line}`)
    expect(at).toEqual(expect.arrayContaining(['src/app.ts:1', 'src/app.ts:3', 'src/deep/한글 파일.md:2', 'untracked.txt:1', 'secret.txt:1']))
    for (const h of r.hits) expect(['ignored.txt', '.env', 'bin.dat', 'node_modules/pkg/index.js']).not.toContain(h.path)
    const secret = r.hits.find((h) => h.path === 'secret.txt')!
    expect(secret.text).toContain('needle token')
    expect(secret.text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789AB')
  })

  it("'-' 로 시작하는 글도 옵션이 아니라 찾을 글이다 · 정규식 글자는 글자 그대로", async () => {
    expect((await search.grep(repo, '-rf')).hits.map((h) => `${h.path}:${h.line}`)).toEqual(['src/app.ts:3'])
    expect((await search.grep(repo, 'ne.dle')).hits).toEqual([])
  })

  it('상한(500줄)에서 멈추고 더 있다고 알린다', async () => {
    const r = await search.grep(repo, 'flood')
    expect(r.hits).toHaveLength(GREP_MAX)
    expect(r.more).toBe(true)
  })

  it('짧은 글 · 잘못된 글은 git 을 부르지 않고 빈 결과, git 저장소가 아니면 빈 결과', async () => {
    expect(await search.grep(repo, 'n')).toEqual({ hits: [], more: false, timedOut: false })
    expect(await search.grep(repo, 'a\nb')).toEqual({ hits: [], more: false, timedOut: false })
    expect((await search.grep(plain, 'needle')).hits).toEqual([])
  })

  it('같은 폴더의 새 찾기는 앞 찾기를 끝내고 반드시 돈다 — 뒤 요청의 결과가 온전하다', async () => {
    const first = search.grep(repo, 'flood')
    const second = search.grep(repo, 'needle')
    const [a, b] = await Promise.all([first, second])
    expect(b.hits.map((h) => `${h.path}:${h.line}`)).toEqual(expect.arrayContaining(['src/app.ts:1', 'untracked.txt:1']))
    expect(a.hits.length).toBeLessThanOrEqual(GREP_MAX) // 앞 요청은 끝난 데까지만
  })

  it('시간 한도를 넘으면 멈추고 알린다', async () => {
    const slow = new WorkspaceSearch(() => ({}), 0)
    const r = await slow.grep(repo, 'needle')
    expect(r.timedOut).toBe(true)
  })
})
