import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, symlinkSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { commitFiles, loadReview, makeRunGit, openTarget, restoreReverted, revertFile, revertLines, RevertStore, ReviewWatch, safeRel, undoCommit, type ReviewOk, type RunGit } from '../../src/main/review-git'
import { fileSig, lineKey, watchIgnored } from '../../src/shared/review'

const run = makeRunGit()
let base: string
let repo: string
let store: RevertStore

const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
const write = (p: string, s: string) => writeFileSync(join(repo, p), s)
const read = (p: string) => readFileSync(join(repo, p), 'utf8')

beforeEach(() => {
  // git 은 실제 경로(/private/var…)를 돌려준다 — 기록의 root 와 맞게
  base = realpathSync(mkdtempSync(join(tmpdir(), 'tm-review-')))
  repo = join(base, 'repo')
  mkdirSync(repo)
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  git('config', 'commit.gpgsign', 'false')
  write('x.txt', 'a\nb\nc\nd\ne\nf\ng\n')
  write('keep.txt', 'k\n')
  git('add', '.')
  git('commit', '-qm', 'init')
  store = new RevertStore(join(base, 'reverted'))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

async function ok(dir = repo): Promise<ReviewOk> {
  const r = await loadReview(run, dir)
  if (r.state !== 'ok') throw new Error(`상태 ${r.state}`)
  return r
}
/** 지금 보이는 diff 의 표지로 커밋 — 화면이 하는 그대로 */
async function commitNow(paths: string[], msg: string) {
  const fs = (await ok()).files
  return commitFiles(run, repo, paths, msg, paths.map((p) => { const f = fs.find((x) => x.path === p); return f ? fileSig(f) : '' }))
}

describe('loadReview', () => {
  it('바뀐 것 없음 · 마지막 커밋', async () => {
    const r = await ok()
    expect(r.files).toEqual([])
    expect(r.branch).toBe('main')
    expect(r.head?.subject).toBe('init')
    expect(r.worktree).toBe(false)
    expect(r.merging).toBe(false)
  })
  it('저장소 아님 · 하위 폴더에서도 저장소 뿌리', async () => {
    const plain = join(base, 'plain')
    mkdirSync(plain)
    expect((await loadReview(run, plain)).state).toBe('not-repo')
    mkdirSync(join(repo, 'sub'))
    expect((await ok(join(repo, 'sub'))).root).toBe(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: repo, encoding: 'utf8' }).trim())
  })
  it('git 이 없으면 no-git', async () => {
    expect((await loadReview(makeRunGit(join(base, 'no-such-git')), repo)).state).toBe('no-git')
  })
  it('고친 · 새 · 지운 파일 — 새 파일은 글을 읽어 + 줄로', async () => {
    write('x.txt', 'a\nB\nc\nd\ne\nf\ng\n')
    write('새 메모.txt', 'n1\nn2\n')
    rmSync(join(repo, 'keep.txt'))
    const r = await ok()
    expect(r.files.map((f) => [f.path, f.kind, f.add, f.del, f.untracked ?? false])).toEqual([
      ['keep.txt', 'D', 0, 1, false],
      ['x.txt', 'M', 1, 1, false],
      ['새 메모.txt', 'A', 2, 0, true],
    ])
  })
  it('병합 충돌이면 merging', async () => {
    git('checkout', '-qb', 'other')
    write('x.txt', 'OTHER\n')
    git('commit', '-qam', 'o')
    git('checkout', '-q', 'main')
    write('x.txt', 'MAIN\n')
    git('commit', '-qam', 'm')
    try {
      git('merge', 'other')
    } catch {
      /* 충돌로 실패 */
    }
    expect((await ok()).merging).toBe(true)
  })
  it('다른 브랜치면 기준 브랜치 후보 · main 과 다른 것은 커밋된 차이', async () => {
    git('checkout', '-qb', 'feat')
    write('x.txt', 'a\nFEAT\n')
    git('commit', '-qam', 'f')
    const r = await ok()
    expect(r.bases).toEqual(['main'])
    expect(r.files).toEqual([])
    const b = await loadReview(run, repo, 'main')
    expect(b.state === 'ok' && b.files.map((f) => f.path)).toEqual(['x.txt'])
  })
})

describe('줄 되돌리기 · 되살리기', () => {
  it('고른 줄만 되돌리고 기록을 남긴다 → 되살리면 원래대로', async () => {
    write('x.txt', 'a\nB1\nB2\nc\nd\nE\nf\ng\nh\n')
    const f = (await ok()).files[0]!
    const r = await revertLines(run, store, repo, 'x.txt', fileSig(f), [lineKey(0, 6), lineKey(0, 7)])
    expect(r).toMatchObject({ ok: true, what: '줄 2개' })
    expect(read('x.txt')).toBe('a\nB1\nB2\nc\nd\ne\nf\ng\nh\n')
    const list = store.list(repo, Date.now())
    expect(list.map((x) => [x.path, x.what])).toEqual([['x.txt', '줄 2개']])
    const back = await restoreReverted(run, store, list[0]!.id)
    expect(back).toBe('ok')
    expect(read('x.txt')).toBe('a\nB1\nB2\nc\nd\nE\nf\ng\nh\n')
    expect(store.list(repo, Date.now())).toEqual([])
  })
  it('본 뒤 파일이 바뀌었으면 되돌리지 않는다', async () => {
    write('x.txt', 'a\nB\nc\nd\ne\nf\ng\n')
    const sig = fileSig((await ok()).files[0]!)
    write('x.txt', 'a\nB\nc\nd\ne\nf\nG\n')
    expect(await revertLines(run, store, repo, 'x.txt', sig, [lineKey(0, 1)])).toMatchObject({ ok: false, reason: 'changed' })
    expect(read('x.txt')).toBe('a\nB\nc\nd\ne\nf\nG\n')
    expect(existsSync(join(base, 'reverted')) ? readdirSync(join(base, 'reverted')) : []).toEqual([])
  })
  it('그 뒤로 같은 줄이 또 바뀌면 되살리지 못한다', async () => {
    write('x.txt', 'a\nB\nc\nd\ne\nf\ng\n')
    const f = (await ok()).files[0]!
    const r = await revertLines(run, store, repo, 'x.txt', fileSig(f), [lineKey(0, 1), lineKey(0, 2)])
    if (!r.ok) throw new Error(r.reason)
    write('x.txt', 'a\nZZ\nc\nd\ne\nf\ng\n')
    expect(await restoreReverted(run, store, r.id)).toBe('changed')
    expect(read('x.txt')).toBe('a\nZZ\nc\nd\ne\nf\ng\n')
  })
  it('파일 전체 — 새 파일은 지우고 되살리면 다시 생긴다 · 지운 파일은 되살린다', async () => {
    write('n.txt', 'one\ntwo')
    rmSync(join(repo, 'keep.txt'))
    const files = (await ok()).files
    const n = files.find((f) => f.path === 'n.txt')!
    const k = files.find((f) => f.path === 'keep.txt')!
    const r1 = await revertFile(run, store, repo, 'n.txt', fileSig(n))
    expect(r1).toMatchObject({ ok: true, what: '새 파일' })
    expect(existsSync(join(repo, 'n.txt'))).toBe(false)
    expect(await revertFile(run, store, repo, 'keep.txt', fileSig(k))).toMatchObject({ ok: true, what: '파일 전체' })
    expect(read('keep.txt')).toBe('k\n')
    if (!r1.ok) return
    expect(await restoreReverted(run, store, r1.id)).toBe('ok')
    expect(read('n.txt')).toBe('one\ntwo')
  })
  it('저장소 밖 · 바뀌지 않은 경로는 거절', async () => {
    expect(await revertLines(run, store, repo, '../x.txt', 'zz', [lineKey(0, 0)])).toMatchObject({ ok: false, reason: 'changed' })
    expect(await revertFile(run, store, repo, 'keep.txt', 'zz')).toMatchObject({ ok: false, reason: 'changed' })
  })
})

describe('인덱스 · 시간 초과 · 링크 (23단계 리뷰)', () => {
  it('git add 한 파일은 인덱스도 함께 되돌리고 되살린다', async () => {
    write('x.txt', 'a\nB\nc\nd\ne\nf\ng\n')
    git('add', 'x.txt')
    const f = (await ok()).files[0]!
    const r = await revertLines(run, store, repo, 'x.txt', fileSig(f), [lineKey(0, 1), lineKey(0, 2)])
    if (!r.ok) throw new Error(r.reason)
    expect(read('x.txt')).toBe('a\nb\nc\nd\ne\nf\ng\n')
    expect(git('diff', '--cached', '--name-only')).toBe('') // 인덱스에 남아 다음 커밋에 들어가지 않는다
    expect(await restoreReverted(run, store, r.id)).toBe('ok')
    expect(git('diff', '--cached', '--name-only')).toBe('x.txt')
  })
  it('git add 한 새 파일 지우기 — 인덱스에서도 빠진다', async () => {
    write('n.txt', 'one\n')
    git('add', 'n.txt')
    const n = (await ok()).files.find((f) => f.path === 'n.txt')!
    expect(await revertFile(run, store, repo, 'n.txt', fileSig(n))).toMatchObject({ ok: true })
    expect(existsSync(join(repo, 'n.txt'))).toBe(false)
    expect(git('ls-files')).not.toContain('n.txt')
  })
  it('일부만 add 한 파일은 되돌리지 않는다 — 이유를 알린다', async () => {
    write('x.txt', 'a\nB\nc\nd\ne\nf\ng\n')
    git('add', 'x.txt')
    write('x.txt', 'a\nB\nc\nd\ne\nf\nG\n')
    const f = (await ok()).files[0]!
    const r = await revertLines(run, store, repo, 'x.txt', fileSig(f), [lineKey(0, 1), lineKey(0, 2)])
    expect(r).toMatchObject({ ok: false, reason: 'nothing' })
    expect(read('x.txt')).toBe('a\nB\nc\nd\ne\nf\nG\n')
  })
  it('적용이 시간 초과로 끝나도 실제로 됐으면 되살릴 수 있게 남긴다', async () => {
    write('x.txt', 'a\nB\nc\nd\ne\nf\ng\n')
    const slow: RunGit = async (args, o) => {
      const r = await run(args, o)
      return args[0] === 'apply' && args.includes('-R') && !args.includes('--check') ? { ...r, code: -1, timedOut: true } : r
    }
    const f = (await ok()).files[0]!
    const r = await revertLines(slow, store, repo, 'x.txt', fileSig(f), [lineKey(0, 1), lineKey(0, 2)])
    expect(r).toMatchObject({ ok: true })
    expect(store.list(repo, Date.now() + 120_000).length).toBe(1) // 1분 정리에 지워지지 않는다
  })
  it('새 파일 링크는 따라가지 않는다 — 폴더 링크에도 읽기가 깨지지 않고 저장소 밖 글을 보이지 않는다', async () => {
    mkdirSync(join(base, 'outside'))
    writeFileSync(join(base, 'outside', 'secret'), 'SECRET\n')
    symlinkSync(join(base, 'outside'), join(repo, 'dirlink'))
    symlinkSync(join(base, 'outside', 'secret'), join(repo, 'filelink'))
    const files = (await ok()).files
    for (const p of ['dirlink', 'filelink']) expect(files.find((f) => f.path === p)).toMatchObject({ binary: true, hunks: [] })
  })
  it('커밋 — 본 뒤 내용이 바뀐 파일은 커밋하지 않는다', async () => {
    write('x.txt', 'X\n')
    const sig = fileSig((await ok()).files[0]!)
    write('x.txt', 'X2\n')
    expect(await commitFiles(run, repo, ['x.txt'], 'm', [sig])).toMatchObject({ ok: false, reason: 'changed' })
    expect(git('log', '-1', '--format=%s')).toBe('init')
  })
  it('편집기로 열기 — 저장소 뿌리 · 보통 파일일 때만', async () => {
    expect(await openTarget(run, repo, 'x.txt')).toBe(join(repo, 'x.txt'))
    expect(await openTarget(run, base, 'repo/x.txt')).toBe(null) // 저장소 아님
    mkdirSync(join(repo, 'sub'))
    writeFileSync(join(repo, 'sub', 'y'), 'y')
    expect(await openTarget(run, join(repo, 'sub'), 'y')).toBe(null) // 뿌리 아님
    symlinkSync('/etc/hosts', join(repo, 'l'))
    expect(await openTarget(run, repo, 'l')).toBe(null)
  })
  it('갈래(linked worktree)의 git add 도 듣는다', async () => {
    const wt = join(base, 'wt')
    git('worktree', 'add', '-q', '-b', 'b1', wt)
    const w = new ReviewWatch()
    let n = 0
    w.set('k', wt, () => n++)
    const g = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: wt, encoding: 'utf8' }).trim()
    w.addGitDir('k', wt, g)
    await new Promise((r) => setTimeout(r, 300))
    n = 0
    execFileSync('git', ['update-index', '--refresh'], { cwd: wt })
    writeFileSync(join(g, 'index.touch'), '') // 다른 이름은 무시
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'e'], { cwd: wt })
    await expect.poll(() => n, { timeout: 3000 }).toBeGreaterThan(0)
    w.stop('k')
  })
})

describe('safeRel — 편집기로 열기는 이것만 보고 연다', () => {
  it('저장소 안 상대 경로만', () => {
    for (const ok of ['x.txt', 'src/a b/한글.ts', '.env']) expect(safeRel(ok)).toBe(true)
    for (const bad of ['', '..', '../x', 'a/../../x', '/etc/passwd', 'a/./b', 'a//b', 'x\0y']) expect(safeRel(bad)).toBe(false)
  })
})

describe('RevertStore', () => {
  it('0600 · 7일 지나면 목록에서 빠지고 지운다 · 적용 안 된 기록은 1분 뒤 정리', () => {
    const now = Date.now()
    const a = store.save({ root: repo, path: 'x.txt', what: '줄 1개', patch: 'p' }, now - 8 * 86_400_000)
    store.markApplied(a)
    const b = store.save({ root: repo, path: 'y.txt', what: '줄 1개', patch: 'p' }, now - 1000)
    store.markApplied(b)
    store.save({ root: repo, path: 'z.txt', what: '줄 1개', patch: 'p' }, now - 120_000)
    store.save({ root: '/other', path: 'w.txt', what: '줄 1개', patch: 'p' }, now - 10)
    const dir = join(base, 'reverted')
    for (const f of readdirSync(dir)) expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(store.list(repo, now).map((r) => r.path)).toEqual(['y.txt'])
    expect(readdirSync(dir).length).toBe(2) // y · /other 의 w(진행 중일 수 있어 남김)
  })
  it('기록 파일이 깨져 있으면 건너뛴다', () => {
    const id = store.save({ root: repo, path: 'x.txt', what: '줄 1개', patch: 'p' }, Date.now())
    store.markApplied(id)
    writeFileSync(join(base, 'reverted', 'bad.json'), '{')
    expect(store.list(repo, Date.now()).length).toBe(1)
  })
})

describe('커밋', () => {
  it('체크한 파일만 커밋 — 다른 파일 · 다른 스테이징은 남는다', async () => {
    write('x.txt', 'X\n')
    write('keep.txt', 'K\n')
    write('new.txt', 'N\n')
    git('add', 'keep.txt')
    const r = await commitNow(['x.txt', 'new.txt'], '고침: 둘만\n\n본문')
    expect(r).toMatchObject({ ok: true, subject: '고침: 둘만' })
    expect(git('show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual(['new.txt', 'x.txt'])
    expect(git('diff', '--cached', '--name-only')).toBe('keep.txt')
    expect(git('log', '-1', '--format=%B')).toBe('고침: 둘만\n\n본문')
  })
  it('지운 파일도 커밋', async () => {
    rmSync(join(repo, 'keep.txt'))
    expect(await commitNow(['keep.txt'], 'rm')).toMatchObject({ ok: true })
    expect(git('ls-files')).toBe('x.txt')
  })
  it('커밋 전 검사가 실패하면 마지막 20줄 · 아무것도 바꾸지 않음(새 파일도 인덱스에서 뺌)', async () => {
    const hook = join(repo, '.git', 'hooks', 'pre-commit')
    writeFileSync(hook, '#!/bin/sh\nfor i in $(seq 1 30); do echo "line $i"; done\necho "src/a.ts:44:5 error" >&2\nexit 1\n')
    chmodSync(hook, 0o755)
    write('new.txt', 'N\n')
    const before = git('rev-parse', 'HEAD')
    const r = await commitNow(['new.txt'], 'm')
    expect(r).toMatchObject({ ok: false, reason: 'hook' })
    if (r.ok) return
    const lines = r.tail.split('\n')
    expect(lines.length).toBe(20)
    expect(lines.at(-1)).toBe('src/a.ts:44:5 error')
    expect(git('rev-parse', 'HEAD')).toBe(before)
    expect(git('status', '--porcelain')).toBe('?? new.txt')
  })
  it('바뀐 목록에 없는 경로 · 빈 메시지는 거절', async () => {
    expect(await commitNow(['keep.txt'], 'm')).toMatchObject({ ok: false, reason: 'changed' })
    write('x.txt', 'X\n')
    expect(await commitNow(['x.txt'], '  ')).toMatchObject({ ok: false, reason: 'empty' })
    expect(await commitNow(['*'], 'm')).toMatchObject({ ok: false, reason: 'changed' })
  })
  it('커밋 취소 — HEAD 가 그 커밋일 때만 · 원격에 있으면 거절', async () => {
    write('x.txt', 'X\n')
    const r = await commitNow(['x.txt'], 'm')
    if (!r.ok) throw new Error(r.reason)
    expect(await undoCommit(run, repo, 'deadbeef')).toBe('moved')
    git('update-ref', 'refs/remotes/origin/main', r.hash)
    expect(await undoCommit(run, repo, r.hash)).toBe('remote')
    git('update-ref', '-d', 'refs/remotes/origin/main')
    expect(await undoCommit(run, repo, r.hash)).toBe('ok')
    expect(git('log', '-1', '--format=%s')).toBe('init')
    expect(git('diff', '--cached', '--name-only')).toBe('x.txt')
  })
})

describe('watchIgnored', () => {
  it('node_modules · .git 안은 버리고 .git/index · HEAD 는 받는다', () => {
    expect(watchIgnored('node_modules/a/b.js')).toBe(true)
    expect(watchIgnored('pkg/node_modules/x')).toBe(true)
    expect(watchIgnored('.git/objects/ab/cd')).toBe(true)
    expect(watchIgnored('.git/index.lock')).toBe(true)
    expect(watchIgnored('.git/index')).toBe(false)
    expect(watchIgnored('.git/HEAD')).toBe(false)
    expect(watchIgnored('src/a.ts')).toBe(false)
  })
})
