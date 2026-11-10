// 템플릿 JSON 편집기의 검증. 오류마다 줄 번호를 알려 주려고 위치를 기억하는 작은 JSON 파서를 둔다
// (JSON.parse 는 문법 오류의 위치만, 그것도 엔진마다 다른 글로 알려 주고 모양 오류의 위치는 모른다).
import type { LayoutSpec, PaneSpec, Template, TemplateTab } from './types'

export interface TemplateJsonError {
  /** 1부터 */
  line: number
  message: string
}
export type TemplateJsonResult = { ok: true; value: Pick<Template, 'name' | 'tabs'> } | { ok: false; errors: TemplateJsonError[] }

type Node =
  | { kind: 'object'; line: number; entries: Array<{ key: string; line: number; value: Node }> }
  | { kind: 'array'; line: number; items: Node[] }
  | { kind: 'string'; line: number; value: string }
  | { kind: 'number'; line: number; value: number }
  | { kind: 'bool'; line: number; value: boolean }
  | { kind: 'null'; line: number }

class SyntaxFail extends Error {
  constructor(
    readonly line: number,
    message: string,
  ) {
    super(message)
  }
}

function parse(text: string): Node {
  let i = 0
  let line = 1
  const fail = (message: string): never => {
    throw new SyntaxFail(line, message)
  }
  const ws = () => {
    for (; i < text.length; i++) {
      const c = text[i]
      if (c === '\n') line++
      else if (c !== ' ' && c !== '\t' && c !== '\r') break
    }
  }
  const end = () => i >= text.length
  const expectChar = (c: string, what: string) => {
    ws()
    if (end()) fail(`글이 끝났습니다 — ${what} 이 필요합니다`)
    if (text[i] !== c) fail(`${what} 이 필요한 자리에 ‘${text[i]}’ 가 있습니다`)
    i++
  }
  const str = (): string => {
    i++ // "
    let out = ''
    for (;;) {
      if (end()) fail('글이 끝났습니다 — 따옴표(")가 닫히지 않았습니다')
      const c = text[i]!
      if (c === '"') {
        i++
        return out
      }
      if (c === '\n') fail('따옴표(")가 닫히지 않았습니다')
      if (c === '\\') {
        const e = text[i + 1]
        const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }
        if (e !== undefined && e in simple) {
          out += simple[e]
          i += 2
        } else if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
          out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16))
          i += 6
        } else fail('잘못된 \\ 이스케이프입니다')
        continue
      }
      out += c
      i++
    }
  }
  const value = (): Node => {
    ws()
    if (end()) fail('글이 끝났습니다 — 값이 필요합니다')
    const at = line
    const c = text[i]!
    if (c === '{') {
      i++
      const entries: Array<{ key: string; line: number; value: Node }> = []
      ws()
      if (text[i] === '}') {
        i++
        return { kind: 'object', line: at, entries }
      }
      for (;;) {
        ws()
        if (end()) fail('글이 끝났습니다 — } 가 필요합니다')
        if (text[i] === '}') fail('마지막 항목 뒤의 쉼표(,)를 지우세요')
        if (text[i] !== '"') fail(`키는 "따옴표"로 감싸야 합니다 (‘${text[i]}’)`)
        const keyLine = line
        const key = str()
        expectChar(':', '콜론(:)')
        entries.push({ key, line: keyLine, value: value() })
        ws()
        if (text[i] === ',') {
          i++
          continue
        }
        if (text[i] === '}') {
          i++
          return { kind: 'object', line: at, entries }
        }
        if (end()) fail('글이 끝났습니다 — } 가 필요합니다')
        fail('항목 사이에 쉼표(,)가 필요합니다')
      }
    }
    if (c === '[') {
      i++
      const items: Node[] = []
      ws()
      if (text[i] === ']') {
        i++
        return { kind: 'array', line: at, items }
      }
      for (;;) {
        ws()
        if (text[i] === ']') fail('마지막 항목 뒤의 쉼표(,)를 지우세요')
        items.push(value())
        ws()
        if (text[i] === ',') {
          i++
          continue
        }
        if (text[i] === ']') {
          i++
          return { kind: 'array', line: at, items }
        }
        if (end()) fail('글이 끝났습니다 — ] 가 필요합니다')
        fail('항목 사이에 쉼표(,)가 필요합니다')
      }
    }
    if (c === '"') return { kind: 'string', line: at, value: str() }
    const num = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i))
    if (num) {
      i += num[0].length
      return { kind: 'number', line: at, value: Number(num[0]) }
    }
    for (const [word, node] of [
      ['true', { kind: 'bool', line: at, value: true }],
      ['false', { kind: 'bool', line: at, value: false }],
      ['null', { kind: 'null', line: at }],
    ] as const) {
      if (text.startsWith(word, i)) {
        i += word.length
        return node
      }
    }
    return fail(`알 수 없는 값입니다 (‘${text.slice(i, i + 12).split('\n')[0]}’) — 글자는 "따옴표"로 감쌉니다`)
  }
  const root = value()
  ws()
  if (!end()) fail('JSON 이 끝난 뒤에 글이 더 있습니다')
  return root
}

// ─── 모양 검사 ────────────────────────────────────────────

const RESERVED = new Set(['__proto__', 'constructor', 'prototype'])

function check(root: Node): TemplateJsonResult {
  const errors: TemplateJsonError[] = []
  const err = (line: number, message: string) => {
    errors.push({ line, message })
    return null
  }

  /** 객체의 키를 읽는다: 모르는 키 · 같은 키 두 번은 오류. 키 → 값 */
  const fields = (node: Extract<Node, { kind: 'object' }>, allowed: string[]): Map<string, { line: number; value: Node }> => {
    const out = new Map<string, { line: number; value: Node }>()
    for (const e of node.entries) {
      if (out.has(e.key)) err(e.line, `키 "${e.key}" 가 두 번 나옵니다`)
      else if (!allowed.includes(e.key)) err(e.line, `모르는 키 "${e.key}" — 쓸 수 있는 키: ${allowed.join(', ')}`)
      else out.set(e.key, { line: e.line, value: e.value })
    }
    return out
  }
  const optString = (f: { line: number; value: Node } | undefined, key: string): string | undefined | null => {
    if (!f) return undefined
    return f.value.kind === 'string' ? f.value.value : err(f.line, `"${key}" 는 "글자"여야 합니다`)
  }

  const pane = (node: Node, line: number): PaneSpec | null => {
    if (node.kind !== 'object') return err(line, '"pane" 은 { } 객체여야 합니다 — 예: { "command": "claude" }')
    const f = fields(node, ['command', 'cwd'])
    const spec: PaneSpec = {}
    for (const key of ['command', 'cwd'] as const) {
      const v = optString(f.get(key), key)
      if (v === null) return null
      if (v !== undefined) spec[key] = v
    }
    return spec
  }

  const layout = (node: Node, line: number): LayoutSpec | null => {
    if (node.kind !== 'object') return err(line, '"layout" 은 { } 객체여야 합니다')
    const f = fields(node, ['pane', 'split', 'ratio', 'a', 'b'])
    const p = f.get('pane')
    const s = f.get('split')
    if (p && s) return err(node.line, '"pane" 과 "split" 중 하나만 씁니다')
    if (p) {
      for (const k of ['ratio', 'a', 'b']) if (f.has(k)) err(f.get(k)!.line, `"${k}" 는 "split" 과 함께 씁니다`)
      const spec = pane(p.value, p.line)
      return spec ? { pane: spec } : null
    }
    if (!s) return err(node.line, '{ "pane": { } } (터미널 하나) 이나 { "split": "right", "a": …, "b": … } (나누기) 가 필요합니다')
    let ok = true
    if (s.value.kind !== 'string' || (s.value.value !== 'right' && s.value.value !== 'down')) ok = !!err(s.line, '"split" 은 "right"(좌우) 또는 "down"(위아래) 입니다')
    const r = f.get('ratio')
    if (r && (r.value.kind !== 'number' || r.value.value < 0.1 || r.value.value > 0.9)) ok = !!err(r.line, '"ratio" 는 0.1 ~ 0.9 사이 숫자입니다 (a 쪽의 몫)')
    const a = f.get('a')
    const b = f.get('b')
    if (!a || !b) return err(node.line, '나누기에는 "a" 와 "b" 가 모두 있어야 합니다')
    const la = layout(a.value, a.line)
    const lb = layout(b.value, b.line)
    if (!ok || !la || !lb) return null
    const out: LayoutSpec = { split: (s.value as { value: 'right' | 'down' }).value, a: la, b: lb }
    if (r) out.ratio = (r.value as { value: number }).value
    return out
  }

  const tab = (node: Node): TemplateTab | null => {
    if (node.kind !== 'object') return err(node.line, '탭은 { "layout": … } 객체여야 합니다')
    const f = fields(node, ['title', 'layout'])
    const title = optString(f.get('title'), 'title')
    const l = f.get('layout')
    if (!l) return err(node.line, '탭에 "layout" 이 없습니다')
    const spec = layout(l.value, l.line)
    if (!spec || title === null) return null
    return title === undefined ? { layout: spec } : { title, layout: spec }
  }

  if (root.kind !== 'object') {
    err(root.line, '맨 바깥은 { "name": …, "tabs": [ … ] } 객체여야 합니다')
    return { ok: false, errors }
  }
  const f = fields(root, ['name', 'tabs'])
  const n = f.get('name')
  let name: string | null = null
  if (!n) err(root.line, '"name" (템플릿 이름)이 없습니다')
  else if (n.value.kind !== 'string' || !n.value.value.trim()) err(n.line, '"name" 은 비어 있지 않은 "글자"여야 합니다')
  else if (RESERVED.has(n.value.value.trim())) err(n.line, `"${n.value.value.trim()}" 는 이름으로 쓸 수 없습니다`)
  else name = n.value.value.trim()
  const t = f.get('tabs')
  const tabs: TemplateTab[] = []
  if (!t) err(root.line, '"tabs" (탭 목록)가 없습니다')
  else if (t.value.kind !== 'array' || t.value.items.length === 0) err(t.line, '"tabs" 는 탭이 하나 이상 든 [ ] 배열이어야 합니다')
  else for (const item of t.value.items) tabs.push(tab(item) as TemplateTab)

  if (errors.length > 0 || name === null) return { ok: false, errors: errors.sort((x, y) => x.line - y.line) }
  return { ok: true, value: { name, tabs } }
}

export function parseTemplateJson(text: string): TemplateJsonResult {
  let root: Node
  try {
    root = parse(text)
  } catch (e) {
    if (e instanceof SyntaxFail) return { ok: false, errors: [{ line: e.line, message: e.message }] }
    throw e
  }
  return check(root)
}

/** 편집기에 보여 줄 글 — id 는 빼고(바꾸지 못하게) 2칸 들여쓰기 */
export function templateToJson(t: Pick<Template, 'name' | 'tabs'>): string {
  return JSON.stringify({ name: t.name, tabs: t.tabs }, null, 2)
}
