// 명령 팔레트(⌘P)의 찾기 · 순위. 순수 함수 — 무엇을 찾을지(일감 · 명령 · 템플릿 · 출력)는 부르는 쪽이 모아 넘긴다.

export type PaletteKind = 'task' | 'command' | 'quick' | 'port' | 'template' | 'history' | 'output' | 'find-all' | 'create'
export type PaletteScope = 'all' | 'task' | 'command' | 'template' | 'output'

export const SCOPES: readonly PaletteScope[] = ['all', 'task', 'command', 'template', 'output']
export const SCOPE_LABEL: Record<PaletteScope, string> = { all: '전체', task: '일감', command: '명령', template: '템플릿', output: '출력' }

export interface PaletteInput {
  tasks: Array<{ id: string; name: string; detail: string }>
  commands: Array<{ id: string; label: string; hint: string }>
  templates: Array<{ id: string; name: string }>
  /** 터미널 출력에서 찾은 줄 (부르는 쪽이 찾기 글자로 이미 거른 것) */
  outputs: Array<{ paneId: string; taskName: string; line: number; text: string }>
  /** 명령 기록 (19단계) — 최근 것부터. 고르면 입력줄에 넣는다 */
  history?: Array<{ id: string; cmd: string; taskName: string }>
  /** 빠른 명령 (20단계) — 모든 일감 것. id 는 부르는 쪽이 다시 찾을 열쇠 */
  quick?: Array<{ id: string; label: string; command: string; taskName: string; hint: string }>
  /** 듣는 포트 (20단계) — id 는 `paneId:포트` */
  ports?: Array<{ id: string; port: number; taskName: string; proc: string }>
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
const HISTORY_LIMIT = 8

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
  // 빠른 명령: 이름이 맞으면 이름 강조, 명령 글자만 맞으면 강조 없이 조금 낮게
  if (want('command'))
    for (const q of input.quick ?? []) {
      const m = matchScore(q.label, query)
      const c = m ? null : query && q.command.toLowerCase().includes(query.toLowerCase()) ? { score: 500, marks: [] } : null
      const hit = m ?? c
      if (hit) out.push({ kind: 'quick', id: q.id, label: q.label, detail: q.taskName, hint: q.hint, score: hit.score, marks: hit.marks })
    }
  // 포트: '포트' 로 시작하면 모두, 아니면 번호 · 일감 · 프로세스 글자 그대로 (퍼지로는 거의 모든 것이 맞는다)
  if (input.scope === 'all' && query !== '') {
    const q = query.toLowerCase()
    const rest = q.startsWith('포트') ? q.slice(2).trim() : null
    for (const p of input.ports ?? []) {
      const text = `${p.port} ${p.taskName} ${p.proc}`.toLowerCase()
      if (rest === null ? !text.includes(q) : rest !== '' && !text.includes(rest)) continue
      out.push({ kind: 'port', id: p.id, label: `:${p.port}`, detail: p.taskName, hint: p.proc, marks: [], score: rest === null ? 400 : 900 })
    }
  }
  if (want('template')) for (const t of input.templates) add({ kind: 'template', id: t.id, label: t.name }, t.name)

  // 점수순 — 같으면 넣은 순서(일감 > 명령 > 템플릿, 일감은 사이드바 순서). sort 는 안정 정렬이다
  const items = groupByKind(out.sort((a, b) => b.score - a.score))

  // 기록: 명령 글자 그대로 맞은 것(퍼지는 거의 모든 명령에 맞는다) — 최근 것부터, 같은 명령은 한 번. 전체 범위에서만
  if (input.scope === 'all' && query !== '' && input.history) {
    const q = query.toLowerCase()
    const seen = new Set<string>()
    for (const h of input.history) {
      if (seen.size >= HISTORY_LIMIT) break
      const at = h.cmd.toLowerCase().indexOf(q)
      if (at < 0 || seen.has(h.cmd)) continue
      seen.add(h.cmd)
      items.push({ kind: 'history', id: h.id, label: h.cmd, detail: h.taskName, marks: range(at, q.length), score: 0 })
    }
  }

  // 출력은 다른 것 뒤에 — 찾은 줄의 맞은 자리를 강조한다. 찾은 줄이 있으면 맨 아래 '모두 보기 ⇧⌘F' (같은 낱말로 모든 출력 찾기)
  if (want('output') && query.length >= OUTPUT_MIN_QUERY) {
    const q = query.toLowerCase()
    for (const o of input.outputs.slice(0, OUTPUT_LIMIT)) {
      const at = o.text.toLowerCase().indexOf(q)
      if (at < 0) continue
      items.push({ kind: 'output', id: `${o.paneId}:${o.line}`, label: o.text, detail: o.taskName, marks: range(at, q.length), score: 0, paneId: o.paneId, line: o.line })
    }
    if (items.at(-1)?.kind === 'output') items.push({ kind: 'find-all', id: 'find-all', label: '모든 출력에서 찾기', hint: '⇧⌘F', marks: [], score: 0 })
  }

  // 글자 순서(퍼지)는 거의 무엇이든 맞으므로 '아무것도 안 맞을 때' 만으로는 새 일감에 닿기 어렵다 →
  // 이름이 꼭 같은 일감(대소문자 무시)이 없으면 맨 끝에 늘 둔다
  const exists = input.tasks.some((t) => t.name.trim().toLowerCase() === query.toLowerCase())
  if (query !== '' && !exists && (input.scope === 'all' || input.scope === 'task')) {
    items.push({ kind: 'create', id: query, label: query, marks: [], score: 0 })
  }
  return items
}

/**
 * 종류마다 한 묶음(28c 리뷰 — 팔레트가 종류 제목 줄을 달므로 같은 제목이 두 번 나오지 않게).
 * 점수순으로 정렬된 목록을 받아, 묶음 순서는 그 종류가 처음 나온 순서(= 가장 높은 점수 순), 묶음 안은 받은 순서(점수순)를 지킨다.
 */
function groupByKind(sorted: PaletteItem[]): PaletteItem[] {
  const groups = new Map<PaletteItem['kind'], PaletteItem[]>()
  for (const item of sorted) {
    const g = groups.get(item.kind)
    if (g) g.push(item)
    else groups.set(item.kind, [item])
  }
  return [...groups.values()].flat()
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
