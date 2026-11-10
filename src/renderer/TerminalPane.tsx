import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef } from 'react'
import { splitForWrite } from '../shared/pty'

interface Props {
  paneId: string
  cwd: string
}

/** 셸 하나를 보여 주는 pane. 셸 프로세스의 수명은 main 이 맡는다 — 여기서 마운트가 풀려도 kill 하지 않는다. */
export function TerminalPane({ paneId, cwd }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)

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
    const offExit = pty.onExit((id, exit) => {
      if (id !== paneId) return
      // 다시 띄우기 · pane 닫기는 7단계(셸 exit 시 pane 닫힘)에서.
      const how = exit.signal ? `신호 ${exit.signal}` : `exit ${exit.exitCode}`
      term.write(`\r\n\x1b[2m[셸이 끝났습니다 — ${how} · 창을 새로 고치면 새 셸이 뜹니다]\x1b[0m\r\n`)
    })
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
    term.focus()

    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      input.dispose()
      offData()
      offExit()
      term.dispose()
    }
  }, [paneId, cwd])

  return <div className="terminal-pane" ref={hostRef} data-testid={`pane-${paneId}`} />
}
