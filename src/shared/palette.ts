// 명령 팔레트(⌘P)의 찾기 · 순위. 순수 함수 — 무엇을 찾을지(일감 · 명령 · 템플릿 · 출력)는 부르는 쪽이 모아 넘긴다.

export type PaletteKind = 'task' | 'command' | 'template' | 'output' | 'create'
export type PaletteScope = 'all' | 'task' | 'command' | 'template' | 'output'

export const SCOPES: readonly PaletteScope[] = ['all', 'task', 'command', 'template', 'output']
export const SCOPE_LABEL: Record<PaletteScope, string> = { all: '전체', task: '일감', command: '명령', template: '템플릿', output: '출력' }

export interface PaletteInput {
  tasks: Array<{ id: string; name: string; detail: string }>
  commands: Array<{ id: string; label: string; hint: string }>
  templates: Array<{ id: string; name: string }>
  /** 터미널 출력에서 찾은 줄 (부르는 쪽이 찾기 글자로 이미 거른 것) */
  outputs: Array<{ paneId: string; taskName: string; line: number; text: string }>
  query: string
  scope: PaletteScope
}

export interface PaletteItem {
  kind: PaletteKind
  /** 일감 · 명령 · 템플릿 id, 출력은 `paneId:줄`, 새 일감은 이름 */
  id: string
  label: string
  detail?: string
  hint?: string
  /** label 에서 찾기 글자와 맞은 위치 (강조) */
  marks: number[]
  score: number
  paneId?: string
  line?: number
}

const OUTPUT_MIN_QUERY = 2
const OUTPUT_LIMIT = 20

const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i)

/** 대소문자 무시. 앞부분 일치 > 낱말 시작 일치 > 중간 일치 > 글자 순서만 맞음(퍼지). 안 맞으면 null. */
export function matchScore(text: string, query: string): { score: number; marks: number[] } | null {
  if (query === '') return { score: 0, marks: [] }
  const t = text.toLowerCase()
  const q = query.toLowerCase()
  const at = t.indexOf(q)
  if (at === 0) return { score: 1000 - t.length, marks: range(0, q.length) }
  if (at > 0) {
    // 낱말 시작: 앞 글자가 공백 · 구분 기호
    let i = at
    while (i >= 0) {
      if (i === 0 || /[\s/_.:-]/.test(t[i - 1]!)) return { score: 800 - i, marks: range(i, q.length) }
      i = t.indexOf(q, i + 1)
      if (i < 0) break
    }
    return { score: 600 - at, marks: range(at, q.length) }
  }
  // 글자 순서만 맞음 — 벌어진 칸이 적을수록 높게
  const marks: number[] = []
  let from = 0
  for (const ch of q) {
    const i = t.indexOf(ch, from)
    if (i < 0) return null
    marks.push(i)
    from = i + 1
  }
  const gaps = marks[marks.length - 1]! - marks[0]! + 1 - marks.length
  return { score: 300 - gaps, marks }
}

export function paletteItems(input: PaletteInput): PaletteItem[] {
  const query = input.query.trim()
  const want = (kind: PaletteScope) => input.scope === 'all' || input.scope === kind
  const out: PaletteItem[] = []
  const add = (item: Omit<PaletteItem, 'score' | 'marks'>, text: string) => {
    const m = matchScore(text, query)
    if (m) out.push({ ...item, score: m.score, marks: m.marks })
  }
  if (want('task')) for (const t of input.tasks) add({ kind: 'task', id: t.id, label: t.name, detail: t.detail }, t.name)
  if (want('command')) for (const c of input.commands) add({ kind: 'command', id: c.id, label: c.label, hint: c.hint }, c.label)
  if (want('template')) for (const t of input.templates) add({ kind: 'template', id: t.id, label: t.name }, t.name)

  // 점수순 — 같으면 넣은 순서(일감 > 명령 > 템플릿, 일감은 사이드바 순서). sort 는 안정 정렬이다
  const items = out.sort((a, b) => b.score - a.score)

  // 출력은 다른 것 뒤에 — 찾은 줄의 맞은 자리를 강조한다
  if (want('output') && query.length >= OUTPUT_MIN_QUERY) {
    const q = query.toLowerCase()
    for (const o of input.outputs.slice(0, OUTPUT_LIMIT)) {
      const at = o.text.toLowerCase().indexOf(q)
      if (at < 0) continue
      items.push({ kind: 'output', id: `${o.paneId}:${o.line}`, label: o.text, detail: o.taskName, marks: range(at, q.length), score: 0, paneId: o.paneId, line: o.line })
    }
  }

  // 글자 순서(퍼지)는 거의 무엇이든 맞으므로 '아무것도 안 맞을 때' 만으로는 새 일감에 닿기 어렵다 →
  // 이름이 꼭 같은 일감(대소문자 무시)이 없으면 맨 끝에 늘 둔다
  const exists = input.tasks.some((t) => t.name.trim().toLowerCase() === query.toLowerCase())
  if (query !== '' && !exists && (input.scope === 'all' || input.scope === 'task')) {
    items.push({ kind: 'create', id: query, label: query, marks: [], score: 0 })
  }
  return items
}

export function nextScope(scope: PaletteScope, step: 1 | -1): PaletteScope {
  const i = SCOPES.indexOf(scope)
  return SCOPES[(i + step + SCOPES.length) % SCOPES.length]!
}

/** 강조 조각: marks 는 UTF-16 위치(matchScore 가 indexOf 로 잰 것) — 이모지 같은 두 칸 글자를 한 글자로 세지 않는다 */
export function markSegments(text: string, marks: readonly number[]): Array<{ text: string; mark: boolean }> {
  const set = new Set(marks)
  const out: Array<{ text: string; mark: boolean }> = []
  let i = 0
  for (const ch of text) {
    const mark = set.has(i)
    const last = out[out.length - 1]
    if (last && last.mark === mark) last.text += ch
    else out.push({ text: ch, mark })
    i += ch.length
  }
  return out
}
