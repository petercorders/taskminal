import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef, useState } from 'react'
import { groupHits, SecretMasker, type MaskHit, type MaskSettings } from './secret-mask'
import { parseCommandOsc, parseNotifyOsc, parseOsc133, type ActivityEvent } from '../shared/activity'
import { parseOsc7 } from '../shared/cwd'
import { linkToOpen } from '../shared/links'
import { cleanExit, splitForWrite } from '../shared/pty'
import { webglBlock } from '../shared/renderer'
import { restoreBanner, saveLines } from '../shared/scrollback'
import { fontStack, xtermTheme, type TermSettings } from './term-settings'
import { dirtyPanes, findingPanes, osc7Panes, restoredPanes, restoredWithText, runtime, webgl } from './runtime'
import { terminals } from './terminals'

interface Props {
  paneId: string
  cwd: string
  /** 보이는 활성 pane — 숨겨진 일감 · 탭의 pane 도 마운트된 채(셸 · 화면 유지) display:none 으로 남는다 */
  active: boolean
  /** 일감 · 탭이 보이는 중 — 그동안만 WebGL (15e) */
  visible: boolean
  /** 값이 바뀌면(대화상자가 닫힘 등) 보이는 pane 이 포커스를 다시 가져간다 */
  focusSignal: number
  /** 설정 창 · ⌘= ⌘− 의 터미널 설정 — 바뀌면 바로 적용(셸 · 셸 통합은 띄울 때만) */
  settings: TermSettings
  /** 깨끗하지 않게 끝난 셸의 이유를 본 뒤 키를 눌렀다 — pane 을 닫는다 */
  onClosed(): void
  /** 셸 통합 · 벨 · 알림이 알려 준 활동 (숨은 pane 도 계속 받는다) */
  onActivity(event: ActivityEvent): void
  /** 템플릿의 시작 명령 — 셸이 처음 뜰 때 한 번 보낸다 (pane.pendingCommand) */
  startCommand?: string | undefined
  /** 시작 명령을 보냈다 — 저장된 pendingCommand 를 지워 다시 돌지 않게 */
  onStartSent?(): void
  /** 셸이 OSC 7 로 알려 준 지금 폴더 (셸 안의 cd) */
  onCwd?(cwd: string): void
  /** 화면에서 비밀값 가리기 (17단계) */
  mask?: MaskSettings | undefined
  /** 칸 메뉴 '비밀값 아님' — 그 값(해시)을 다시 가리지 않기 */
  onAllow?(hit: { hash: string; kind: string }): void
}

/** 가린 칸 안내를 이미 본 pane — 이번 실행에서 pane 마다 한 번 */
const maskNoticed = new Set<string>()
/** 새 출력 뒤 훑기까지 — 출력이 몰려도 한 번 */
const MASK_SCAN_MS = 200
/** 칩 '모두 30초 보기' */
const REVEAL_ALL_MS = 30_000
const NO_MASK: MaskSettings = { enabled: false, toggles: new Set(), allow: new Set(), custom: [] }

/** 셸 통합이 꺼져 있거나 첫 프롬프트 신호가 오지 않을 때 시작 명령을 보내는 시각 */
export const START_FALLBACK_MS = 4000
// 시작 명령을 보낸 pane — 개발 모드 StrictMode 의 두 번 마운트 · 다시 마운트가 두 번 보내지 않게 (상태는 dispatch 뒤에야 바뀐다)
const sentStarts = new Set<string>()

/** ⌘F (15d): 대소문자 무시 · 맞은 곳 칠하기(결과 수 이벤트는 decorations 가 있어야 온다). 색은 #RRGGBB 만 — '입력 기다림' 노랑 계열 */
const FIND_OPTIONS = {
  caseSensitive: false,
  decorations: {
    matchBackground: '#4a3f1f',
    activeMatchBackground: '#a8741a',
    matchOverviewRuler: '#e5a54b',
    activeMatchColorOverviewRuler: '#f0b866',
  },
} as const

/** 터미널 링크(글 속 주소 · OSC 8): ⌘+클릭 · http(s) 만 main 에 넘긴다 (main 도 다시 거른다) */
const openLink = (event: MouseEvent, uri: string): void => {
  const url = linkToOpen(uri, event.metaKey)
  if (url) window.taskminal.openLink(url)
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

export function TerminalPane({ paneId, cwd, active, visible, focusSignal, settings, onClosed, onActivity, startCommand, onStartSent, onCwd, mask = NO_MASK, onAllow }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const onClosedRef = useRef(onClosed)
  onClosedRef.current = onClosed
  const onActivityRef = useRef(onActivity)
  onActivityRef.current = onActivity
  const startRef = useRef({ command: startCommand, onSent: onStartSent })
  startRef.current = { command: startCommand, onSent: onStartSent }
  // 셸을 띄울 때의 설정 — 그 뒤 바뀌는 것은 아래 effect 가 맞춘다
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  // 폴더는 셸을 띄울 때만 쓴다 — effect 의존성에 넣으면 cd(OSC 7 → pane.cwd)마다 터미널이 통째로 다시 만들어진다
  const cwdRef = useRef(cwd)
  cwdRef.current = cwd
  const onCwdRef = useRef(onCwd)
  onCwdRef.current = onCwd
  const refitRef = useRef<() => void>(() => {})
  // 화면 가리기 (17단계)
  const maskRef = useRef(mask)
  maskRef.current = mask
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const maskerRef = useRef<SecretMasker | null>(null)
  const scanPending = useRef(false)
  const [hits, setHits] = useState<readonly MaskHit[]>([])
  const [maskMenu, setMaskMenu] = useState<{ hit: MaskHit; x: number; y: number } | null>(null)
  const [maskList, setMaskList] = useState(false)
  const [maskNotice, setMaskNotice] = useState(false)

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
      // OSC 8 링크 — 글 속 주소(WebLinksAddon)와 같이 ⌘+클릭만, http(s) 만
      linkHandler: { activate: openLink, allowNonHttpProtocols: false },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new Unicode11Addon())
    term.loadAddon(new WebLinksAddon(openLink))
    const searcher = new SearchAddon()
    term.loadAddon(searcher)
    const serializer = new SerializeAddon()
    term.loadAddon(serializer)
    term.unicode.activeVersion = '11'
    term.open(host)

    // 화면 가리기: 새 출력이 온 줄만 훑는다. 숨은 pane 은 보일 때(아래 effect) — 안 보일 때 돌지 않게
    const masker = new SecretMasker(
      term,
      maskRef.current,
      (list) => {
        setHits([...list])
        if (list.length > 0 && !maskNoticed.has(paneId) && visibleRef.current) {
          maskNoticed.add(paneId)
          setMaskNotice(true)
        }
      },
      (hit, el) => {
        const slot = host.parentElement
        const r = el.getBoundingClientRect()
        const base = slot?.getBoundingClientRect() ?? { left: 0, top: 0 }
        setMaskMenu({ hit, x: r.left - base.left, y: r.bottom - base.top + 2 })
      },
    )
    maskerRef.current = masker
    let scanTimer: ReturnType<typeof setTimeout> | undefined
    const scanSoon = () => {
      if (!maskRef.current.enabled) return
      clearTimeout(scanTimer)
      scanTimer = setTimeout(() => {
        if (visibleRef.current) masker.scan()
        else scanPending.current = true
      }, MASK_SCAN_MS)
    }
    const masking = [
      term.onWriteParsed(scanSoon),
      // 대체 화면(vim · less)으로 오가면 마커가 다른 버퍼라 처음부터
      term.buffer.onBufferChange(() => masker.rescanAll()),
    ]
    // ⌘C · 메뉴의 복사: 선택 안의 가린 값은 ‹가림:종류› 로 (Warp 와 같음) — xterm 의 복사보다 먼저(capture)
    const onCopy = (e: ClipboardEvent) => {
      if (!maskRef.current.enabled || !term.hasSelection()) return
      const raw = term.getSelection()
      const masked = masker.maskText(raw)
      if (masked === raw) return
      e.clipboardData?.setData('text/plain', masked)
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    host.addEventListener('copy', onCopy, true)

    // 시작 명령: 첫 프롬프트(셸 통합의 OSC 133;A — 사용자 .zshrc 를 다 읽은 뒤)에 한 번. 신호가 없으면 START_FALLBACK_MS 뒤에
    // (셸은 그 전에 온 입력도 줄 버퍼에 두었다 읽는다). 셸을 못 띄웠으면 보내지 않고 남겨 둔다.
    // 신호 없이 기다리는 동안 사용자가 이미 치기 시작했으면 친 글 뒤에 붙이지 않는다 — 남겨 두고 다음 프롬프트 신호 · 다음 실행에.
    let startTimer: ReturnType<typeof setTimeout> | undefined
    let typed = false
    let disposed = false
    // 셸 지킴이에 다시 붙었는지 답을 받기 전에는 보내지 않는다 — 되돌려 받은 화면 · 프롬프트 신호가 시작 명령을 부르지 않게 (16단계)
    let startBlocked = true
    const sendStart = () => {
      const { command, onSent } = startRef.current
      clearTimeout(startTimer)
      if (startBlocked || !command || sentStarts.has(paneId)) return
      sentStarts.add(paneId)
      pty.write(paneId, command + '\r')
      onSent?.()
    }

    // 활동 신호 — 처리했다고(true) 알려 xterm 이 화면에 아무것도 하지 않게
    const emit = (ev: ActivityEvent | null) => {
      if (ev) onActivityRef.current(ev)
      if (ev?.type === 'prompt') sendStart()
      return true
    }
    const oscs = [
      term.parser.registerOscHandler(133, (data) => emit(parseOsc133(data))),
      term.parser.registerOscHandler(6973, (data) => emit(parseCommandOsc(data))),
      term.parser.registerOscHandler(9, (data) => emit(parseNotifyOsc(9, data))),
      term.parser.registerOscHandler(777, (data) => emit(parseNotifyOsc(777, data))),
      term.onBell(() => onActivityRef.current({ type: 'bell' })),
      // 지금 폴더 — 다른 호스트(ssh 안의 셸)가 보낸 것은 버린다
      term.parser.registerOscHandler(7, (data) => {
        const path = parseOsc7(data, runtime.host)
        if (path) {
          osc7Panes.add(paneId)
          onCwdRef.current?.(path)
        }
        return true
      }),
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
      if (id !== paneId) return
      term.write(data)
      dirtyPanes.add(paneId)
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
      if (settingsRef.current.copyOnSelect && !findingPanes.has(paneId) && term.hasSelection()) void navigator.clipboard.writeText(masker.maskText(term.getSelection())).catch(() => {})
    })
    // 키를 친 것만 센다 — onData 는 터미널 질의에 xterm 이 스스로 내는 답에도 불린다
    const keys = term.onKey(() => (typed = true))
    const input = term.onData((data) => {
      if (ended) return onClosedRef.current()
      for (const part of splitForWrite(data)) pty.write(paneId, part)
    })

    // 실제 크기로 맞춘 뒤에 셸을 띄운다 — 첫 프롬프트가 80×24 로 그려졌다 줄바뀜하지 않게.
    fitNow()
    const spawn = () => {
      if (disposed) return
      pty.spawn(paneId, { cwd: cwdRef.current, cols: term.cols, rows: term.rows, shell: s.shell, integration: s.integration }).then(
        () => {
          // 셸이 뜨기 전에 이 pane 이 사라졌으면(빠른 닫기 · 다시 그리기) 타이머를 걸지 않는다 — 정리 함수는 이미 돌았다
          if (disposed || !startRef.current.command) return
          startTimer = setTimeout(() => typed || sendStart(), s.integration ? START_FALLBACK_MS : 0)
        },
        (error: unknown) => {
          term.write(`\x1b[31m셸을 띄우지 못했습니다: ${String(error)}\x1b[0m\r\n`)
        },
      )
    }
    // 이전 출력 되살리기 — 셸보다 먼저 쓰고, 이번 실행에서 pane 당 한 번. 되살린 글에는 OSC 가 없어 시작 명령 · 활동 신호가 돌지 않는다.
    // 읽기 실패 · 깨진 파일이면 되살리지 않고 셸만 띄운다.
    const restoreThenSpawn = () => {
      startBlocked = false
      if (s.restoreScrollback && !restoredPanes.has(paneId)) {
        window.taskminal.scrollback.load(paneId).then(
          (saved) => {
            if (disposed) return // 다시 마운트된 쪽이 되살린다
            restoredPanes.add(paneId)
            if (saved && saved.text) {
              term.write(saved.text + restoreBanner(saved.savedAt))
              restoredWithText.add(paneId)
            }
            spawn()
          },
          () => spawn(),
        )
      } else {
        spawn()
      }
    }
    // 16단계: 셸 지킴이에 이 pane 의 셸이 남아 있으면(앱을 껐다 켬 · 창 다시 읽기) 다시 붙는다 — 화면은 main 이 onData 로 먼저 보냈다.
    // 붙으면 파일 되살리기 · 시작 명령은 하지 않는다(이미 돈 셸). 셸의 크기를 지금 화면에 맞춘다.
    pty.attach(paneId).then(
      (r) => {
        if (disposed) return
        if (!r.attached) return restoreThenSpawn()
        restoredPanes.add(paneId)
        pty.resize(paneId, term.cols, term.rows)
      },
      () => {
        if (!disposed) restoreThenSpawn()
      },
    )

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
      clear: () => {
        term.clear()
        masker.rescanAll()
      },
      maskFocus: (step) => masker.focusNext(step),
      // 전체 화면 프로그램(vim · less · Claude)의 화면 · 커서 모드는 빼고 일반 화면만
      serialize: () => serializer.serialize({ scrollback: saveLines(settingsRef.current.scrollback), excludeAltBuffer: true, excludeModes: true }),
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
      find: {
        next: (query, incremental = false) => void searcher.findNext(query, { ...FIND_OPTIONS, incremental }),
        prev: (query) => void searcher.findPrevious(query, FIND_OPTIONS),
        clear: () => {
          if (disposed) return // pane 이 먼저 닫혔다(정리 순서) — 지울 것도 없다
          searcher.clearDecorations()
          term.clearSelection()
        },
        onResults: (listener) => {
          const d = searcher.onDidChangeResults((e) => listener(e.resultIndex, e.resultCount))
          return () => d.dispose()
        },
      },
    })

    return () => {
      disposed = true
      clearTimeout(scanTimer)
      for (const d of masking) d.dispose()
      host.removeEventListener('copy', onCopy, true)
      masker.dispose()
      maskerRef.current = null
      observer.disconnect()
      cancelAnimationFrame(frame)
      clearTimeout(startTimer)
      input.dispose()
      keys.dispose()
      selection.dispose()
      for (const d of oscs) d.dispose()
      offData()
      offExit()
      terminals.delete(paneId)
      webgl.failures.delete(paneId) // 닫힌 pane 의 실패 수는 남기지 않는다
      refitRef.current = () => {}
      termRef.current = null
      term.dispose()
    }
  }, [paneId])

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

  // 보이는 동안만 WebGL (15e) — 숨으면 놓아 창당 컨텍스트 한도를 넘지 않게. 실패하면 DOM 으로 남는다.
  // term 이 새로 만들어지면(paneId) 다시 판단. 정리(숨음 · 해제)에서 놓고 수를 줄인다.
  // glTry: 컨텍스트를 잃은 뒤 · 상한으로 기다리다 자리가 났을 때 다시 판단 (15e 리뷰)
  const [glTry, setGlTry] = useState(0)
  useEffect(() => {
    const term = termRef.current
    const host = hostRef.current
    if (!term || !host) return
    host.dataset['renderer'] = 'dom'
    const retry = () => setGlTry((n) => n + 1)
    const fail = () => webgl.failures.set(paneId, (webgl.failures.get(paneId) ?? 0) + 1)
    const block = webglBlock({ mode: runtime.renderer, visible, inUse: webgl.inUse, failures: webgl.failures.get(paneId) ?? 0 })
    if (block === 'cap') {
      webgl.waiting.add(retry) // 다른 pane 이 놓으면 다시
      return () => void webgl.waiting.delete(retry)
    }
    if (block) return
    let addon: WebglAddon | null = null
    const release = () => {
      if (!addon) return
      const a = addon
      addon = null // 아래 loseContext 가 부르는 onContextLoss 를 실패로 세지 않게 먼저
      webgl.inUse--
      host.dataset['renderer'] = 'dom'
      // addon 의 dispose 는 canvas 를 떼기만 한다 — GC 전까지 컨텍스트가 살아 한도(~16)를 채우지 않게 바로 놓는다
      for (const c of host.querySelectorAll('canvas')) c.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext()
      try {
        a.dispose() // DOM 그리기로 돌아간다
      } catch {
        // 이미 잃은 컨텍스트
      }
      // 상한으로 기다리던 pane 하나에 자리를 준다
      const next = webgl.waiting.values().next().value
      if (next) {
        webgl.waiting.delete(next)
        next()
      }
    }
    try {
      const a = new WebglAddon()
      a.onContextLoss(() => {
        if (addon !== a) return // 우리가 놓은 것
        fail()
        release()
        retry() // 실패가 상한 아래면 바로 다시 (GPU 리셋 · 잠자기 복귀)
      })
      addon = a
      try {
        term.loadAddon(a)
      } catch (e) {
        addon = null
        a.dispose() // 실패한 addon 이 term 의 목록에 남지 않게
        throw e
      }
      webgl.inUse++
      host.dataset['renderer'] = 'webgl'
    } catch {
      fail() // WebGL2 가 없는 환경 — DOM 으로
    }
    return release
  }, [paneId, visible, glTry])

  // 다시 보이면 포커스. 숨겨진 동안(display:none)은 fit 이 크기를 못 재 아무것도 안 하고,
  // 다시 보일 때 ResizeObserver 가 0 → 실제 크기 변화를 보고 맞춘다.
  useEffect(() => {
    // 찾기 막대 입력칸을 눌러 이 pane 이 활성이 된 경우엔 입력칸에 둔다 (15d 리뷰)
    // 설정 같은 대화상자가 열려 있으면 가져가지 않는다 — 백업에서 되살린 일감이 열려도 Esc · ↑↓ 가 대화상자에 남게(17단계). 닫힐 때 refocus 가 다시 부른다
    if (document.querySelector('[aria-modal="true"]')) return
    if (active && !(document.activeElement instanceof Element && document.activeElement.closest('.find-bar'))) termRef.current?.focus()
  }, [active, focusSignal])

  // 가리기 설정이 바뀌면 처음부터 다시 훑는다(켬 · 끔 · 종류 · 가리지 않기로 한 값 · 내 종류)
  useEffect(() => {
    maskerRef.current?.update(mask)
    setMaskMenu(null)
  }, [mask])
  // 숨어 있는 동안 미뤄 둔 훑기
  useEffect(() => {
    if (visible && scanPending.current) {
      scanPending.current = false
      maskerRef.current?.scan()
    }
  }, [visible])
  // 메뉴가 가리키던 칸이 사라지면(스크롤 버퍼 밖 · ⌘K) 메뉴를 닫는다
  useEffect(() => {
    if (maskMenu && !hits.some((h) => h.id === maskMenu.hit.id)) setMaskMenu(null)
  }, [hits, maskMenu])

  const closeMaskMenu = () => {
    setMaskMenu(null)
    termRef.current?.focus()
  }
  const groups = maskList ? groupHits(hits) : []

  return (
    <>
      <div className="terminal-pane" ref={hostRef} data-testid={`pane-${paneId}`} />
      {mask.enabled && hits.length > 0 && (
        <button type="button" className="secret-chip" data-testid="secret-chip" title="이 pane 에서 가린 칸 — 눌러서 목록 보기" onClick={() => setMaskList((v) => !v)}>
          🔒 {hits.length}개 가림
        </button>
      )}
      {maskNotice && hits.length > 0 && (
        <div className="secret-notice" role="status" data-testid="secret-notice">
          <span>🔒 이 출력에서 비밀값 {hits.length}개를 가렸어요. 화면을 공유 중이었다면 키를 바꾸는 게 안전해요.</span>
          <button type="button" className="button" onClick={() => (setMaskList(true), setMaskNotice(false))}>
            어떤 것들인지 보기
          </button>
          <button type="button" className="button" onClick={() => (setMaskNotice(false), termRef.current?.focus())}>
            괜찮아요
          </button>
        </div>
      )}
      {maskList && hits.length > 0 && (
        <div className="secret-list" role="dialog" aria-label="가린 칸 목록" data-testid="secret-list" onKeyDown={(e) => e.key === 'Escape' && (setMaskList(false), termRef.current?.focus())}>
          <div className="secret-list-head">
            이 pane 의 가린 칸 {hits.length}개
            <button type="button" className="button" autoFocus onClick={() => maskerRef.current?.revealAll(REVEAL_ALL_MS)}>
              모두 30초 보기
            </button>
            <button type="button" className="button" onClick={() => (setMaskList(false), termRef.current?.focus())}>
              닫기
            </button>
          </div>
          <ul>
            {groups.map((g) => (
              <li key={g.hash}>
                <button type="button" className="secret-list-item" onClick={() => maskerRef.current?.focusNext(1)}>
                  🔒 {g.kind}
                  {g.count > 1 && <span className="secret-count"> 같은 값 ×{g.count}</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {maskMenu && (
        <div
          className="secret-menu"
          role="menu"
          aria-label={`${maskMenu.hit.kind} 가린 칸`}
          data-testid="secret-menu"
          style={{ left: maskMenu.x, top: maskMenu.y }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              closeMaskMenu()
            } else if (e.metaKey && e.code === 'KeyC') {
              e.preventDefault()
              void navigator.clipboard.writeText(maskMenu.hit.value).catch(() => {})
              closeMaskMenu()
            }
          }}
        >
          <button type="button" role="menuitem" autoFocus onClick={() => (maskerRef.current?.toggle(maskMenu.hit), closeMaskMenu())}>
            {maskMenu.hit.open ? '다시 가리기' : '이 칸 보기'} <kbd>↩</kbd>
          </button>
          <button type="button" role="menuitem" onClick={() => (void navigator.clipboard.writeText(maskMenu.hit.value).catch(() => {}), closeMaskMenu())}>
            원문 복사 <kbd>⌘C</kbd>
          </button>
          <button type="button" role="menuitem" onClick={() => (onAllow?.({ hash: maskMenu.hit.hash, kind: maskMenu.hit.kind }), closeMaskMenu())}>
            비밀값 아님 — 다시 가리지 않기
          </button>
        </div>
      )}
    </>
  )
}
