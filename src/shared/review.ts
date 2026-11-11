// 23단계 변경 검토 — git 출력 풀기 · 고른 줄만 되돌리는 패치 · 커밋 경고. 순수 함수(시험 대상).
// git 을 부르는 것은 main(review-git.ts). 패치는 main 이 여기 함수로 만든다 — renderer 가 보낸 패치 글을 그대로 쓰지 않는다.
import { findSecrets, secretHash } from './redact'

// ─── git status --porcelain=v2 -z --branch ──────────────────────────

export interface StatusInfo {
  /** 지금 커밋 — 첫 커밋 전이면 null */
  oid: string | null
  /** 브랜치 — 떨어진 HEAD 면 null */
  branch: string | null
  untracked: string[]
  /** 병합 충돌(u 줄) */
  conflicted: string[]
  /** 인덱스에 올라간 것(X 가 . 아님) — 기본 체크용 */
  staged: string[]
}

export function parseStatus(z: string): StatusInfo {
  const out: StatusInfo = { oid: null, branch: null, untracked: [], conflicted: [], staged: [] }
  const toks = z.split('\0')
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!
    if (!t) continue
    if (t.startsWith('# branch.oid ')) {
      const v = t.slice(13)
      out.oid = v === '(initial)' ? null : v
    } else if (t.startsWith('# branch.head ')) {
      const v = t.slice(14)
      out.branch = v === '(detached)' ? null : v
    } else if (t.startsWith('1 ')) {
      const f = t.split(' ')
      if (f[1]![0] !== '.') out.staged.push(f.slice(8).join(' '))
    } else if (t.startsWith('2 ')) {
      const f = t.split(' ')
      if (f[1]![0] !== '.') out.staged.push(f.slice(9).join(' '))
      i++ // -z 에서는 옛 경로가 다음 칸
    } else if (t.startsWith('u ')) {
      out.conflicted.push(t.split(' ').slice(10).join(' '))
    } else if (t.startsWith('? ')) {
      out.untracked.push(t.slice(2))
    }
  }
  return out
}

// ─── git diff ─────────────────────────────────────────────────────

export interface DiffLine {
  t: ' ' | '+' | '-'
  text: string
  oldNo?: number
  newNo?: number
  /** 이 줄 뒤에 '\ No newline at end of file' */
  noEol?: true
}
export interface Hunk {
  header: string
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: DiffLine[]
}
export type FileKind = 'M' | 'A' | 'D'
export interface DiffFile {
  path: string
  kind: FileKind
  binary: boolean
  /** `index a..b` — 이진 파일의 같음 비교 */
  index?: string
  /** 새 파일 · 지운 파일의 모드 (wholePatch 머리) */
  mode?: string
  /** git 이 모르는 새 파일(untracked) */
  untracked?: true
  /** 너무 커서 글을 읽지 않은 새 파일 (FOLD_BYTES 넘음) */
  big?: true
  add: number
  del: number
  hunks: Hunk[]
}

/** git 이 따옴표로 감싼 경로(`"a/\355\225\234.txt"`)를 푼다 — 따옴표가 없으면 그대로 */
export function unquotePath(s: string): string {
  if (!(s.length >= 2 && s.startsWith('"') && s.endsWith('"'))) return s
  const body = s.slice(1, -1)
  const bytes: number[] = []
  const ESC: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '\\': 92, '"': 34 }
  const enc = new TextEncoder()
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!
    if (c !== '\\') {
      bytes.push(...enc.encode(c))
      continue
    }
    const n = body[i + 1] ?? ''
    if (/[0-7]/.test(n)) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8))
      i += 3
    } else {
      bytes.push(ESC[n] ?? n.charCodeAt(0))
      i += 1
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

const stripSide = (p: string): string => p.replace(/^[ab]\//, '')

/** `diff --git a/X b/X` 의 경로 — --no-renames 라 두 쪽이 같다 */
function headerPath(rest: string): string {
  if (rest.startsWith('"')) {
    let j = 1
    while (j < rest.length && !(rest[j] === '"' && rest[j - 1] !== '\\')) j++
    return stripSide(unquotePath(rest.slice(0, j + 1)))
  }
  const half = (rest.length - 5) / 2
  return Number.isInteger(half) && half > 0 ? rest.slice(2, 2 + half) : stripSide(rest.split(' ')[0] ?? rest)
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = []
  let f: DiffFile | null = null
  let h: Hunk | null = null
  let oldNo = 0
  let newNo = 0
  for (const raw of text.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      f = { path: headerPath(raw.slice(11)), kind: 'M', binary: false, add: 0, del: 0, hunks: [] }
      files.push(f)
      h = null
      continue
    }
    if (!f) continue
    if (!h) {
      if (raw.startsWith('new file mode ')) (f.kind = 'A'), (f.mode = raw.slice(14))
      else if (raw.startsWith('deleted file mode ')) (f.kind = 'D'), (f.mode = raw.slice(18))
      else if (raw.startsWith('index ')) f.index = raw.slice(6)
      else if (raw.startsWith('Binary files ')) f.binary = true
      else if (raw.startsWith('+++ ') && raw.slice(4) !== '/dev/null') f.path = stripSide(unquotePath(raw.slice(4)))
      else if (raw.startsWith('--- ') && raw.slice(4) !== '/dev/null' && f.kind === 'D') f.path = stripSide(unquotePath(raw.slice(4)))
    }
    const m = HUNK.exec(raw)
    if (m) {
      h = { header: raw, oldStart: +m[1]!, oldCount: m[2] === undefined ? 1 : +m[2], newStart: +m[3]!, newCount: m[4] === undefined ? 1 : +m[4], lines: [] }
      f.hunks.push(h)
      oldNo = h.oldStart
      newNo = h.newStart
      continue
    }
    if (!h) continue
    const c = raw[0]
    if (c === ' ') h.lines.push({ t: ' ', text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ })
    else if (c === '-') h.lines.push({ t: '-', text: raw.slice(1), oldNo: oldNo++ }), f.del++
    else if (c === '+') h.lines.push({ t: '+', text: raw.slice(1), newNo: newNo++ }), f.add++
    else if (c === '\\') {
      const last = h.lines.at(-1)
      if (last) last.noEol = true
    }
  }
  return files
}

/** git 이 모르는 새 파일 — 글 전체를 + 줄로 */
export function untrackedDiff(path: string, text: string): DiffFile {
  const f: DiffFile = { path, kind: 'A', binary: false, untracked: true, mode: '100644', add: 0, del: 0, hunks: [] }
  if (text === '') return f
  const parts = text.split('\n')
  const eol = text.endsWith('\n')
  if (eol) parts.pop()
  const lines: DiffLine[] = parts.map((t, i) => ({ t: '+', text: t, newNo: i + 1 }))
  if (!eol) lines[lines.length - 1]!.noEol = true
  f.add = lines.length
  f.hunks.push({ header: `@@ -0,0 +1,${lines.length} @@`, oldStart: 0, oldCount: 0, newStart: 1, newCount: lines.length, lines })
  return f
}

// ─── 패치 만들기 ────────────────────────────────────────────────────

const NO_EOL = '\\ No newline at end of file'
/** 줄의 자리 — `덩어리:줄` */
export const lineKey = (hunk: number, line: number): string => `${hunk}:${line}`

function hunkText(lines: DiffLine[], oldStart: number, newStart: number): string {
  const oldCount = lines.filter((l) => l.t !== '+').length
  const newCount = lines.filter((l) => l.t !== '-').length
  const os = oldCount > 0 && oldStart === 0 ? 1 : oldStart
  const ns = newCount > 0 && newStart === 0 ? 1 : newStart
  let out = `@@ -${os},${oldCount} +${ns},${newCount} @@\n`
  lines.forEach((l, i) => {
    out += `${l.t}${l.text}\n`
    if (!l.noEol) return
    // 끝 줄바꿈 없음 표시는 그 줄이 자기 쪽의 마지막일 때만 — 뒤에 같은 쪽 줄이 남으면 그 줄은 이제 줄바꿈이 있다
    const later = lines.slice(i + 1)
    const last = l.t === ' ' ? later.length === 0 : !later.some((x) => x.t === ' ' || x.t === l.t)
    if (last) out += `${NO_EOL}\n`
  })
  return out
}

/**
 * 고른 +/- 줄만 되돌리는 패치 — 작업 폴더에 `git apply -R` 로 쓴다(23단계 스파이크).
 * 고르지 않은 + 줄은 작업 폴더에 남아야 하므로 문맥으로, 고르지 않은 - 줄은 이미 없으므로 뺀다. 고른 줄이 없는 덩어리는 넣지 않는다.
 */
export function buildPatch(file: DiffFile, selected: ReadonlySet<string>): string | null {
  if (file.binary) return null
  let body = ''
  file.hunks.forEach((h, hi) => {
    const picked = h.lines.some((l, li) => l.t !== ' ' && selected.has(lineKey(hi, li)))
    if (!picked) return
    const lines: DiffLine[] = []
    h.lines.forEach((l, li) => {
      if (l.t === ' ' || selected.has(lineKey(hi, li))) lines.push(l)
      else if (l.t === '+') lines.push({ ...l, t: ' ' })
    })
    body += hunkText(lines, h.oldStart, h.newStart)
  })
  if (!body) return null
  return `diff --git a/${file.path} b/${file.path}\n--- a/${file.path}\n+++ b/${file.path}\n${body}`
}

/** 파일 전체를 되돌리는 패치 — 새 파일이면 지우고, 지운 파일이면 되살린다. 이진은 null(main 이 `git diff --binary` 로) */
export function wholePatch(file: DiffFile): string | null {
  if (file.binary) return null
  const mode = file.mode ?? '100644'
  let head = `diff --git a/${file.path} b/${file.path}\n`
  if (file.kind === 'A') head += `new file mode ${mode}\n--- /dev/null\n+++ b/${file.path}\n`
  else if (file.kind === 'D') head += `deleted file mode ${mode}\n--- a/${file.path}\n+++ /dev/null\n`
  else head += `--- a/${file.path}\n+++ b/${file.path}\n`
  return head + file.hunks.map((h) => hunkText(h.lines, h.oldStart, h.newStart)).join('')
}

// ─── 화면 도움 ─────────────────────────────────────────────────────

export const FOLD_LINES = 5000
export const FOLD_BYTES = 1024 * 1024

export function foldReason(file: DiffFile): 'binary' | 'big' | null {
  if (file.binary) return 'binary'
  if (file.big) return 'big'
  let n = 0
  let bytes = 0
  for (const h of file.hunks)
    for (const l of h.lines) {
      n++
      bytes += l.text.length
    }
  return n > FOLD_LINES || bytes > FOLD_BYTES ? 'big' : null
}

/** 파일 diff 의 표지 — 같으면 '봤음' 을 유지, 바뀌면 풀린다. 고른 뒤 실행할 때 그 사이 바뀌었는지도 이것으로 본다 */
export function fileSig(file: DiffFile): string {
  const parts = [file.path, file.kind, file.index ?? '', file.binary ? 'b' : '']
  for (const h of file.hunks) {
    parts.push(h.header)
    for (const l of h.lines) parts.push(l.t + l.text + (l.noEol ? '\\' : ''))
  }
  return secretHash(parts.join('\n'))
}

/** 경로에 글자들이 차례로 들어 있으면 (대소문자 무시) */
export function filterFiles(files: readonly DiffFile[], query: string): DiffFile[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...files]
  return files.filter((f) => {
    const p = f.path.toLowerCase()
    let i = 0
    for (const c of p) if (c === q[i]) i++
    return i >= q.length
  })
}

export const MANY_FILES = 100

export interface FolderGroup {
  /** `src/` · 맨 위 파일들은 '' */
  name: string
  files: DiffFile[]
  add: number
  del: number
}
/** 폴더 보기 — 맨 위 폴더로 묶는다(폴더들 먼저, 맨 위 파일은 끝) */
export function folderGroups(files: readonly DiffFile[]): FolderGroup[] {
  const map = new Map<string, FolderGroup>()
  for (const f of files) {
    const at = f.path.indexOf('/')
    const name = at < 0 ? '' : f.path.slice(0, at + 1)
    const g = map.get(name) ?? { name, files: [], add: 0, del: 0 }
    g.files.push(f)
    g.add += f.add
    g.del += f.del
    map.set(name, g)
  }
  return [...map.values()].sort((a, b) => (a.name === '' ? 1 : b.name === '' ? -1 : a.name.localeCompare(b.name)))
}

export type CommitWarning = { kind: 'main'; text: string } | { kind: 'secret'; text: string; path: string; line: number }

/** 막을 때만 경고 — 갈래 없이 main/master 에 바로 · 더해진 줄의 비밀값 (보드 '정할 것') */
export function commitWarnings(p: { branch: string | null; worktree: boolean; files: readonly DiffFile[] }): CommitWarning[] {
  const out: CommitWarning[] = []
  if (!p.worktree && (p.branch === 'main' || p.branch === 'master')) {
    out.push({ kind: 'main', text: `⎇ ${p.branch} 에 바로 커밋해요 — 따로 갈래를 만들지 않은 일감이에요` })
  }
  let count = 0
  let first: { path: string; line: number } | null = null
  for (const f of p.files)
    for (const h of f.hunks)
      for (const l of h.lines) {
        if (l.t !== '+' || findSecrets(l.text).length === 0) continue
        count++
        first ??= { path: f.path, line: l.newNo ?? 0 }
      }
  if (first) out.push({ kind: 'secret', text: `비밀값으로 보이는 줄이 ${count}개 있어요 · ${first.path} ${first.line}번째 줄`, ...first })
  return out
}

/**
 * 대화 도구 줄의 경로(대화 폴더 기준) → 변경 pane 의 경로(저장소 뿌리 기준). 일감 폴더가 저장소 하위 폴더면
 * 앞에 그 하위 폴더를 붙인다(리뷰: packages/app 에서 고친 src/x.ts). 목록에 없으면 null.
 */
export function resolveReviewPath(files: readonly { path: string }[], root: string, dir: string, path: string): string | null {
  const has = (p: string) => files.some((f) => f.path === p)
  const r = root.replace(/\/+$/, '')
  const d = dir.replace(/\/+$/, '')
  if (d.startsWith(`${r}/`)) {
    const sub = `${d.slice(r.length + 1)}/${path}`
    if (has(sub)) return sub
  }
  return has(path) ? path : null
}

export const REVERT_KEEP_MS = 7 * 86_400_000

/** 되돌린 것 목록 — 7일 안 · 적용된 것만, 새것부터 */
export function liveReverted<T extends { at: number; applied: boolean }>(rs: readonly T[], now: number): T[] {
  return rs.filter((r) => r.applied && now - r.at < REVERT_KEEP_MS).sort((a, b) => b.at - a.at)
}

/** 폴더 감시에서 버릴 경로(감시 뿌리 기준) — node_modules · .git 안. 단 .git/index · .git/HEAD 는 터미널의 git 이 바꾼 것이라 받는다 */
export function watchIgnored(rel: string): boolean {
  if (rel === '.git/index' || rel === '.git/HEAD') return false
  return rel === '.git' || rel.startsWith('.git/') || /(^|\/)node_modules(\/|$)/.test(rel)
}

// ─── main ↔ renderer 결과 모양 ───────────────────────────────────

export interface ReviewOk {
  state: 'ok'
  root: string
  branch: string | null
  head: { hash: string; subject: string; at: number } | null
  files: DiffFile[]
  /** 이미 git add 한 경로 */
  staged: string[]
  merging: boolean
  /** 갈래(worktree) 폴더 — .git 이 파일 */
  worktree: boolean
  /** commit.gpgsign — 커밋이 오래 걸리면 '서명 기다림' 으로 보인다 */
  gpgsign: boolean
  /** '<기준> 과 다른 것' 탭 후보 (지금 브랜치가 main/master 가 아닐 때) */
  bases: string[]
  base: string | null
}
export type ReviewLoad = ReviewOk | { state: 'not-repo' } | { state: 'no-git' } | { state: 'error'; message: string }

export type RevertResult = { ok: true; id: string; what: string } | { ok: false; reason: 'changed' | 'nothing' | 'failed' | 'unknown'; message?: string }

export type CommitResult =
  | { ok: true; hash: string; subject: string }
  | { ok: false; reason: 'changed' | 'empty' | 'hook' | 'sign' | 'locked' | 'merging' | 'unknown'; tail: string }

export type UndoResult = 'ok' | 'moved' | 'remote' | 'root' | 'failed'
export type RestoreResult = 'ok' | 'changed' | 'gone' | 'unknown'

/** '되돌린 것' 목록 한 줄 — 패치 글은 renderer 에 보내지 않는다 */
export interface RevertedView {
  id: string
  at: number
  path: string
  what: string
}
