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
  { command: 'find', accel: 'Command+F', label: '찾기' },
  { command: 'font-bigger', accel: 'Command+=', label: '글자 크게' },
  { command: 'font-smaller', accel: 'Command+-', label: '글자 작게' },
  { command: 'font-reset', accel: 'Command+0', label: '기본 글자 크기' },
  { command: 'next-tab', accel: 'Shift+Command+]', label: '다음 탭' },
  { command: 'prev-tab', accel: 'Shift+Command+[', label: '이전 탭' },
  { command: 'next-pane', accel: 'Command+]', label: '다음 pane' },
  { command: 'prev-pane', accel: 'Command+[', label: '이전 pane' },
  { command: 'next-task', accel: 'Alt+Command+Down', label: '다음 일감' },
  { command: 'prev-task', accel: 'Alt+Command+Up', label: '이전 일감' },
  { command: 'next-attention', accel: 'Shift+Command+A', label: '다음 확인 필요' },
  { command: 'conversation-search', accel: '', label: '대화 기록 찾기' },
  { command: 'workflows', accel: '', label: '작업 흐름' },
  { command: 'schedules', accel: '', label: '예약과 결과함' },
  { command: 'worktrees', accel: '', label: '워크트리 관리' },
  { command: 'issues', accel: '', label: '이슈 연결' },
  { command: 'overview', accel: '', label: '전체 보기' },
  { command: 'accounts', accel: '', label: '사용량·계정' },
  { command: 'workspace-files', accel: '', label: '파일 탐색' },
  { command: 'workspace-browser', accel: '', label: '내장 브라우저' },
  { command: 'git-workflow', accel: '', label: 'GitHub PR·push' },
  { command: 'palette', accel: 'Command+P', label: '명령 팔레트' },
  { command: 'settings', accel: 'Command+,', label: '설정' },
  ...([1, 2, 3, 4, 5, 6, 7, 8] as const).map((n) => ({ command: `tab-${n}` as const, accel: `Command+${n}`, label: `${n}번째 탭` })),
  { command: 'last-tab', accel: 'Command+9', label: '마지막 탭' },
  // 셸 지킴이(16단계) — ⌘Q 는 앱만 끈다(네이티브 role). 키 없는 둘은 ⌘P 로
  { command: 'quit-all', accel: 'Alt+Command+Q', label: '셸까지 모두 끝내기' },
  { command: 'host-view', accel: '', label: '셸 지킴이 보기' },
  { command: 'host-orphans', accel: '', label: '주인 없는 셸 정리' },
  // 데이터 안전(17단계) — 백업은 ⌘P 로, 화면 가리기 켜기/끄기 · 가린 칸 고르기는 키로
  { command: 'backup-restore', accel: '', label: '백업에서 되돌리기…' },
  { command: 'privacy', accel: '', label: '개인정보 설정' },
  { command: 'mask-toggle', accel: 'Shift+Command+H', label: '화면에서 비밀값 가리기 켜기/끄기' },
  { command: 'mask-next', accel: 'Alt+Command+Right', label: '다음 가린 칸' },
  { command: 'mask-prev', accel: 'Alt+Command+Left', label: '이전 가린 칸' },
  // 출시 기본기(18단계) — 키 없이 ⌘P · 앱 메뉴('업데이트 확인…')로
  { command: 'update-check', accel: '', label: '업데이트 확인' },
  { command: 'error-log', accel: '', label: '오류 기록 열기' },
  { command: 'first-run', accel: '', label: '첫 실행 안내 다시 보기' },
  // 기록과 찾기(19단계)
  { command: 'history', accel: 'Command+Y', label: '명령 기록' },
  { command: 'global-find', accel: 'Shift+Command+F', label: '모든 출력에서 찾기' },
  { command: 'history-clear', accel: '', label: '명령 기록 모두 지우기…' },
  // 대화(21단계)
  { command: 'chat-new', accel: '', label: '새 대화 (Claude)' },
  { command: 'chat-split', accel: '', label: '대화로 오른쪽 나누기' },
  { command: 'chat-new-codex', accel: '', label: '새 대화 (Codex)' },
  { command: 'chat-split-codex', accel: '', label: '대화(Codex)로 오른쪽 나누기' },
  { command: 'chat-terminal', accel: 'Shift+Command+J', label: '대화를 터미널 화면(TUI)으로' },
  // 26단계: 대화 중심 일감에서 셸을 꺼낸다 — 없으면 대화 아래에 · 있으면 그리로 · 셸에서 누르면 대화로
  { command: 'shell-toggle', accel: 'Command+J', label: '셸 꺼내기 · 대화로' },
  { command: 'sidebar-filter', accel: '', label: '사이드바에서 거르기' },
  // 변경 검토(23단계)
  { command: 'review', accel: 'Shift+Command+G', label: '변경 보기' },
  { command: 'review-commit', accel: '', label: '변경 커밋' },
  { command: 'review-reverted', accel: '', label: '되돌린 것 보기' },
  // 흐름 보기 상태 옮기기(작은 고침 2026-11-11) — 지금 일감을 이전 · 다음 상태 칸으로. ⌥⌘↑↓ 는 다음 · 이전 일감이라 ⌃⌘
  { command: 'status-next', accel: 'Control+Command+Right', label: '다음 상태로' },
  { command: 'status-prev', accel: 'Control+Command+Left', label: '이전 상태로' },
  // 보관함 · 원격 (25단계) — ⌘⌫ 는 Finder · Linear 에서 지우기라 보관에 쓰지 않는다
  { command: 'archive', accel: 'Alt+Command+A', label: '이 일감 보관하기' },
  { command: 'archive-open', accel: 'Shift+Command+E', label: '보관함' },
  { command: 'weekly', accel: '', label: '이번 주 정리' },
  // 27단계: 대화 탭은 빈 빠른 명령 띠를 숨겨 그 '+ 명령' 단추가 없다 — ⌘P 로 만든다
  { command: 'quick-new', accel: '', label: '빠른 명령 만들기…' },
  { command: 'remote-reconnect', accel: 'Command+R', label: '원격 다시 연결' },
  // 이어받기(24단계)
  { command: 'resume-show', accel: 'Alt+Command+R', label: '이어받기 요약 다시 보기' },
  { command: 'notes', accel: 'Alt+Command+M', label: '이 일감 메모 열기' },
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

/** 덮어쓸 수 있는 단축키 표의 한 줄. accel '' = 키 없음 */
export interface Shortcut {
  command: AppCommand
  accel: string
  label: string
}

// accel 의 키 이름 ↔ 물리 키(KeyboardEvent.code)
const KEY_CODE: Record<string, string> = {
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '=': 'Equal',
  '-': 'Minus',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
  ';': 'Semicolon',
  "'": 'Quote',
  '`': 'Backquote',
  '\\': 'Backslash',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
}
const CODE_KEY: Record<string, string> = Object.fromEntries(Object.entries(KEY_CODE).map(([k, c]) => [c, k]))
const codeOf = (k: string): string | null =>
  /^[A-Z]$/.test(k) ? `Key${k}` : /^\d$/.test(k) ? `Digit${k}` : (KEY_CODE[k] ?? null)
const keyOfCode = (code: string): string | null =>
  /^Key[A-Z]$/.test(code) ? code.slice(3) : /^Digit\d$/.test(code) ? code.slice(5) : (CODE_KEY[code] ?? null)

/** 'Shift+Alt+Control+Command+K' 꼴인가. '' 은 '키 없음' 이라 허용한다. ⌘ 없는 키는 받지 않는다(셸 입력과 겹친다). */
export function isAccel(v: unknown): v is string {
  if (v === '') return true
  if (typeof v !== 'string') return false
  const m = /^(Shift\+)?(Alt\+)?(Control\+)?Command\+(.+)$/.exec(v)
  return m !== null && codeOf(m[4]!) !== null
}

/** 기본 표에 바꾼 키(settings.keys)를 덮는다. 모르는 명령 · 틀린 키는 무시. */
export function shortcutTable(keys: Readonly<Record<string, string>> = {}): Shortcut[] {
  return SHORTCUTS.map((s) => {
    const k = keys[s.command]
    return { command: s.command, label: s.label, accel: k !== undefined && isAccel(k) ? k : s.accel }
  })
}
const DEFAULT_TABLE = shortcutTable()

// "물리 키 · ⇧ · ⌥ · ⌃" → 명령. ⌘ 는 모든 단축키에 있으므로 뺀다.
const signature = (code: string, shift: boolean, alt: boolean, ctrl = false) => `${code}|${shift ? 'S' : ''}${alt ? 'A' : ''}${ctrl ? 'C' : ''}`
const signatureOf = (accel: string): string | null => {
  const parts = accel.split('+')
  const code = codeOf(parts.at(-1)!)
  return code && parts.includes('Command') ? signature(code, parts.includes('Shift'), parts.includes('Alt'), parts.includes('Control')) : null
}

const indexCache = new WeakMap<readonly Shortcut[], Map<string, AppCommand>>()
function indexOf(table: readonly Shortcut[]): Map<string, AppCommand> {
  let index = indexCache.get(table)
  if (index) return index
  index = new Map()
  for (const s of table) {
    const sig = signatureOf(s.accel)
    if (sig && !index.has(sig)) index.set(sig, s.command) // 겹치면 표의 앞 명령 (설정 창이 경고한다)
  }
  // ⌘+ (= ⇧⌘=) — 글자 크게가 ⌘= 일 때만
  const plus = signature('Equal', true, false)
  if (index.get(signature('Equal', false, false)) === 'font-bigger' && !index.has(plus)) index.set(plus, 'font-bigger')
  indexCache.set(table, index)
  return index
}

/** ⌘ 단축키 → 명령. 물리 키(code)로 비교한다 — 한글 입력 상태의 ⌘T 는 key 가 'ㅅ' 라서. ⌃ 는 표에 ⌃ 가 있는 키만(⌃⌘← 상태 옮기기).
 *  한글을 조합하는 중(isComposing)이어도 ⌘ 가 눌렸으면 단축키다 — ⌘ 없는 조합 키는 처음부터 해당이 없다. */
export type PrimaryModifier = 'meta' | 'control'
const logicalKey = (ev: KeyLike, primary: PrimaryModifier): KeyLike => primary === 'meta' ? ev : {
  key: ev.key, code: ev.code, shiftKey: ev.shiftKey, altKey: ev.altKey, isComposing: ev.isComposing,
  metaKey: ev.ctrlKey, ctrlKey: ev.metaKey,
}

/** 저장된 Command는 OS의 기본 명령 키이다. 기존 별도 Control은 비Mac에서 Super로 구분한다. */
export const nativeAccel = (accel: string, primary: PrimaryModifier): string => primary === 'meta' ? accel : accel.split('+').map((key) => key === 'Command' ? 'Control' : key === 'Control' ? 'Super' : key).join('+')

export function commandForKey(event: KeyLike, table: readonly Shortcut[] = DEFAULT_TABLE, primary: PrimaryModifier = 'meta'): AppCommand | null {
  const ev = logicalKey(event, primary)
  if (!ev.metaKey) return null
  return indexOf(table).get(signature(ev.code, ev.shiftKey, ev.altKey, ev.ctrlKey)) ?? null
}

/** 설정 창에서 누른 키 → accel. ⌘ 가 없거나 꾸밈키만 · 모르는 키면 null. */
export function accelFromEvent(event: KeyLike, primary: PrimaryModifier = 'meta'): string | null {
  const ev = logicalKey(event, primary)
  if (!ev.metaKey) return null
  const k = keyOfCode(ev.code)
  if (!k) return null
  return `${ev.shiftKey ? 'Shift+' : ''}${ev.altKey ? 'Alt+' : ''}${ev.ctrlKey ? 'Control+' : ''}Command+${k}`
}

// 앱 메뉴 role 이 쓰는 키 — 바꾼 단축키가 이것과 겹치면 경고한다
const SYSTEM_KEYS: Record<string, string> = {
  'Command+C': '복사',
  'Command+V': '붙여넣기',
  'Command+X': '잘라내기',
  'Command+A': '모두 선택',
  'Command+Z': '실행 취소',
  'Shift+Command+Z': '실행 복귀',
  'Command+Q': '끝내기',
  'Command+H': '가리기',
  'Command+M': '최소화',
  'Shift+Command+W': '창 닫기',
  'Control+Command+F': '전체 화면',
  'Control+Command+Q': '화면 잠금',
  'Control+Command+D': '사전 찾아보기',
}

/** 받침이 있으면 '과', 없으면(한글이 아니어도) '와' */
const withWa = (word: string): string => {
  const c = word.charCodeAt(word.length - 1)
  const jong = c >= 0xac00 && c <= 0xd7a3 ? (c - 0xac00) % 28 : 0
  return `‘${word}’${jong ? '과' : '와'}`
}

/** 명령 → 겹침 설명. 같은 키를 쓰는 다른 명령 · 시스템 키. 키가 없으면 겹치지 않는다. */
export function keyConflicts(table: readonly Shortcut[]): Map<AppCommand, string> {
  const out = new Map<AppCommand, string>()
  const bySig = new Map<string, Shortcut[]>()
  for (const s of table) {
    const sig = signatureOf(s.accel)
    if (sig) bySig.set(sig, [...(bySig.get(sig) ?? []), s])
  }
  const system = new Map(Object.entries(SYSTEM_KEYS).map(([accel, name]) => [signatureOf(accel)!, name]))
  for (const [sig, list] of bySig) {
    for (const s of list) {
      const other = list.find((o) => o !== s)
      if (other) out.set(s.command, `${withWa(other.label)} 겹쳐요`)
      else if (system.has(sig)) out.set(s.command, `시스템 키(${system.get(sig)})와 겹쳐요`)
    }
  }
  return out
}

// 누르고 있으면(키 반복) 되풀이해도 되는 명령은 옮기기 · 글꼴뿐 — 만들거나 지우는 명령은 한 번만(셸이 여럿 뜨거나 닫히지 않게)
// 상태 옮기기도 한 번만 — 누르고 있으면 완료까지 미끄러진다(리뷰)
const ONCE: ReadonlySet<AppCommand> = new Set(['new-task', 'new-tab', 'split-right', 'split-down', 'close-pane', 'clear', 'palette', 'settings', 'status-next', 'status-prev'])
export const repeatable = (command: AppCommand): boolean => !ONCE.has(command)

const SYMBOL: Record<string, string> = { Shift: '⇧', Command: '⌘', Alt: '⌥', Control: '⌃', Up: '↑', Down: '↓', Left: '←', Right: '→', '-': '−' }
/** 'Shift+Command+D' → '⇧⌘D' (팔레트 · 화면 표시용). Alt 가 Shift 보다 앞에 있어도 macOS 순서(⌥⇧⌘)는 맞추지 않는다 */
export const accelLabel = (accel: string, primary: PrimaryModifier = 'meta'): string =>
  primary === 'control' ? nativeAccel(accel, primary).replace(/Control/g, 'Ctrl') : accel
    .split('+')
    .map((p) => SYMBOL[p] ?? p)
    .join('')

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
