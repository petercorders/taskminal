// 화면에서 비밀값 가리기 (17단계 Secrets). xterm 버퍼는 그대로 두고 찾은 칸 위에 decoration 을 덮는다.
// 디스크 쪽(main 의 redact)과 같은 종류 · 같은 이름(shared/redact).
import type { IDecoration, IMarker, Terminal } from '@xterm/xterm'
import { findSecrets, maskOf, redact, secretHash, type CustomKind, type SecretOptions, type SecretToggleId } from '../shared/redact'

/** 화면 가리기 설정 — App 이 설정에서 만든다 */
export interface MaskSettings {
  enabled: boolean
  toggles: ReadonlySet<SecretToggleId>
  allow: ReadonlySet<string>
  custom: readonly CustomKind[]
}

export interface MaskHit {
  id: number
  kind: string
  value: string
  hash: string
  /** 첫 칸이 있는 버퍼 줄 (마커가 따라간다) */
  line(): number
  open: boolean
}

interface HitRec extends MaskHit {
  markers: IMarker[]
  decorations: IDecoration[]
  first: HTMLElement | null
}

/** 가린 칸 모양 — 중립 회색 + 점선(노랑 = 확인 필요 · 보라 = 동작과 겹치지 않게) */
const MASKED = 'background:#23262b;color:#c9ccd1;border:1px dashed #4a4f57'
const OPENED = 'background:transparent;color:transparent;border:1px solid #3a3f47'

export class SecretMasker {
  private hits: HitRec[] = []
  private nextId = 1
  /** 여기까지 훑었다 — 다음 훑기는 이 줄(의 논리 줄 처음)부터 */
  private scanMarker: IMarker | null = null
  private revealUntil = 0
  private revealTimer: ReturnType<typeof setTimeout> | undefined
  private disposed = false

  constructor(
    private readonly term: Terminal,
    private settings: MaskSettings,
    private readonly onChange: (hits: readonly MaskHit[]) => void,
    private readonly onPick: (hit: MaskHit, el: HTMLElement) => void,
  ) {}

  private get opts(): SecretOptions {
    return { toggles: this.settings.toggles, allow: this.settings.allow, custom: this.settings.custom }
  }

  list(): readonly MaskHit[] {
    return this.hits
  }

  /** 설정이 바뀌면 처음부터 다시 */
  update(settings: MaskSettings): void {
    this.settings = settings
    this.clearAll()
    if (settings.enabled) this.scan()
    else this.onChange(this.hits)
  }

  /** 버퍼가 바뀌었을 때(대체 화면) · ⌘K 처럼 줄이 사라졌을 때 처음부터 */
  rescanAll(): void {
    this.clearAll()
    this.scan()
  }

  private clearAll(): void {
    // marker.dispose() 가 onDispose → drop() 으로 this.hits 를 바로 고치므로 목록을 먼저 떼어 낸 뒤 지운다
    const old = this.hits
    this.hits = []
    for (const h of old) this.disposeHit(h)
    this.scanMarker?.dispose()
    this.scanMarker = null
  }

  private disposeHit(h: HitRec): void {
    for (const d of h.decorations) d.dispose()
    for (const m of h.markers) m.dispose()
  }

  /** 새 출력이 온 줄만 훑는다 — 지난번 훑은 줄의 논리 줄 처음부터 끝까지 */
  scan(): void {
    if (this.disposed || !this.settings.enabled) return
    const buf = this.term.buffer.active
    let start = this.scanMarker && !this.scanMarker.isDisposed && this.scanMarker.line >= 0 ? this.scanMarker.line : 0
    while (start > 0 && buf.getLine(start)?.isWrapped) start--
    // 이 범위의 옛 가림은 지우고 다시 찾는다(줄이 이어 쓰였을 수 있다) — 열어 둔 것은 같은 값 · 같은 줄이면 연 채로
    const wasOpen = new Set<string>()
    const gone = this.hits.filter((h) => h.line() >= start)
    this.hits = this.hits.filter((h) => h.line() < start)
    for (const h of gone) {
      if (h.open) wasOpen.add(`${h.line()}|${h.value}`)
      this.disposeHit(h)
    }
    // 논리 줄을 '\n' 으로 이은 글 + 글자마다 칸 위치 — 줄바꿈된 긴 토큰 · 여러 줄 개인 키도 한 번에 찾는다
    let text = ''
    const at: Array<{ row: number; col: number; w: number } | null> = []
    const cell = buf.getNullCell()
    for (let row = start; row < buf.length; row++) {
      const line = buf.getLine(row)
      if (!line) continue
      if (row > start && !line.isWrapped) {
        text += '\n'
        at.push(null)
      }
      for (let col = 0; col < this.term.cols; col++) {
        const c = line.getCell(col, cell)
        if (!c) break
        const w = c.getWidth()
        if (w === 0) continue
        const chars = c.getChars() || ' '
        text += chars
        for (let k = 0; k < chars.length; k++) at.push({ row, col, w })
      }
    }
    const cursorAbs = buf.baseY + buf.cursorY
    for (const f of findSecrets(text, this.opts)) {
      // 줄마다 한 조각
      const segs: Array<{ row: number; from: number; to: number }> = []
      for (let i = f.start; i < f.end; i++) {
        const p = at[i]
        if (!p) continue
        const last = segs[segs.length - 1]
        if (last && last.row === p.row) last.to = Math.max(last.to, p.col + p.w)
        else segs.push({ row: p.row, from: p.col, to: p.col + p.w })
      }
      if (segs.length === 0) continue
      const rec: HitRec = { id: this.nextId++, kind: f.kind, value: f.value, hash: secretHash(f.value), open: false, markers: [], decorations: [], first: null, line: () => rec.markers[0]?.line ?? -1 }
      for (const [i, s] of segs.entries()) {
        const marker = this.term.registerMarker(s.row - cursorAbs)
        if (!marker) continue
        const deco = this.term.registerDecoration({ marker, x: s.from, width: s.to - s.from, layer: 'top' })
        if (!deco) {
          marker.dispose()
          continue
        }
        rec.markers.push(marker)
        rec.decorations.push(deco)
        deco.onRender((el) => this.paint(rec, el, i === 0))
        // 줄이 스크롤 버퍼 밖으로 밀려나거나 지워지면 그 가림 전체를 뺀다
        marker.onDispose(() => this.drop(rec))
      }
      if (rec.markers.length === 0) continue
      if (wasOpen.has(`${rec.line()}|${rec.value}`)) rec.open = true
      this.hits.push(rec)
    }
    this.scanMarker?.dispose()
    const lastRow = buf.length - 1
    this.scanMarker = this.term.registerMarker(lastRow - cursorAbs) ?? null
    this.onChange(this.hits)
  }

  private drop(rec: HitRec): void {
    const i = this.hits.indexOf(rec)
    if (i < 0) return
    this.hits.splice(i, 1)
    this.disposeHit(rec)
    if (!this.disposed) this.onChange(this.hits)
  }

  private paint(rec: HitRec, el: HTMLElement, first: boolean): void {
    const open = rec.open || Date.now() < this.revealUntil
    if (!el.dataset['mask']) {
      el.dataset['mask'] = String(rec.id)
      el.classList.add('secret-mask')
      el.addEventListener('mousedown', (e) => {
        e.preventDefault() // xterm 선택이 시작되지 않게
        e.stopPropagation()
      })
      el.addEventListener('click', (e) => {
        e.stopPropagation()
        this.onPick(rec, rec.first ?? el)
      })
      if (first) {
        el.tabIndex = 0
        el.setAttribute('role', 'button')
        el.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            this.toggle(rec)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            this.term.focus()
          } else if (e.metaKey && e.code === 'KeyC') {
            e.preventDefault()
            void navigator.clipboard.writeText(rec.value).catch(() => {})
          }
        })
        rec.first = el
      }
    }
    el.setAttribute('aria-label', `${rec.kind} 가림 — 누르면 메뉴`)
    el.dataset['kind'] = rec.kind
    el.dataset['open'] = String(open)
    el.style.cssText += `;pointer-events:auto;cursor:pointer;box-sizing:border-box;overflow:hidden;white-space:nowrap;font-size:11px;line-height:1;display:flex;align-items:center;padding:0 4px;border-radius:3px;${open ? OPENED : MASKED}`
    el.textContent = first && !open ? `🔒 ${rec.kind} · 보기` : ''
  }

  private repaint(rec: HitRec): void {
    for (const d of rec.decorations) if (d.element) this.paint(rec, d.element, d === rec.decorations[0])
  }

  /** 그 칸만 열기 · 다시 가리기 */
  toggle(hit: MaskHit): void {
    const rec = this.hits.find((h) => h.id === hit.id)
    if (!rec) return
    rec.open = !rec.open
    this.repaint(rec)
    this.onChange(this.hits)
  }

  /** 칩의 '모두 30초 보기' */
  revealAll(ms: number): void {
    this.revealUntil = Date.now() + ms
    for (const h of this.hits) this.repaint(h)
    clearTimeout(this.revealTimer)
    this.revealTimer = setTimeout(() => {
      for (const h of this.hits) this.repaint(h)
    }, ms + 50)
  }

  /** ⌥⌘→ · ⌥⌘← — 다음 · 이전 가린 칸으로 스크롤하고 포커스(그동안 키는 셸로 가지 않는다) */
  focusNext(step: 1 | -1): boolean {
    if (this.hits.length === 0) return false
    const sorted = [...this.hits].sort((a, b) => a.line() - b.line())
    const cur = sorted.findIndex((h) => h.first !== null && h.first === document.activeElement)
    const idx = cur < 0 ? (step > 0 ? 0 : sorted.length - 1) : (cur + step + sorted.length) % sorted.length
    const target = sorted[idx]!
    this.term.scrollToLine(Math.max(0, target.line() - Math.floor(this.term.rows / 2)))
    requestAnimationFrame(() => target.first?.focus())
    return true
  }

  /** 복사: 가린 값은 ‹가림:종류› 로 (열어 둔 칸도 — 원문은 칸 메뉴로만) */
  maskText(text: string): string {
    if (!this.settings.enabled) return text
    let out = text
    for (const h of this.hits) out = out.split(h.value).join(maskOf(h.kind))
    return redact(out, this.opts)
  }

  dispose(): void {
    this.disposed = true
    clearTimeout(this.revealTimer)
    this.clearAll()
  }
}

/** 칩 목록 — 같은 값은 하나로(×N) */
export function groupHits(hits: readonly MaskHit[]): Array<{ kind: string; hash: string; count: number; first: MaskHit }> {
  const by = new Map<string, { kind: string; hash: string; count: number; first: MaskHit }>()
  for (const h of hits) {
    const g = by.get(h.hash)
    if (g) g.count++
    else by.set(h.hash, { kind: h.kind, hash: h.hash, count: 1, first: h })
  }
  return [...by.values()]
}
