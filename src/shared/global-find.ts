// 모든 출력 찾기 ⇧⌘F (19단계) — 순수 함수. 줄 모으기 · 조각 나누기 · 화면은 GlobalFind.tsx.
// 판정 · 미리보기는 가린 글(redact)로 한다: 원문 비밀값으로는 찾지 못하고, ‹가림:종류› 로는 찾는다.

import { findSecrets, redact, type SecretOptions } from './redact'

export const PER_PANE = 50
export const TOTAL = 300
/** 결과가 많을 때 일감마다 먼저 보이는 줄 */
export const MANY_SHOW = 3
/** 고른 줄의 앞뒤 */
export const CONTEXT = 2
/** 입력이 이만큼 쉬면 찾기 시작 */
export const DEBOUNCE_MS = 150

export interface FindFlags {
  /** Aa — 대소문자를 가린다 */
  cs: boolean
  /** .* — 정규식 */
  re: boolean
}

export type Matcher = { ok: true; test(text: string): { at: number; len: number } | null } | { ok: false; error: string }

function regexError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  if (/Unterminated group|missing \)/i.test(msg)) return '( 가 닫히지 않았어요'
  if (/Unterminated character class/i.test(msg)) return '[ 가 닫히지 않았어요'
  if (/Unmatched '\)'/i.test(msg)) return ') 의 짝이 없어요'
  if (/Nothing to repeat/i.test(msg)) return '되풀이할 것이 없어요(* + ? 앞에 글자가 필요해요)'
  return msg.replace(/^Invalid regular expression: /, '')
}

export function makeMatcher(query: string, flags: FindFlags): Matcher {
  if (flags.re) {
    let re: RegExp
    try {
      re = new RegExp(query, flags.cs ? 'g' : 'gi')
    } catch (e) {
      return { ok: false, error: `정규식을 읽을 수 없어요: ${regexError(e)}` }
    }
    return {
      ok: true,
      test: (text) => {
        re.lastIndex = 0
        for (const m of text.matchAll(re)) if (m[0].length > 0) return { at: m.index, len: m[0].length }
        return null
      },
    }
  }
  const q = flags.cs ? query : query.toLowerCase()
  return {
    ok: true,
    test: (text) => {
      const at = (flags.cs ? text : text.toLowerCase()).indexOf(q)
      return at < 0 ? null : { at, len: q.length }
    },
  }
}

/** 찾기 글자가 가린 자리(‹가림:종류›)를 찾는가 — 그러면 모든 줄을 가린 뒤 판정한다 */
export const isMaskQuery = (query: string): boolean => query.includes('가림:') || query.includes('‹가림')

export interface Line {
  line: number
  text: string
}

export interface LineHit {
  line: number
  /** 가린 글 */
  text: string
  at: number
  len: number
}

/**
 * 줄들에서 찾기 — limit 개까지(그 뒤가 더 있으면 more). 원문에 맞은 줄만 가려 다시 판정한다(줄마다 가리면 60 pane × 5000줄이 느리다).
 * maskQuery 면 모든 줄을 가려 판정.
 */
export function findInLines(lines: readonly Line[], matcher: Extract<Matcher, { ok: true }>, opts: { limit: number; redact: SecretOptions; maskQuery: boolean }): { hits: LineHit[]; more: boolean } {
  const hits: LineHit[] = []
  for (const l of lines) {
    if (!opts.maskQuery && !matcher.test(l.text)) continue
    const text = redact(l.text, opts.redact)
    const m = matcher.test(text)
    if (!m) continue
    if (hits.length >= opts.limit) return { hits, more: true }
    hits.push({ line: l.line, text, at: m.at, len: m.len })
  }
  return { hits, more: false }
}

/** 13단계 되살리기 배너 '── 이전 세션 · …' 의 줄 번호 — 그 앞이 이전 세션 글. 없으면 -1 (마지막 배너) */
export function prevSessionLine(lines: readonly Line[]): number {
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i]!.text.startsWith('── 이전 세션')) return lines[i]!.line
  return -1
}

/** 비밀값처럼 보이는 낱말이면 '가림:종류' (그 종류 이름으로 찾는 길) */
export function secretHint(query: string, opts: SecretOptions = {}): string | null {
  const f = findSecrets(query, opts)[0]
  return f ? `가림:${f.kind}` : null
}

/** 결과 한 줄 보이기 — 앞은 40자까지(앞을 자른 표시 …) · 맞은 곳 · 뒤 */
export function snippet(text: string, at: number, len: number): { pre: string; hit: string; post: string } {
  const pre = text.slice(0, at)
  return { pre: pre.length > 40 ? '…' + pre.slice(-40) : pre, hit: text.slice(at, at + len), post: text.slice(at + len) }
}

// CSI · OSC · 두 글자 이스케이프 (redact.ts 와 같은 모양)
const ANSI = /\x1b\[[0-9;:?<=>]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

/** 저장된 스크롤 글(SerializeAddon — 색 코드 포함)을 찾을 수 있는 글로 */
export const stripAnsi = (text: string): string => text.replace(ANSI, '')

/** 저장된 스크롤 글 → 줄 (\r\n · \n) */
export const savedLines = (text: string): Line[] =>
  stripAnsi(text)
    .split(/\r?\n/)
    .map((t, line) => ({ line, text: t.replace(/\r/g, '').trimEnd() }))
