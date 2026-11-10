// 앱 단축키 표 하나 — 메뉴(main)는 이 표로 단축키를 보여 주고, 실제 키는 renderer 가 이 표로 처리한다.
// 네이티브 메뉴 단축키로 받지 않는 이유: 키가 xterm 보다 먼저 오도록 renderer 가 capture 단계에서 잡아야 하고,
// Playwright 의 합성 키는 네이티브 메뉴 단축키를 부르지 않아 e2e 로 시험할 수 없다(2026-11-10 측정).
// 복사 · 붙여넣기 · 모두 선택 · 끝내기 · 창 닫기(⇧⌘W)는 표에 없다 — 네이티브 메뉴 role 이 맡는다.

export const SHORTCUTS = [
  { command: 'new-task', accel: 'Command+N', label: '새 일감' },
  { command: 'new-tab', accel: 'Command+T', label: '새 탭' },
  { command: 'split-right', accel: 'Command+D', label: '오른쪽으로 나누기' },
  { command: 'split-down', accel: 'Shift+Command+D', label: '아래로 나누기' },
  { command: 'close-pane', accel: 'Command+W', label: 'pane 닫기' },
  { command: 'clear', accel: 'Command+K', label: '화면 지우기' },
  { command: 'font-bigger', accel: 'Command+=', label: '글자 크게' },
  { command: 'font-smaller', accel: 'Command+-', label: '글자 작게' },
  { command: 'font-reset', accel: 'Command+0', label: '기본 글자 크기' },
  { command: 'next-tab', accel: 'Shift+Command+]', label: '다음 탭' },
  { command: 'prev-tab', accel: 'Shift+Command+[', label: '이전 탭' },
  { command: 'next-pane', accel: 'Command+]', label: '다음 pane' },
  { command: 'prev-pane', accel: 'Command+[', label: '이전 pane' },
  { command: 'next-task', accel: 'Alt+Command+Down', label: '다음 일감' },
  { command: 'prev-task', accel: 'Alt+Command+Up', label: '이전 일감' },
  ...([1, 2, 3, 4, 5, 6, 7, 8] as const).map((n) => ({ command: `tab-${n}` as const, accel: `Command+${n}`, label: `${n}번째 탭` })),
  { command: 'last-tab', accel: 'Command+9', label: '마지막 탭' },
] as const satisfies ReadonlyArray<{ command: string; accel: string; label: string }>

export type AppCommand = (typeof SHORTCUTS)[number]['command']

const COMMANDS: ReadonlySet<string> = new Set(SHORTCUTS.map((s) => s.command))
export const isAppCommand = (v: unknown): v is AppCommand => typeof v === 'string' && COMMANDS.has(v)

/** KeyboardEvent 에서 쓰는 칸만 — 시험에서 만들기 쉽게 */
export interface KeyLike {
  key: string
  code: string
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
  ctrlKey: boolean
  isComposing: boolean
}

const CODE_OF: Record<string, string> = { '[': 'BracketLeft', ']': 'BracketRight', '=': 'Equal', '-': 'Minus', Up: 'ArrowUp', Down: 'ArrowDown' }
const codeOf = (k: string): string => (/^[A-Z]$/.test(k) ? `Key${k}` : /^\d$/.test(k) ? `Digit${k}` : (CODE_OF[k] ?? k))

// "물리 키 · ⇧ · ⌥" → 명령. ⌘ 는 모든 단축키에 있으므로 뺀다.
const signature = (code: string, shift: boolean, alt: boolean) => `${code}|${shift ? 'S' : ''}${alt ? 'A' : ''}`
const BY_KEY = new Map<string, AppCommand>()
for (const s of SHORTCUTS) {
  const parts = s.accel.split('+')
  BY_KEY.set(signature(codeOf(parts.at(-1)!), parts.includes('Shift'), parts.includes('Alt')), s.command)
}
BY_KEY.set(signature('Equal', true, false), 'font-bigger') // ⌘+ (= ⇧⌘=)

/** ⌘ 단축키 → 명령. 물리 키(code)로 비교한다 — 한글 입력 상태의 ⌘T 는 key 가 'ㅅ' 라서. 조합 중 · ⌃ 함께면 null. */
export function commandForKey(ev: KeyLike): AppCommand | null {
  if (!ev.metaKey || ev.ctrlKey || ev.isComposing) return null
  return BY_KEY.get(signature(ev.code, ev.shiftKey, ev.altKey)) ?? null
}

export const FONT_MIN = 8
export const FONT_MAX = 32
export const FONT_DEFAULT = 13

export function clampFontSize(size: number): number {
  return Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(size)))
}

export function stepFontSize(size: number, how: 'bigger' | 'smaller' | 'reset'): number {
  if (how === 'reset') return FONT_DEFAULT
  return clampFontSize(size + (how === 'bigger' ? 1 : -1))
}
