// 23단계 변경 검토 — git CLI 를 부르는 쪽(main). 화면은 결과만 받는다.
// git 라이브러리를 쓰지 않고 사용자 git 을 그대로 부른다 — 훅 · 서명 · 설정이 터미널에서와 같이 돈다(보드 '정할 것').
import { execFile } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join, normalize, sep } from 'node:path'
import { buildPatch, FOLD_BYTES, fileSig, liveReverted, parseDiff, parseStatus, untrackedDiff, watchIgnored, wholePatch, type CommitResult, type DiffFile, type ReviewLoad, type RevertResult, type UndoResult } from '../shared/review'
export type { CommitResult, ReviewLoad, ReviewOk, RevertResult } from '../shared/review'
import { isObj } from '../shared/guards'

export interface GitOut {
  code: number
  stdout: string
  stderr: string
  /** 시간 제한으로 죽였다 — 결과를 모른다 */
  timedOut: boolean
  /** git 을 실행하지 못했다(ENOENT · 명령줄 도구 없음) */
  missing: boolean
}
export type RunGit = (args: readonly string[], opts: { cwd: string; input?: string; timeout?: number }) => Promise<GitOut>

const READ_MS = 15_000
const COMMIT_MS = 120_000

/** 사용자 git 을 부른다 — 영어 메시지 · 터미널 질문 안 함 · 인덱스를 고쳐 쓰는 선택적 잠금 안 함 · 글롭 아닌 경로 */
export function makeRunGit(bin = 'git'): RunGit {
  return (args, opts) =>
    new Promise((resolve) => {
      const child = execFile(
        bin,
        ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args],
        {
          cwd: opts.cwd,
          env: { ...process.env, LC_ALL: 'C', LANG: 'C', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1', GIT_PAGER: 'cat' },
          timeout: opts.timeout ?? READ_MS,
          maxBuffer: 256 * 1024 * 1024,
          encoding: 'utf8',
        },
        (err, stdout, stderr) => {
          const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null
          const missing = e?.code === 'ENOENT' || /xcrun: error|invalid active developer path/.test(String(stderr))
          resolve({
            code: e ? (typeof e.code === 'number' ? e.code : -1) : 0,
            stdout: String(stdout),
            stderr: String(stderr),
            // maxBuffer 를 넘겨 죽인 것도 killed — 그건 '결과 모름' 이 아니라 실패다(리뷰)
            timedOut: !!e?.killed && e.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
            missing,
          })
        },
      )
      if (opts.input !== undefined) child.stdin?.end(opts.input)
      else child.stdin?.end()
      child.stdin?.on('error', () => {}) // git 이 먼저 끝나 EPIPE — 결과는 종료 코드로 본다
    })
}

// ─── 읽기 ─────────────────────────────────────────────────────────


const UNTRACKED_MAX = 2000

/** 새 파일의 글 — FOLD_BYTES 넘으면 읽지 않고 big, NUL 이 있으면 이진 */
function readUntracked(root: string, path: string): DiffFile {
  const full = join(root, path)
  let buf: Buffer
  try {
    // 링크는 따라가지 않는다 — 폴더를 가리키면 EISDIR, 저장소 밖 파일(~/.ssh …)을 가리키면 그 글을 보여 준다(리뷰)
    const st = lstatSync(full)
    if (st.isSymbolicLink() || !st.isFile()) return { ...untrackedDiff(path, ''), binary: true }
    if (st.size > FOLD_BYTES) return { ...untrackedDiff(path, ''), big: true }
    buf = readFileSync(full)
  } catch {
    return { ...untrackedDiff(path, ''), big: true } // status 와 읽기 사이에 지워짐 — 그 파일만 접고 나머지는 보인다
  }
  if (buf.subarray(0, 8000).includes(0)) return { ...untrackedDiff(path, ''), binary: true }
  return untrackedDiff(path, buf.toString('utf8'))
}

async function emptyTree(run: RunGit, root: string): Promise<string> {
  const r = await run(['hash-object', '-t', 'tree', '--stdin'], { cwd: root, input: '' })
  return r.stdout.trim() || '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
}

const DIFF_ARGS = ['diff', '--no-color', '--no-ext-diff', '--no-renames', '--no-textconv', '-U3']

/** 바뀐 것 전부 — 작업 폴더 vs HEAD(새 파일 포함), base 가 있으면 `<base>...HEAD`(보기만) */
export async function loadReview(run: RunGit, dir: string, base?: string | null): Promise<ReviewLoad> {
  const top = await run(['rev-parse', '--show-toplevel', '--absolute-git-dir'], { cwd: dir })
  if (top.missing) return { state: 'no-git' }
  if (top.code !== 0) return /not a git repository/i.test(top.stderr) || top.code === 128 ? { state: 'not-repo' } : { state: 'error', message: top.stderr.trim() }
  const [root, gitDir] = top.stdout.trim().split('\n') as [string, string]
  const [st, sign, log] = await Promise.all([
    run(['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'], { cwd: root }),
    run(['config', '--get', '--type=bool', 'commit.gpgsign'], { cwd: root }),
    run(['log', '-1', '--format=%H%x00%s%x00%ct'], { cwd: root }),
  ])
  if (st.code !== 0) return { state: 'error', message: (st.stderr || st.stdout).trim() }
  const status = parseStatus(st.stdout)
  const bases: string[] = []
  if (status.branch && status.branch !== 'main' && status.branch !== 'master') {
    for (const b of ['main', 'master']) {
      const v = await run(['rev-parse', '--verify', '--quiet', `refs/heads/${b}`], { cwd: root })
      if (v.code === 0) bases.push(b)
    }
  }
  const useBase = base && bases.includes(base) ? base : null
  const against = useBase ? [`${useBase}...HEAD`] : [status.oid ? 'HEAD' : await emptyTree(run, root)]
  const diff = await run([...DIFF_ARGS, ...against], { cwd: root })
  if (diff.code !== 0) return { state: 'error', message: diff.stderr.trim() }
  const files = parseDiff(diff.stdout)
  if (!useBase) for (const p of status.untracked.slice(0, UNTRACKED_MAX)) files.push(readUntracked(root, p))
  const [hash, subject, at] = log.code === 0 ? log.stdout.trim().split('\0') : []
  return {
    state: 'ok',
    root,
    branch: status.branch,
    head: hash ? { hash, subject: subject ?? '', at: Number(at) * 1000 } : null,
    files,
    staged: status.staged,
    merging: status.conflicted.length > 0 || existsSync(join(gitDir, 'MERGE_HEAD')),
    worktree: isFileSafe(join(root, '.git')),
    gpgsign: sign.stdout.trim() === 'true',
    bases,
    base: useBase,
  }
}

function isFileSafe(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/** 지금 그 파일 하나의 diff — 고른 뒤 실행할 때 그 사이 바뀌었는지 보려고 다시 읽는다 */
async function freshFile(run: RunGit, dir: string, path: string): Promise<{ root: string; file: DiffFile; staged: boolean } | null> {
  if (!safeRel(path)) return null
  const r = await loadReview(run, dir)
  if (r.state !== 'ok') return null
  const file = r.files.find((f) => f.path === path)
  return file ? { root: r.root, file, staged: r.staged.includes(path) } : null
}

/** 저장소 안 상대 경로만 — 절대 경로 · .. · 빈 글 거절 */
export function safeRel(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0 || path.length > 4096 || isAbsolute(path) || path.includes('\0')) return false
  const canonical = (value: string) => sep === '\\' ? value.replace(/\\/g, '/') : value
  const n = canonical(normalize(path))
  return n !== '..' && !n.startsWith('../') && n === canonical(path).replace(/\/+$/, '')
}

// ─── 되돌리기 · 되살리기 ────────────────────────────────────────────

export interface RevertRecord {
  v: 1
  id: string
  at: number
  root: string
  path: string
  /** '줄 2개' · '파일 전체' · '새 파일' */
  what: string
  patch: string
  /** 작업 폴더에 적용했다 — 적용 전에 기록하고 적용 뒤 켠다(그 사이 앱이 끝나면 꺼진 채 남아 정리된다) */
  applied: boolean
  /** 인덱스에 올라간 파일이라 `--index` 로 인덱스도 함께 되돌렸다 — 되살릴 때도 같이 */
  index?: true
}

/** `<userData>/reverted/` — 7일 보관. 원문 패치라 0600 · 폴더 0700 (되살리려면 원문이 필요하다) */
export class RevertStore {
  constructor(private readonly dir: string) {}

  private ensure(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    chmodSync(this.dir, 0o700)
  }
  private file(id: string): string {
    return join(this.dir, `${id}.json`)
  }
  private write(rec: RevertRecord): void {
    this.ensure()
    const tmp = `${this.file(rec.id)}.tmp`
    writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 })
    renameSync(tmp, this.file(rec.id))
  }
  save(p: { root: string; path: string; what: string; patch: string; index?: true }, now = Date.now()): string {
    const id = `${now}-${randomUUID().slice(0, 8)}`
    this.write({ v: 1, id, at: now, applied: false, ...p })
    return id
  }
  get(id: string): RevertRecord | null {
    if (!/^\d+-[0-9a-f]{8}$/.test(id)) return null
    try {
      const v: unknown = JSON.parse(readFileSync(this.file(id), 'utf8'))
      return isRecord(v) ? v : null
    } catch {
      return null
    }
  }
  markApplied(id: string): void {
    const r = this.get(id)
    if (r) this.write({ ...r, applied: true })
  }
  remove(id: string): void {
    try {
      unlinkSync(this.file(id))
    } catch {
      /* 이미 없음 */
    }
  }
  /** 그 저장소의 살아 있는 기록 — 7일 지난 것 · 적용 못 한 채 1분 넘은 것은 지운다 */
  list(root: string, now = Date.now()): RevertRecord[] {
    let names: string[] = []
    try {
      names = readdirSync(this.dir).filter((n) => n.endsWith('.json'))
    } catch {
      return []
    }
    const all: RevertRecord[] = []
    for (const n of names) {
      const r = this.get(n.slice(0, -5))
      if (!r) continue
      const stale = (!r.applied && now - r.at > 60_000) || now - r.at >= REVERT_KEEP
      if (stale) this.remove(r.id)
      else all.push(r)
    }
    return liveReverted(all.filter((r) => r.root === root), now)
  }
  /** 설정 › 개인정보 '되돌린 것 비우기' */
  clear(): void {
    let names: string[] = []
    try {
      names = readdirSync(this.dir)
    } catch {
      return
    }
    for (const n of names) {
      if (!n.endsWith('.json') && !n.endsWith('.tmp')) continue
      try {
        unlinkSync(join(this.dir, n))
      } catch {
        /* 이미 없음 */
      }
    }
  }
}
const REVERT_KEEP = 7 * 86_400_000

function isRecord(v: unknown): v is RevertRecord {
  return (
    isObj(v) &&
    v['v'] === 1 &&
    typeof v['id'] === 'string' &&
    typeof v['at'] === 'number' &&
    typeof v['root'] === 'string' &&
    typeof v['path'] === 'string' &&
    typeof v['what'] === 'string' &&
    typeof v['patch'] === 'string' &&
    typeof v['applied'] === 'boolean'
  )
}


/**
 * 기록 → 적용. 인덱스에 올라간 파일(`git add` 한 것)은 `--index` 로 인덱스도 함께 — 작업 폴더만 되돌리면
 * diff HEAD 에서는 사라져도 인덱스에 남아 다음 커밋에 들어간다(리뷰). 일부만 add 한 파일은 `--index` 가 거절한다.
 */
async function applyRecorded(run: RunGit, store: RevertStore, root: string, path: string, what: string, patch: string, staged: boolean): Promise<RevertResult> {
  const idx = staged ? ['--index'] : []
  const check = await run(['apply', '-R', ...idx, '--check', '--whitespace=nowarn', '-'], { cwd: root, input: patch })
  if (check.code !== 0) {
    if (check.timedOut) return { ok: false, reason: 'unknown', message: check.stderr.trim() }
    if (staged) return { ok: false, reason: 'nothing', message: '일부만 git add 한 파일이에요 — 터미널에서 인덱스를 정리한 뒤 되돌려 주세요' }
    return { ok: false, reason: 'changed', message: check.stderr.trim() }
  }
  // 적용 전에 기록 — 적용 뒤 앱이 바로 끝나도 되살릴 길이 남는다
  const id = store.save({ root, path, what, patch, ...(staged ? { index: true as const } : {}) })
  const r = await run(['apply', '-R', ...idx, '--whitespace=nowarn', '-'], { cwd: root, input: patch })
  if (r.code !== 0) {
    if (!r.timedOut) {
      store.remove(id)
      return { ok: false, reason: 'failed', message: r.stderr.trim() }
    }
    // 시간 초과 — 실제로 적용됐는지 정방향 검사로 가린다. 됐으면 되살릴 수 있게 '적용됨' 으로 남긴다(1분 뒤 지워지지 않게, 리뷰)
    const done = await run(['apply', ...idx, '--check', '--whitespace=nowarn', '-'], { cwd: root, input: patch })
    if (done.code === 0) {
      store.markApplied(id)
      return { ok: true, id, what }
    }
    const notYet = await run(['apply', '-R', ...idx, '--check', '--whitespace=nowarn', '-'], { cwd: root, input: patch })
    if (notYet.code === 0) store.remove(id)
    return { ok: false, reason: 'unknown', message: r.stderr.trim() }
  }
  store.markApplied(id)
  return { ok: true, id, what }
}

/** 고른 줄만 되돌린다 — 본 diff(sig)와 지금 diff 가 다르면 하지 않는다. 패치는 여기서 만든다(renderer 의 글을 믿지 않음) */
export async function revertLines(run: RunGit, store: RevertStore, dir: string, path: string, sig: string, keys: readonly string[]): Promise<RevertResult> {
  const fresh = await freshFile(run, dir, path)
  if (!fresh || fileSig(fresh.file) !== sig) return { ok: false, reason: 'changed' }
  if (fresh.file.kind === 'D' || fresh.file.binary || fresh.file.big) return { ok: false, reason: 'nothing' }
  const sel = new Set(keys)
  const patch = buildPatch(fresh.file, sel)
  if (!patch) return { ok: false, reason: 'nothing' }
  const n = fresh.file.hunks.reduce((s, h, hi) => s + h.lines.filter((l, li) => l.t !== ' ' && sel.has(`${hi}:${li}`)).length, 0)
  return applyRecorded(run, store, fresh.root, path, `줄 ${n}개`, patch, fresh.staged)
}

/** 파일 전체 — 새 파일은 지우고 · 지운 파일은 되살리고 · 고친 파일은 HEAD 로. 이진 · 큰 파일은 git 의 --binary 패치로 */
export async function revertFile(run: RunGit, store: RevertStore, dir: string, path: string, sig: string): Promise<RevertResult> {
  const fresh = await freshFile(run, dir, path)
  if (!fresh || fileSig(fresh.file) !== sig) return { ok: false, reason: 'changed' }
  const { root, file } = fresh
  const what = file.kind === 'A' ? '새 파일' : '파일 전체'
  let patch = wholePatch(file)
  if (file.big || file.binary) {
    if (file.untracked) return { ok: false, reason: 'nothing', message: '큰 · 이진 새 파일은 Finder 에서 지워 주세요' }
    const d = await run([...DIFF_ARGS, '--binary', 'HEAD', '--', path], { cwd: root })
    if (d.code !== 0) return { ok: false, reason: 'failed', message: d.stderr.trim() }
    patch = d.stdout
  }
  if (!patch) return { ok: false, reason: 'nothing' }
  return applyRecorded(run, store, root, path, what, patch, fresh.staged)
}

/** 되돌린 것 되살리기 — 그 뒤로 같은 줄이 또 바뀌었으면 'changed' */
export async function restoreReverted(run: RunGit, store: RevertStore, id: string): Promise<'ok' | 'changed' | 'gone' | 'unknown'> {
  const rec = store.get(id)
  if (!rec || !rec.applied || !existsSync(rec.root)) return 'gone'
  const idx = rec.index ? ['--index'] : []
  const check = await run(['apply', ...idx, '--check', '--whitespace=nowarn', '-'], { cwd: rec.root, input: rec.patch })
  if (check.code !== 0) return check.timedOut ? 'unknown' : 'changed'
  const r = await run(['apply', ...idx, '--whitespace=nowarn', '-'], { cwd: rec.root, input: rec.patch })
  if (r.code !== 0) return r.timedOut ? 'unknown' : 'changed'
  store.remove(id)
  return 'ok'
}

// ─── 커밋 ─────────────────────────────────────────────────────────

const tail20 = (s: string): string => s.replace(/\s+$/, '').split('\n').slice(-20).join('\n')

/**
 * 체크한 파일만 커밋 — `git commit --only -- <파일>` 은 다른 스테이징을 섞지 않는다.
 * git 이 모르는 새 파일만 먼저 add 하고, 실패하면 인덱스에서 다시 뺀다(검사 실패 = '아무것도 바꾸지 않았어요').
 */
export async function commitFiles(run: RunGit, dir: string, paths: readonly string[], message: string, sigs: readonly string[]): Promise<CommitResult> {
  if (!message.trim()) return { ok: false, reason: 'empty', tail: '' }
  const r = await loadReview(run, dir)
  if (r.state !== 'ok') return { ok: false, reason: 'changed', tail: '' }
  if (r.merging) return { ok: false, reason: 'merging', tail: '' }
  const known = new Map(r.files.map((f) => [f.path, f]))
  if (paths.length === 0 || paths.some((p) => !safeRel(p) || !known.has(p))) return { ok: false, reason: 'changed', tail: '' }
  // 본 diff 그대로일 때만 — 그 사이 에이전트가 고친 내용을 보지 않은 채 커밋하지 않는다(리뷰)
  if (sigs.length !== paths.length || paths.some((p, i) => fileSig(known.get(p)!) !== sigs[i])) return { ok: false, reason: 'changed', tail: '' }
  const fresh = paths.filter((p) => known.get(p)!.untracked)
  if (fresh.length) {
    const add = await run(['add', '--', ...fresh], { cwd: r.root })
    if (add.code !== 0) return { ok: false, reason: /index\.lock/.test(add.stderr) ? 'locked' : 'unknown', tail: tail20(add.stderr) }
  }
  const c = await run(['commit', '-F', '-', '--only', '--', ...paths], { cwd: r.root, input: message, timeout: COMMIT_MS })
  if (c.code === 0) {
    const h = await run(['log', '-1', '--format=%H%x00%s'], { cwd: r.root })
    const [hash = '', subject = ''] = h.stdout.trim().split('\0')
    return { ok: true, hash, subject }
  }
  if (fresh.length && !c.timedOut) await run(['reset', '-q', '--', ...fresh], { cwd: r.root })
  const out = `${c.stdout}\n${c.stderr}`
  const reason = c.timedOut ? 'unknown' : /index\.lock/.test(out) ? 'locked' : /failed to sign|gpg failed|signing failed/i.test(out) ? 'sign' : 'hook'
  return { ok: false, reason, tail: tail20(out.replace(/^\n+/, '')) }
}

/** '커밋 취소' — HEAD 가 그 커밋이고 · 어느 원격 브랜치에도 없고 · 부모가 있을 때만 `reset --soft HEAD~1` */
export async function undoCommit(run: RunGit, dir: string, hash: string): Promise<UndoResult> {
  if (!/^[0-9a-f]{7,64}$/.test(hash)) return 'moved'
  const head = await run(['rev-parse', 'HEAD'], { cwd: dir })
  if (head.code !== 0 || head.stdout.trim() !== hash) return 'moved'
  const remote = await run(['branch', '-r', '--contains', hash], { cwd: dir })
  if (remote.code !== 0) return 'failed'
  if (remote.stdout.trim()) return 'remote'
  const parent = await run(['rev-parse', '--verify', '--quiet', `${hash}^`], { cwd: dir })
  if (parent.code !== 0) return 'root'
  const r = await run(['reset', '--soft', 'HEAD~1'], { cwd: dir })
  return r.code === 0 ? 'ok' : 'failed'
}

/**
 * 편집기로 열 파일 — root 가 정말 git 저장소 뿌리이고, 그 안의 링크 아닌 보통 파일일 때만 전체 경로.
 * renderer 가 보낸 root 를 믿지 않는다(리뷰: root='~/.ssh' · path='id_rsa').
 */
export async function openTarget(run: RunGit, root: string, path: string): Promise<string | null> {
  if (!safeRel(path)) return null
  const top = await run(['rev-parse', '--show-toplevel'], { cwd: root })
  if (top.code !== 0 || top.stdout.trim() !== root) return null
  const full = join(root, path)
  try {
    return lstatSync(full).isFile() ? full : null
  } catch {
    return null
  }
}

// ─── 폴더 감시 ────────────────────────────────────────────────────

/** pane 마다 저장소 뿌리를 감시 — 보이는 동안만(renderer 가 켜고 끈다). 0.5초 모아서 한 번 */
export class ReviewWatch {
  private readonly items = new Map<string, { w: FSWatcher; g: FSWatcher | null; timer: NodeJS.Timeout | null; dir: string; onChange: () => void }>()

  private bump(key: string): void {
    const it = this.items.get(key)
    if (!it || it.timer) return
    it.timer = setTimeout(() => {
      it.timer = null
      it.onChange()
    }, 500)
  }

  set(key: string, dir: string | null, onChange: () => void): void {
    const cur = this.items.get(key)
    if (cur && cur.dir === dir) return
    this.stop(key)
    if (!dir) return
    let w: FSWatcher
    try {
      w = watch(dir, { recursive: true }, (_ev, name) => {
        const rel = String(name ?? '')
        if (rel && watchIgnored(rel)) return
        this.bump(key)
      })
    } catch {
      return
    }
    w.on('error', () => this.stop(key))
    this.items.set(key, { w, g: null, timer: null, dir, onChange })
  }
  /**
   * 갈래(linked worktree)는 `.git` 이 파일이라 index · HEAD 가 본 저장소의 `.git/worktrees/<이름>/` 에 있다 —
   * 뿌리만 보면 터미널의 `git add` · `commit` 을 못 듣는다(리뷰). 그 폴더를 얕게 함께 본다. 그 사이 감시가 바뀌었으면 하지 않는다.
   */
  addGitDir(key: string, dir: string, gitDir: string): void {
    const it = this.items.get(key)
    if (!it || it.dir !== dir || it.g || gitDir === join(dir, '.git')) return
    try {
      it.g = watch(gitDir, (_ev, name) => {
        const n = String(name ?? '')
        if (n === 'index' || n === 'HEAD') this.bump(key)
      })
      it.g.on('error', () => {
        it.g?.close()
        it.g = null
      })
    } catch {
      /* 못 보면 창 포커스 · 쓰기 뒤 다시 읽기로 */
    }
  }
  stop(key: string): void {
    const it = this.items.get(key)
    if (!it) return
    if (it.timer) clearTimeout(it.timer)
    it.w.close()
    it.g?.close()
    this.items.delete(key)
  }
  /** 키가 이 앞말로 시작하는 것 모두(창 하나의 pane 들) */
  stopPrefix(prefix: string): void {
    for (const k of [...this.items.keys()]) if (k.startsWith(prefix)) this.stop(k)
  }
  size(): number {
    return this.items.size
  }
}

