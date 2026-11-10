import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef } from 'react'
import { splitForWrite } from '../shared/pty'

interface Props {
  paneId: string
  cwd: string
  /** 보이는 활성 pane — 숨겨진 일감 · 탭의 pane 도 마운트된 채(셸 · 화면 유지) display:none 으로 남는다 */
  active: boolean
  /** 값이 바뀌면(대화상자가 닫힘 등) 보이는 pane 이 포커스를 다시 가져간다 */
  focusSignal: number
}

/** 셸 하나를 보여 주는 pane. 셸 프로세스의 수명은 main 이 맡는다 — 여기서 마운트가 풀려도 kill 하지 않는다. */
export function TerminalPane({ paneId, cwd, active, focusSignal }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)

  useEffect(() => {
    const host = hostRef.current!
    const pty = window.taskminal.pty
    const term = new Terminal({
      allowProposedApi: true, // unicode11 (한글 · 이모지 폭)
      fontFamily: "'JetBrains Mono', Menlo, Monaco, monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: { background: '#0e0f11', foreground: '#e6e7ea', cursor: '#5b9cf5', selectionBackground: '#5b9cf540' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
    term.open(host)

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
    // 셸이 스스로 끝나면 App 이 pane 을 닫는다(pane/exited) — 여기서는 따로 할 일이 없다.
    // 큰 붙여넣기는 main 의 입력 상한(1MB) 이하로 나눠 보낸다 — 넘으면 main 이 통째로 버린다.
    const input = term.onData((data) => {
      for (const part of splitForWrite(data)) pty.write(paneId, part)
    })

    // 실제 크기로 맞춘 뒤에 셸을 띄운다 — 첫 프롬프트가 80×24 로 그려졌다 줄바뀜하지 않게.
    fitNow()
    pty.spawn(paneId, { cwd, cols: term.cols, rows: term.rows }).catch((error: unknown) => {
      term.write(`\x1b[31m셸을 띄우지 못했습니다: ${String(error)}\x1b[0m\r\n`)
    })

    // 창 가장자리를 끄는 동안 프레임마다 SIGWINCH 를 보내지 않게, 한 프레임에 한 번만 맞춘다.
    let frame = 0
    const observer = new ResizeObserver(() => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        if (fitNow()) pty.resize(paneId, term.cols, term.rows)
      })
    })
    observer.observe(host)
    termRef.current = term

    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      input.dispose()
      offData()
      termRef.current = null
      term.dispose()
    }
  }, [paneId, cwd])

  // 다시 보이면 포커스. 숨겨진 동안(display:none)은 fit 이 크기를 못 재 아무것도 안 하고,
  // 다시 보일 때 ResizeObserver 가 0 → 실제 크기 변화를 보고 맞춘다.
  useEffect(() => {
    if (active) termRef.current?.focus()
  }, [active, focusSignal])

  return <div className="terminal-pane" ref={hostRef} data-testid={`pane-${paneId}`} />
}
