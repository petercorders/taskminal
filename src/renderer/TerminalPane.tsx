import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef } from 'react'
import { parseCommandOsc, parseNotifyOsc, parseOsc133, type ActivityEvent } from '../shared/activity'
import { cleanExit, splitForWrite } from '../shared/pty'
import { fontStack, xtermTheme, type TermSettings } from './term-settings'
import { terminals } from './terminals'

interface Props {
  paneId: string
  cwd: string
  /** 보이는 활성 pane — 숨겨진 일감 · 탭의 pane 도 마운트된 채(셸 · 화면 유지) display:none 으로 남는다 */
  active: boolean
  /** 값이 바뀌면(대화상자가 닫힘 등) 보이는 pane 이 포커스를 다시 가져간다 */
  focusSignal: number
  /** 설정 창 · ⌘= ⌘− 의 터미널 설정 — 바뀌면 바로 적용(셸 · 셸 통합은 띄울 때만) */
  settings: TermSettings
  /** 깨끗하지 않게 끝난 셸의 이유를 본 뒤 키를 눌렀다 — pane 을 닫는다 */
  onClosed(): void
  /** 셸 통합 · 벨 · 알림이 알려 준 활동 (숨은 pane 도 계속 받는다) */
  onActivity(event: ActivityEvent): void
}

/** 셸 하나를 보여 주는 pane. 셸 프로세스의 수명은 main 이 맡는다 — 여기서 마운트가 풀려도 kill 하지 않는다. */
/** 화면 폭에서 접힌 행(isWrapped)을 이어 붙인 논리 줄 — 접힌 자리에 걸친 글자도 찾게. line 은 시작 행 번호. */
function logicalLines(term: Terminal): Array<{ line: number; text: string }> {
  const buf = term.buffer.active
  const out: Array<{ line: number; text: string }> = []
  for (let i = 0; i < buf.length; i++) {
    const row = buf.getLine(i)
    if (!row) continue
    const text = row.translateToString(false) // 끝 공백을 남겨야 다음 행과 이을 때 칸이 맞는다
    const last = out[out.length - 1]
    if (row.isWrapped && last) last.text += text
    else out.push({ line: i, text })
  }
  for (const l of out) l.text = l.text.trimEnd()
  return out
}

export function TerminalPane({ paneId, cwd, active, focusSignal, settings, onClosed, onActivity }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const onClosedRef = useRef(onClosed)
  onClosedRef.current = onClosed
  const onActivityRef = useRef(onActivity)
  onActivityRef.current = onActivity
  // 셸을 띄울 때의 설정 — 그 뒤 바뀌는 것은 아래 effect 가 맞춘다
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const refitRef = useRef<() => void>(() => {})

  useEffect(() => {
    const host = hostRef.current!
    const pty = window.taskminal.pty
    const s = settingsRef.current
    const term = new Terminal({
      allowProposedApi: true, // unicode11 (한글 · 이모지 폭)
      fontFamily: fontStack(s.fontFamily),
      fontSize: s.fontSize,
      lineHeight: s.lineHeight,
      cursorStyle: s.cursorStyle, // 설정 이름이 xterm 이름과 같다
      cursorBlink: s.cursorBlink,
      scrollback: s.scrollback,
      macOptionIsMeta: s.optionAsMeta,
      theme: xtermTheme(s.theme, s.accent),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
    term.open(host)

    // 활동 신호 — 처리했다고(true) 알려 xterm 이 화면에 아무것도 하지 않게
    const emit = (ev: ActivityEvent | null) => {
      if (ev) onActivityRef.current(ev)
      return true
    }
    const oscs = [
      term.parser.registerOscHandler(133, (data) => emit(parseOsc133(data))),
      term.parser.registerOscHandler(6973, (data) => emit(parseCommandOsc(data))),
      term.parser.registerOscHandler(9, (data) => emit(parseNotifyOsc(9, data))),
      term.parser.registerOscHandler(777, (data) => emit(parseNotifyOsc(777, data))),
      term.onBell(() => onActivityRef.current({ type: 'bell' })),
    ]

    let size = { cols: 0, rows: 0 }
    const fitNow = (): boolean => {
      fit.fit()
      host.dataset['cols'] = String(term.cols)
      host.dataset['rows'] = String(term.rows)
      const changed = term.cols !== size.cols || term.rows !== size.rows
      size = { cols: term.cols, rows: term.rows }
      return changed
    }

    const offData = pty.onData((id, data) => {
      if (id === paneId) term.write(data)
    })
    // 깨끗하게 끝나면(exit 0) App 이 pane 을 바로 닫는다. 아니면 이유를 보여 주고 다음 키에 닫는다.
    let ended = false
    const offExit = pty.onExit((id, exit) => {
      if (id !== paneId || cleanExit(exit)) return
      ended = true
      const how = exit.signal ? `신호 ${exit.signal}` : `exit ${exit.exitCode}`
      term.write(`\r\n\x1b[2m[셸이 끝났습니다 — ${how} · 아무 키나 누르면 이 pane 을 닫습니다]\x1b[0m\r\n`)
    })
    // 큰 붙여넣기는 main 의 입력 상한(1MB) 이하로 나눠 보낸다 — 넘으면 main 이 통째로 버린다.
    // 선택하면 바로 복사 (설정) — 끄면 ⌘C
    const selection = term.onSelectionChange(() => {
      if (settingsRef.current.copyOnSelect && term.hasSelection()) void navigator.clipboard.writeText(term.getSelection()).catch(() => {})
    })
    const input = term.onData((data) => {
      if (ended) return onClosedRef.current()
      for (const part of splitForWrite(data)) pty.write(paneId, part)
    })

    // 실제 크기로 맞춘 뒤에 셸을 띄운다 — 첫 프롬프트가 80×24 로 그려졌다 줄바뀜하지 않게.
    fitNow()
    pty.spawn(paneId, { cwd, cols: term.cols, rows: term.rows, shell: s.shell, integration: s.integration }).catch((error: unknown) => {
      term.write(`\x1b[31m셸을 띄우지 못했습니다: ${String(error)}\x1b[0m\r\n`)
    })

    // 창 가장자리를 끄는 동안 프레임마다 SIGWINCH 를 보내지 않게, 한 프레임에 한 번만 맞춘다.
    const refit = () => {
      if (fitNow()) pty.resize(paneId, term.cols, term.rows)
    }
    let frame = 0
    const observer = new ResizeObserver(() => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        refit()
      })
    })
    observer.observe(host)
    termRef.current = term
    refitRef.current = refit
    terminals.set(paneId, {
      clear: () => term.clear(),
      search: (query, limit) => {
        const q = query.toLowerCase()
        const lines = logicalLines(term)
        const found: Array<{ line: number; text: string }> = []
        for (let i = lines.length - 1; i >= 0 && found.length < limit; i--) {
          if (lines[i]!.text.toLowerCase().includes(q)) found.push(lines[i]!)
        }
        return found
      },
      reveal: (line, query) => {
        // 찾은 뒤 스크롤 버퍼가 넘쳐 옛 줄이 버려지면 줄 번호가 밀린다 → 그 번호에서 가장 가까운, 찾기 글자가 든 줄로
        const q = query.toLowerCase()
        let best: { line: number; at: number } | null = null
        for (const l of logicalLines(term)) {
          const at = l.text.toLowerCase().indexOf(q)
          if (at >= 0 && (!best || Math.abs(l.line - line) < Math.abs(best.line - line))) best = { line: l.line, at }
        }
        if (!best) return
        // 접힌 줄이면 맞은 자리가 몇째 행인지 (넓은 글자(한글)는 칸이 둘이라 어긋날 수 있다)
        const row = best.line + Math.floor(best.at / term.cols)
        term.scrollToLine(Math.max(0, row - Math.floor(term.rows / 2)))
        term.select(best.at % term.cols, row, query.length)
      },
    })

    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      input.dispose()
      selection.dispose()
      for (const d of oscs) d.dispose()
      offData()
      offExit()
      terminals.delete(paneId)
      refitRef.current = () => {}
      termRef.current = null
      term.dispose()
    }
  }, [paneId, cwd])

  // 설정이 바뀌면 바로. 글꼴 · 크기 · 줄 간격은 칸 수를 바꾼다 → 셸에도 새 크기를 알린다 (숨은 pane 은 다시 보일 때 ResizeObserver 가 맞춘다)
  useEffect(() => {
    const term = termRef.current
    const host = hostRef.current
    if (!term || !host) return
    const o = term.options
    const family = fontStack(settings.fontFamily)
    const resize = o.fontSize !== settings.fontSize || o.lineHeight !== settings.lineHeight || o.fontFamily !== family
    o.fontSize = settings.fontSize
    o.lineHeight = settings.lineHeight
    o.fontFamily = family
    o.cursorStyle = settings.cursorStyle
    o.cursorBlink = settings.cursorBlink
    o.scrollback = settings.scrollback
    o.macOptionIsMeta = settings.optionAsMeta
    o.theme = xtermTheme(settings.theme, settings.accent)
    // e2e 가 xterm 안을 들여다보지 않고 실제로 xterm 에 들어간 값을 읽게 (설정값이 아니라 o 에서)
    Object.assign(host.dataset, {
      fontFamily: o.fontFamily === family ? settings.fontFamily : '',
      lineHeight: String(o.lineHeight),
      cursorStyle: String(o.cursorStyle),
      cursorBlink: String(o.cursorBlink),
      scrollback: String(o.scrollback),
      optionMeta: String(o.macOptionIsMeta),
      theme: o.theme?.background === '#ffffff' ? 'light' : 'dark',
    })
    if (resize) refitRef.current()
  }, [settings])

  // 다시 보이면 포커스. 숨겨진 동안(display:none)은 fit 이 크기를 못 재 아무것도 안 하고,
  // 다시 보일 때 ResizeObserver 가 0 → 실제 크기 변화를 보고 맞춘다.
  useEffect(() => {
    if (active) termRef.current?.focus()
  }, [active, focusSignal])

  return <div className="terminal-pane" ref={hostRef} data-testid={`pane-${paneId}`} />
}
