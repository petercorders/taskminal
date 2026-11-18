// 일감 폴더의 파일 빨리 열기 · 내용 찾기 (65단계) — 순수 로직. git 은 main(src/main/workspace-search.ts)이 부른다.

/** ⌘P · 내용 찾기가 다루는 파일 수 상한 */
export const FILES_MAX = 20_000
/** 내용 찾기 결과 줄 상한 */
export const GREP_MAX = 500
/** 결과 줄 글자 상한 — 넘으면 자른다 */
export const GREP_LINE_CHARS = 300
export const GREP_QUERY_MIN = 2
export const GREP_QUERY_MAX = 200
export const GREP_TIMEOUT_MS = 10_000

export interface GrepHit {
  path: string
  line: number
  text: string
}

export interface GrepResult {
  hits: GrepHit[]
  /** 상한에서 멈췄다 — 더 있다 */
  more: boolean
  /** 시간 한도에서 멈췄다 */
  timedOut: boolean
}

/** 내용 찾기 결과 아래에 보일 안내 — 찾는 중 · 없음 · 상한 · 시간 한도 · 실패 */
export function grepNotes(result: GrepResult | null, busy: boolean, failed: boolean): string[] {
  if (failed) return ['찾지 못했어요. 다시 시도해 주세요.']
  if (busy) return ['찾는 중…']
  if (!result) return []
  const notes: string[] = []
  if (result.hits.length === 0 && !result.timedOut) notes.push('맞는 줄이 없어요.')
  if (result.more) notes.push(`결과가 많아 처음 ${GREP_MAX}줄만 보여요. 글을 더 길게 적어 보세요.`)
  if (result.timedOut) notes.push('시간이 넘어 멈췄어요. 찾은 데까지만 보여요.')
  return notes
}

/** 파일 경로의 폴더 — 맨 위 파일이면 빈 글 */
export const dirOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')

/** 그 줄을 보이는 범위 — 위로 세 줄을 함께 보인다(맥락) */
export function rangeAt(line: number | undefined, lines: number): { from: number; to: number } {
  if (line === undefined) return { from: 1, to: Math.min(100, Math.max(1, lines)) }
  const from = Math.max(1, Math.min(lines, Math.trunc(line)) - 3)
  return { from, to: Math.min(Math.max(1, lines), from + 99) }
}

/** 찾을 글 — 앞뒤 공백을 뗀 2~200자, 줄바꿈 · NUL 없음. 아니면 null */
export function grepQuery(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const q = v.trim()
  return q.length >= GREP_QUERY_MIN && q.length <= GREP_QUERY_MAX && !/[\0\r\n]/.test(q) ? q : null
}

/**
 * `git grep -n -z` 출력(`경로\0줄\0글\n`)을 줄 단위로. 조각이 줄 가운데서 끊겨도 이어 붙인다.
 * 모양이 다른 줄은 버리고, 글은 상한에서 자른다.
 */
export class GrepParser {
  private buf = ''
  push(chunk: string): GrepHit[] {
    this.buf += chunk
    const out: GrepHit[] = []
    for (;;) {
      const nl = this.buf.indexOf('\n')
      if (nl < 0) break
      const hit = parseGrepLine(this.buf.slice(0, nl))
      this.buf = this.buf.slice(nl + 1)
      if (hit) out.push(hit)
    }
    return out
  }
}

export function parseGrepLine(line: string): GrepHit | null {
  const a = line.indexOf('\0')
  const b = a < 0 ? -1 : line.indexOf('\0', a + 1)
  if (a <= 0 || b < 0) return null
  const n = Number(line.slice(a + 1, b))
  if (!Number.isInteger(n) || n < 1) return null
  return { path: line.slice(0, a), line: n, text: line.slice(b + 1, b + 1 + GREP_LINE_CHARS) }
}

/** `git ls-files -z` 출력 → 경로들(상한까지). keep 이 거른 것(민감 파일)은 뺀다 */
export function parseFileList(out: string, keep: (path: string) => boolean, max = FILES_MAX): string[] {
  const files: string[] = []
  for (const p of out.split('\0')) {
    if (files.length >= max) break
    if (p && keep(p)) files.push(p)
  }
  return files
}
