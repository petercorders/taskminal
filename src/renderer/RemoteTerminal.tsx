import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { RemoteApi } from '../shared/remote-workspace'
import '@xterm/xterm/css/xterm.css'
import './RemoteTerminal.css'

// Locks survive a panel remount, but raw output and input never leave its lifetime.
const reads = new Map<string, Promise<unknown>>()
const MAX_INPUT = 64 * 1024
interface Input { requestId: string; data: string }

export function RemoteTerminal({ api, connection, workspace, session }: {
  api: RemoteApi; connection: string; workspace: string; session: string
}) {
  const host = useRef<HTMLDivElement>(null)
  const retry = useRef<() => void>(() => {})
  const [notice, setNotice] = useState('')
  const [failure, setFailure] = useState('')
  const [readFailure, setReadFailure] = useState('')
  const [resizeFailure, setResizeFailure] = useState('')
  const [uncertain, setUncertain] = useState('')
  const [size, setSize] = useState('')
  const [pendingInput, setPendingInput] = useState(0)

  useEffect(() => {
    const element = host.current!
    const term = new Terminal({
      cursorBlink: true, fontSize: 13, scrollback: 3000, screenReaderMode: true,
      theme: { background: '#15171c', foreground: '#e6e8ed' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(element)
    term.textarea?.setAttribute('aria-label', '원격 터미널 키보드 입력')
    // Keep terminal control keys inside the terminal rather than triggering pane shortcuts.
    const stopKeys = (event: KeyboardEvent) => event.stopPropagation()
    element.addEventListener('keydown', stopKeys)
    let alive = true, reading = false, sending = false, paused = false, exited = false, drained = false
    let offset = 0, queued = 0
    let epoch: string | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    let resizing = false, pendingSize: { cols: number; rows: number } | undefined
    let lastSize = ''
    let finishWrite: (() => void) | undefined
    const queue: Input[] = []
    const key = JSON.stringify([connection, workspace, session])
    setNotice(''); setFailure(''); setReadFailure(''); setResizeFailure(''); setUncertain(''); setSize(''); setPendingInput(0)
    const visible = () => alive && !document.hidden && element.getClientRects().length > 0

    const send = async () => {
      if (!visible() || sending || paused || exited) return
      sending = true
      try {
        while (alive && visible() && !paused && queue.length) {
          const item = queue[0]!
          try {
            await api.write(connection, workspace, session, item)
            if (!alive) return
            queue.shift(); queued -= item.data.length
            setPendingInput(queued)
            setFailure('')
          } catch {
            if (!alive) return
            // The server may have accepted it. Retain this exact request ID and data.
            paused = true
            setUncertain(item.requestId)
          }
        }
      } finally { sending = false }
    }
    retry.current = () => {
      if (!alive || !paused) return
      paused = false; setUncertain(''); void send()
    }
    const dataSubscription = term.onData((data) => {
      if (!visible() || exited || paused) return
      if (queued + data.length > MAX_INPUT) {
        setFailure('입력 대기열이 가득 차 새 입력을 보내지 않았어요. 처리가 끝난 뒤 다시 입력하세요.')
        return
      }
      queue.push({ requestId: crypto.randomUUID(), data }); queued += data.length
      setPendingInput(queued)
      void send()
    })

    const resize = async () => {
      if (!visible() || exited || resizing || !pendingSize) return
      resizing = true
      const next = pendingSize
      pendingSize = undefined
      try {
        await api.resize(connection, workspace, session, next.cols, next.rows)
        if (alive) { lastSize = `${next.cols} × ${next.rows}`; setSize(lastSize); setResizeFailure('') }
      } catch {
        if (alive) { pendingSize ??= next; setResizeFailure('터미널 크기를 전달하지 못했어요. 연결을 확인해 주세요.') }
      } finally {
        resizing = false
        if (visible() && pendingSize) resizeTimer = setTimeout(() => { void resize() }, 500)
      }
    }
    const measure = () => {
      if (!visible()) return
      fit.fit()
      if (term.cols > 500 || term.rows > 300) term.resize(Math.min(500, term.cols), Math.min(300, term.rows))
      if (`${term.cols} × ${term.rows}` !== lastSize) pendingSize = { cols: term.cols, rows: term.rows }
      void resize()
    }
    const read = async () => {
      if (!visible() || reading) return
      reading = true
      try {
        const pending = reads.get(key)
        if (pending) { await pending; return }
        const operation = api.stream(connection, workspace, session, offset)
        reads.set(key, operation)
        try {
          const result = await operation
          if (!alive) return
          setReadFailure('')
          if (epoch !== undefined && epoch !== result.epoch) {
            epoch = result.epoch
            offset = 0
            term.reset()
            setNotice('서버에 다시 연결했어요. 같은 셸의 보관 출력부터 화면을 다시 구성합니다.')
            return
          }
          epoch = result.epoch
          drained = result.exited !== undefined && result.data.length === 0
          if (offset < result.start) {
            term.reset()
            setNotice('보관 범위를 지난 출력이 있어 화면을 초기화했어요. 남아 있는 출력부터 표시합니다.')
          }
          if (result.offset > offset || offset < result.start) {
            // Advance only after xterm consumes the chunk; no repeated writes on a slow parser.
            await new Promise<void>((resolve) => {
              finishWrite = resolve
              term.write(result.data, () => { finishWrite = undefined; resolve() })
            })
            if (!alive) return
            offset = result.offset
          }
          if (result.exited !== undefined) { exited = true; setNotice(`셸이 끝났어요. 종료 코드 ${result.exited}`) }
        } finally { if (reads.get(key) === operation) reads.delete(key) }
      } catch { if (alive) setReadFailure('실시간 출력을 읽지 못했어요. 연결이 돌아오면 같은 세션을 이어 읽습니다.') }
      finally {
        reading = false
        if (visible() && !drained) timer = setTimeout(() => { void read() }, 150)
      }
    }
    const resume = () => {
      clearTimeout(timer)
      if (visible()) { measure(); void read(); void send() }
    }
    const observer = new ResizeObserver(resume)
    observer.observe(element)
    document.addEventListener('visibilitychange', resume)
    resume()
    return () => {
      alive = false
      clearTimeout(timer); clearTimeout(resizeTimer)
      observer.disconnect()
      document.removeEventListener('visibilitychange', resume)
      element.removeEventListener('keydown', stopKeys)
      dataSubscription.dispose()
      retry.current = () => {}
      finishWrite?.()
      term.dispose()
    }
  }, [api, connection, workspace, session])

  return <div className="remote-live-terminal">
    <p className="dim small">실시간 터미널 · 원문 출력은 이 화면의 메모리에만 유지됩니다. 화면을 닫으면 전달 대기 중 입력은 버립니다. {size && <span data-testid="remote-terminal-size">{size}</span>}</p>
    <div ref={host} className="remote-xterm" data-testid="remote-xterm" aria-label="원격 실시간 터미널" />
    {pendingInput > 0 && <p role="status">입력 전달 대기 {pendingInput}자</p>}
    {notice && <p role="status">{notice}</p>}
    {failure && <p role="alert">{failure}</p>}
    {readFailure && <p role="alert">{readFailure}</p>}
    {resizeFailure && <p role="alert">{resizeFailure}</p>}
    {uncertain && <div className="remote-card" role="alert"><p>입력 결과를 확인하지 못했어요. 추가 입력을 멈췄습니다. 요청 번호: {uncertain}</p><button className="button" onClick={() => retry.current()}>같은 요청 번호로 입력 확인·재시도</button></div>}
  </div>
}
