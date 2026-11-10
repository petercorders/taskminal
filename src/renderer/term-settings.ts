// 터미널(xterm) 하나에 주는 설정 — App 이 Settings 에서 골라 만든다.
import type { ITheme } from '@xterm/xterm'
import type { CursorStyle, Settings } from '../shared/types'

export interface TermSettings {
  fontFamily: string
  fontSize: number
  lineHeight: number
  cursorStyle: CursorStyle
  cursorBlink: boolean
  scrollback: number
  optionAsMeta: boolean
  copyOnSelect: boolean
  /** 실제로 보이는 테마 (system 을 푼 값) */
  theme: 'dark' | 'light'
  accent: string
  /** 띄울 때만 쓰는 값 — 바꾸면 새 터미널부터 */
  shell: string | null
  integration: boolean
}

export function termSettings(s: Settings, theme: 'dark' | 'light'): TermSettings {
  return {
    fontFamily: s.fontFamily,
    fontSize: s.fontSize,
    lineHeight: s.lineHeight,
    cursorStyle: s.cursorStyle,
    cursorBlink: s.cursorBlink,
    scrollback: s.scrollback,
    optionAsMeta: s.optionAsMeta,
    copyOnSelect: s.copyOnSelect,
    theme,
    accent: s.accent,
    shell: s.shell,
    integration: s.shellIntegration,
  }
}

// 고른 글꼴이 없거나 한글이 없으면 D2Coding → Apple SD Gothic Neo(한글) → monospace 로 (지정하지 않으면 AppleGothic 이 잡힌다)
export const fontStack = (family: string) => `'${family}', D2Coding, Menlo, 'Apple SD Gothic Neo', monospace`

export function xtermTheme(theme: 'dark' | 'light', accent: string): ITheme {
  return theme === 'dark'
    ? { background: '#0e0f11', foreground: '#e6e7ea', cursor: accent, cursorAccent: '#0e0f11', selectionBackground: `${accent}40` }
    : {
        background: '#ffffff',
        foreground: '#1f2328',
        cursor: accent,
        cursorAccent: '#ffffff',
        selectionBackground: `${accent}40`,
        // 흰 바탕에서 안 보이는 기본 색만 짙게
        black: '#1f2328',
        white: '#6e7781',
        brightWhite: '#8c959f',
        yellow: '#9a6700',
        brightYellow: '#7d4e00',
      }
}
