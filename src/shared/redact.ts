// 출력 속 비밀값 찾기 · 가리기 (17단계 Secrets). 순수 함수 — main(디스크로 가는 모든 길)과 renderer(화면 가림)가 같은 종류 · 같은 이름을 쓴다.
// 가린 모양은 ‹가림:종류 이름› — 무엇이 있었는지만 남기고 값 · 길이는 남기지 않는다.

export type SecretKindId =
  | 'anthropic'
  | 'openai'
  | 'github'
  | 'aws'
  | 'slack'
  | 'atlassian'
  | 'notion'
  | 'jwt'
  | 'bearer'
  | 'private-key'
  | 'named'

/** 화면 표시를 켜고 끄는 단위 (설정 › 개인정보의 줄) — 디스크는 종류와 상관없이 항상 가린다 */
export type SecretToggleId = 'anthropic' | 'openai' | 'github' | 'aws' | 'slack' | 'atlassian-notion' | 'jwt-bearer' | 'private-key' | 'named'

interface KindDef {
  id: SecretKindId
  name: string
  toggle: SecretToggleId
  /** 값 전체가 맞아야 하는 모양. named 는 따로 */
  re: RegExp | null
}

// 앞쪽이 먼저 — 같은 자리에서 겹치면 앞 종류의 이름을 쓴다(GITHUB_TOKEN=ghp_… 는 '비밀번호' 가 아니라 'GitHub 토큰')
const KINDS: readonly KindDef[] = [
  { id: 'private-key', name: '개인 키', toggle: 'private-key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g },
  { id: 'anthropic', name: 'Anthropic 키', toggle: 'anthropic', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: 'openai', name: 'OpenAI 키', toggle: 'openai', re: /sk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g },
  { id: 'github', name: 'GitHub 토큰', toggle: 'github', re: /(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/g },
  { id: 'aws', name: 'AWS 접근 키', toggle: 'aws', re: /(?<![A-Z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Z0-9])/g },
  { id: 'slack', name: 'Slack 토큰', toggle: 'slack', re: /xox[abposr]-[A-Za-z0-9-]{10,}/g },
  { id: 'atlassian', name: 'Atlassian 토큰', toggle: 'atlassian-notion', re: /ATATT[A-Za-z0-9_=-]{20,}/g },
  { id: 'notion', name: 'Notion 토큰', toggle: 'atlassian-notion', re: /(?:ntn_[A-Za-z0-9]{30,}|secret_[A-Za-z0-9]{43})/g },
  { id: 'jwt', name: 'JWT', toggle: 'jwt-bearer', re: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { id: 'bearer', name: 'Bearer 토큰', toggle: 'jwt-bearer', re: /(?<=\bBearer\s+)[A-Za-z0-9._~+/-]{20,}=*/g },
  { id: 'named', name: '비밀번호', toggle: 'named', re: null },
]

/**
 * 이름 붙은 값: PASSWORD=… · DB_SECRET: … · api_key="…". 이름 쪽은 대소문자 무시. 값은 따옴표 안 또는 공백 · 따옴표 전까지 4자 이상.
 * $VAR · ${VAR} · ‹가림› 같은 값이 아닌 것은 건너뛴다.
 */
const NAMED = /\b[A-Za-z0-9_.-]*(?:password|passwd|secret|token|api_?key|access_?key|private_?key|client_?secret)(?:_[A-Za-z0-9_]*)?\s*[=:]\s*(?:"([^"\n]{4,})"|'([^'\n]{4,})'|([^\s"'`,;]{4,}))/gi

export const SECRET_TOGGLES: ReadonlyArray<{ id: SecretToggleId; name: string; example: string; screenDefault: boolean }> = [
  { id: 'anthropic', name: 'Anthropic 키', example: 'sk-ant-…', screenDefault: true },
  { id: 'openai', name: 'OpenAI 키', example: 'sk-proj-…', screenDefault: true },
  { id: 'github', name: 'GitHub 토큰', example: 'ghp_ · github_pat_', screenDefault: true },
  { id: 'aws', name: 'AWS 접근 키', example: 'AKIA…', screenDefault: true },
  { id: 'slack', name: 'Slack 토큰', example: 'xoxb- · xoxp-', screenDefault: true },
  { id: 'atlassian-notion', name: 'Atlassian · Notion 토큰', example: 'ATATT… · ntn_…', screenDefault: true },
  { id: 'jwt-bearer', name: 'JWT · Bearer', example: 'eyJ….eyJ….', screenDefault: true },
  { id: 'private-key', name: '개인 키 블록', example: '-----BEGIN … KEY', screenDefault: true },
  { id: 'named', name: '비밀번호처럼 이름 붙은 값', example: 'PASSWORD=… · SECRET=…', screenDefault: false },
]

/** 사용자가 더한 종류 (설정 › 개인정보 › 내 종류) */
export interface CustomKind {
  name: string
  pattern: string
}

export interface SecretOptions {
  /** '비밀값 아님' 으로 고른 값의 해시 — 이 값은 가리지 않는다(디스크도) */
  allow?: ReadonlySet<string>
  custom?: readonly CustomKind[]
  /** 화면: 이 종류만 (없으면 모두 — 디스크) */
  toggles?: ReadonlySet<SecretToggleId>
}

export interface SecretMatch {
  start: number
  end: number
  /** 화면 · 파일에 쓰는 종류 이름 */
  kind: string
  value: string
}

export const maskOf = (kind: string): string => `‹가림:${kind}›`

/** '비밀값 아님' 목록에 넣는 값의 해시 (cyrb53 — 원문을 설정 파일에 남기지 않게. 보안용 해시가 아니라 같은 값 알아보기용) */
export function secretHash(value: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/** 내 종류의 모양 검사 — 틀리면 사용자에게 보일 글, 맞으면 null */
export function customPatternError(pattern: string): string | null {
  if (!pattern.trim()) return '모양을 적어 주세요'
  if (pattern.length > 500) return '모양이 너무 길어요 (500자까지)'
  let re: RegExp
  try {
    re = new RegExp(pattern, 'gu')
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const hint = /Incomplete quantifier|Lone quantifier brackets/.test(msg)
      ? '닫는 } 가 없어요'
      : /Unterminated character class/.test(msg)
        ? '닫는 ] 가 없어요'
        : /Unterminated group|Unmatched '\)'/.test(msg)
          ? '괄호 ( ) 짝이 맞지 않아요'
          : msg.replace(/^Invalid regular expression: \/.*\/[a-z]*: /, '')
    return `이 모양은 읽을 수 없어요: ${hint}`
  }
  if (re.test('')) return '빈 글에도 맞는 모양은 쓸 수 없어요'
  return null
}

const customRegexes = new Map<string, RegExp | null>()
function customRe(pattern: string): RegExp | null {
  if (!customRegexes.has(pattern)) customRegexes.set(pattern, customPatternError(pattern) ? null : new RegExp(pattern, 'gu'))
  return customRegexes.get(pattern)!
}

/** 글에서 비밀값 자리를 찾는다 — 겹치면 먼저 시작한 것, 같은 자리면 앞 종류. 시작 순서로 돌려준다. */
export function findSecrets(text: string, opts: SecretOptions = {}): SecretMatch[] {
  const found: Array<SecretMatch & { rank: number }> = []
  const on = (toggle: SecretToggleId) => !opts.toggles || opts.toggles.has(toggle)
  KINDS.forEach((k, rank) => {
    if (!on(k.toggle)) return
    if (k.re) {
      k.re.lastIndex = 0
      for (const m of text.matchAll(k.re)) found.push({ start: m.index, end: m.index + m[0].length, kind: k.name, value: m[0], rank })
      return
    }
    for (const m of text.matchAll(NAMED)) {
      const value = m[1] ?? m[2] ?? m[3] ?? ''
      if (/^\$|^‹가림|^\*+$|^<.*>$/.test(value)) continue
      const start = m.index + m[0].length - value.length - (m[1] !== undefined || m[2] !== undefined ? 1 : 0)
      found.push({ start, end: start + value.length, kind: k.name, value, rank })
    }
  })
  for (const c of opts.custom ?? []) {
    const re = customRe(c.pattern)
    if (!re || !c.name.trim()) continue
    re.lastIndex = 0
    for (const m of text.matchAll(re)) if (m[0]) found.push({ start: m.index, end: m.index + m[0].length, kind: c.name.trim(), value: m[0], rank: KINDS.length })
  }
  found.sort((a, b) => a.start - b.start || a.rank - b.rank || b.end - a.end)
  const out: SecretMatch[] = []
  let end = -1
  for (const f of found) {
    if (f.start < end) continue
    end = f.end
    // 가리지 않기로 한 값도 그 자리를 차지한다 — 겹치는 아래 순위 종류(Bearer 등)가 같은 값을 다시 가리지 않게
    if (opts.allow?.has(secretHash(f.value))) continue
    out.push({ start: f.start, end: f.end, kind: f.kind, value: f.value })
  }
  return out
}

// CSI · OSC · 두 글자 이스케이프 — 저장 글(SerializeAddon)의 색 코드가 토큰 중간에 낄 수 있다(grep --color 가 맞은 곳만 칠함)
const ANSI = /\x1b\[[0-9;:?<=>]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

/**
 * 디스크로 가기 전 — 찾은 자리를 ‹가림:종류› 로 바꾼다. 색 코드를 빼고 찾은 뒤, 원문에서 그 자리를 바꾸며
 * 자리 안에 있던 색 코드는 가림 뒤에 그대로 둔다(색 상태가 뒤 글로 새지 않게).
 */
export function redact(text: string, opts: SecretOptions = {}): string {
  if (!text.includes('\x1b')) return replaceAt(text, findSecrets(text, opts), (f) => maskOf(f.kind))
  // 뺀 글의 i 번째 글자가 원문의 map[i] 번째
  let plain = ''
  const map: number[] = []
  let at = 0
  for (const m of text.matchAll(ANSI)) {
    for (let i = at; i < m.index; i++) map.push(i)
    plain += text.slice(at, m.index)
    at = m.index + m[0].length
  }
  for (let i = at; i < text.length; i++) map.push(i)
  plain += text.slice(at)
  const found = findSecrets(plain, opts)
  if (found.length === 0) return text
  const spans = found.map((f) => ({ ...f, start: map[f.start]!, end: map[f.end - 1]! + 1 }))
  return replaceAt(text, spans, (f) => maskOf(f.kind) + (text.slice(f.start, f.end).match(ANSI) ?? []).join(''))
}

function replaceAt(text: string, spans: readonly SecretMatch[], mask: (f: SecretMatch) => string): string {
  if (spans.length === 0) return text
  let out = ''
  let at = 0
  for (const f of spans) {
    out += text.slice(at, f.start) + mask(f)
    at = f.end
  }
  return out + text.slice(at)
}
