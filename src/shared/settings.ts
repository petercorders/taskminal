import { isChatPermission } from './chat'
// 설정 창의 값 — 고를 수 있는 것 · 기본값 · 저장 파일 검증. 순수 함수(renderer · main 모두 쓴다).
import { isObj } from './guards'
import { isAccel, isAppCommand } from './keymap'
import { parseQuickList } from './quick'
import { customPatternError, SECRET_TOGGLES } from './redact'
import type { CursorStyle, NotifyKind, NotifyWay, SecretAllow, Settings, SidebarDensity, StartupMode, Theme } from './types'

export const ACCENTS = [
  { color: '#5b9cf5', name: '파랑' },
  { color: '#7fd18b', name: '초록' },
  { color: '#e5a54b', name: '주황' },
  { color: '#c4a5ff', name: '보라' },
  { color: '#f28b82', name: '빨강' },
] as const

/** 고를 수 있는 터미널 글꼴 — 설치되지 않았으면 xterm 이 다음 글꼴(한글 대체 · monospace)로 그린다 */
export const FONT_FAMILIES = ['JetBrains Mono', 'D2Coding', 'SF Mono', 'Menlo'] as const
export const LONG_AFTER_CHOICES = [10, 30, 60, 300] as const
export const NOTIFY_KINDS: readonly NotifyKind[] = ['wait', 'long', 'fail', 'exit']

export const LINE_HEIGHT = { min: 1, max: 1.6 } as const
export const DIM = { min: 0.4, max: 1 } as const
export const SCROLLBACK = { min: 1000, max: 100_000 } as const

/** Settings 중 11단계에서 더한 칸 (상태 · 묶음 · 템플릿 · 글자 크기 · 셸 밖) */
export type ExtraSettings = Omit<Settings, 'statuses' | 'groups' | 'templates' | 'fontSize' | 'shell'>

export function defaultExtraSettings(): ExtraSettings {
  return {
    startup: 'restore',
    defaultCwd: '',
    defaultTemplateId: null,
    confirmQuit: true,
    dockBadge: true,
    theme: 'dark',
    accent: ACCENTS[0].color,
    fontFamily: FONT_FAMILIES[0],
    lineHeight: 1,
    dimOpacity: 0.62,
    sidebarDensity: 'two',
    shellIntegration: true,
    restoreScrollback: true,
    scrollback: 5000,
    cursorStyle: 'bar',
    cursorBlink: true,
    optionAsMeta: false,
    copyOnSelect: false,
    notify: {
      wait: { banner: true, sound: true },
      long: { banner: true, sound: false },
      fail: { banner: true, sound: false },
      exit: { banner: false, sound: false },
    },
    longAfterSec: 30,
    muteViewed: true,
    keys: {},
    maskScreen: true,
    maskKindsOff: SECRET_TOGGLES.filter((t) => !t.screenDefault).map((t) => t.id),
    secretCustom: [],
    secretAllow: [],
    updateDownload: true,
    updateSkip: '',
    quickCommands: [],
    hiddenPorts: [],
    portTipSeen: false,
    chatPermission: 'ask',
    sidebarView: 'flow',
    sidebarClosed: ['done'], // 흐름 보기에서 기본 마지막 상태(완료)는 접어 둔다 (21b 보드)
  }
}

export const MAX_SECRET_CUSTOM = 20
export const MAX_SECRET_ALLOW = 500

function parseKindsOff(v: unknown, d: string[]): string[] {
  if (!Array.isArray(v)) return d
  const ids = new Set<string>(SECRET_TOGGLES.map((t) => t.id))
  return [...new Set(v.filter((x): x is string => typeof x === 'string' && ids.has(x)))]
}

function parseCustom(v: unknown): Array<{ name: string; pattern: string }> {
  if (!Array.isArray(v)) return []
  return v
    .filter((c): c is { name: string; pattern: string } => isObj(c) && typeof c['name'] === 'string' && c['name'].trim() !== '' && typeof c['pattern'] === 'string' && customPatternError(c['pattern']) === null)
    .slice(0, MAX_SECRET_CUSTOM)
    .map((c) => ({ name: c.name, pattern: c.pattern }))
}

function parseAllow(v: unknown): SecretAllow[] {
  if (!Array.isArray(v)) return []
  const seen = new Set<string>()
  const out: SecretAllow[] = []
  for (const a of v) {
    if (!isObj(a) || typeof a['hash'] !== 'string' || !/^[0-9a-z]{1,16}$/.test(a['hash']) || seen.has(a['hash'])) continue
    seen.add(a['hash'])
    out.push({ hash: a['hash'], kind: typeof a['kind'] === 'string' ? a['kind'] : '', where: typeof a['where'] === 'string' ? a['where'] : '', at: typeof a['at'] === 'number' && Number.isFinite(a['at']) ? a['at'] : 0 })
  }
  return out.slice(-MAX_SECRET_ALLOW)
}

const oneOf = <T>(v: unknown, list: readonly T[], fallback: T): T => (list.includes(v as T) ? (v as T) : fallback)
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)
const num = (v: unknown, min: number, max: number, step: number, fallback: number): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) return fallback
  return Number((Math.round(v / step) * step).toFixed(2))
}

function parseNotify(v: unknown, d: Record<NotifyKind, NotifyWay>): Record<NotifyKind, NotifyWay> {
  const out = {} as Record<NotifyKind, NotifyWay>
  for (const kind of NOTIFY_KINDS) {
    const w = isObj(v) && isObj(v[kind]) ? v[kind] : {}
    out[kind] = { banner: bool(w['banner'], d[kind].banner), sound: bool(w['sound'], d[kind].sound) }
  }
  return out
}

function parseKeys(v: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!isObj(v)) return out
  for (const [command, accel] of Object.entries(v)) if (isAppCommand(command) && isAccel(accel)) out[command] = accel
  return out
}

function parsePorts(v: unknown): number[] {
  if (!Array.isArray(v)) return []
  return [...new Set(v.filter((p): p is number => Number.isInteger(p) && p >= 1 && p <= 65535))].slice(0, 200)
}

/** 저장 파일의 설정 칸 검증. 틀린 칸만 기본값으로 — 하나가 틀렸다고 나머지를 버리지 않는다. */
export function parseExtraSettings(v: unknown, templateIds: readonly string[]): ExtraSettings {
  const d = defaultExtraSettings()
  if (!isObj(v)) return d
  return {
    startup: oneOf<StartupMode>(v['startup'], ['restore', 'list', 'blank'], d.startup),
    defaultCwd: typeof v['defaultCwd'] === 'string' ? v['defaultCwd'] : d.defaultCwd,
    defaultTemplateId: templateIds.includes(v['defaultTemplateId'] as string) ? (v['defaultTemplateId'] as string) : null,
    confirmQuit: bool(v['confirmQuit'], d.confirmQuit),
    dockBadge: bool(v['dockBadge'], d.dockBadge),
    theme: oneOf<Theme>(v['theme'], ['dark', 'light', 'system'], d.theme),
    accent: oneOf<string>(v['accent'], ACCENTS.map((a) => a.color), d.accent),
    fontFamily: oneOf<string>(v['fontFamily'], FONT_FAMILIES, d.fontFamily),
    lineHeight: num(v['lineHeight'], LINE_HEIGHT.min, LINE_HEIGHT.max, 0.1, d.lineHeight),
    dimOpacity: num(v['dimOpacity'], DIM.min, DIM.max, 0.01, d.dimOpacity),
    sidebarDensity: oneOf<SidebarDensity>(v['sidebarDensity'], ['two', 'one'], d.sidebarDensity),
    shellIntegration: bool(v['shellIntegration'], d.shellIntegration),
    restoreScrollback: bool(v['restoreScrollback'], d.restoreScrollback),
    scrollback: Number.isInteger(v['scrollback']) && (v['scrollback'] as number) >= SCROLLBACK.min && (v['scrollback'] as number) <= SCROLLBACK.max ? (v['scrollback'] as number) : d.scrollback,
    cursorStyle: oneOf<CursorStyle>(v['cursorStyle'], ['bar', 'block', 'underline'], d.cursorStyle),
    cursorBlink: bool(v['cursorBlink'], d.cursorBlink),
    optionAsMeta: bool(v['optionAsMeta'], d.optionAsMeta),
    copyOnSelect: bool(v['copyOnSelect'], d.copyOnSelect),
    notify: parseNotify(v['notify'], d.notify),
    longAfterSec: oneOf<number>(v['longAfterSec'], LONG_AFTER_CHOICES, d.longAfterSec),
    muteViewed: bool(v['muteViewed'], d.muteViewed),
    keys: parseKeys(v['keys']),
    maskScreen: bool(v['maskScreen'], d.maskScreen),
    maskKindsOff: parseKindsOff(v['maskKindsOff'], d.maskKindsOff),
    secretCustom: parseCustom(v['secretCustom']),
    secretAllow: parseAllow(v['secretAllow']),
    updateDownload: bool(v['updateDownload'], d.updateDownload),
    updateSkip: typeof v['updateSkip'] === 'string' && /^\d+\.\d+\.\d+[\w.-]{0,40}$/.test(v['updateSkip']) ? v['updateSkip'] : d.updateSkip,
    quickCommands: parseQuickList(v['quickCommands']),
    hiddenPorts: parsePorts(v['hiddenPorts']),
    portTipSeen: bool(v['portTipSeen'], d.portTipSeen),
    chatPermission: isChatPermission(v['chatPermission']) ? v['chatPermission'] : d.chatPermission,
    sidebarView: oneOf<'flow' | 'group'>(v['sidebarView'], ['flow', 'group'], d.sidebarView),
    sidebarClosed: Array.isArray(v['sidebarClosed']) ? [...new Set(v['sidebarClosed'].filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 64))].slice(0, 64) : d.sidebarClosed,
  }
}

/** 설정 찾기: 공백으로 나눈 낱말이 모두 들어 있으면 맞음(대소문자 무시). 빈 찾기는 모두 맞음. */
export function settingsMatch(text: string, query: string): boolean {
  const t = text.toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => t.includes(w))
}
