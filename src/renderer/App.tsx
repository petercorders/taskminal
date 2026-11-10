import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { applyActivity, formatDuration, taskActivity, type ActivityEvent, type PaneActivity } from '../shared/activity'
import { paneIds } from '../shared/layout'
import { commandForKey, isAppCommand, repeatable, shortcutTable, stepFontSize, type AppCommand } from '../shared/keymap'
import { notifyKind } from '../shared/notify'
import type { PaletteItem } from '../shared/palette'
import { cleanExit } from '../shared/pty'
import { createTask, emptyState, findPaneTask } from '../shared/model'
import type { LoadedState } from '../shared/ipc'
import type { NewTaskInput, NotifyKind, Task } from '../shared/types'
import { ConfirmDialog } from './ConfirmDialog'
import { NewTaskDialog, type NewTaskInitial } from './NewTaskDialog'
import { Palette } from './Palette'
import { Sidebar } from './Sidebar'
import { adjacentTask, nextAttention } from './sidebar-model'
import { reducer } from './store'
import { TabBar, tabElementId, tabPanelId } from './TabBar'
import { SettingsView } from './settings/SettingsView'
import { SplitView } from './SplitView'
import { termSettings } from './term-settings'
import { terminals } from './terminals'

type LoadStatus = { phase: 'loading' } | { phase: 'ready'; readOnly: boolean; notice: LoadedState['notice'] } | { phase: 'failed'; error: string }

const NOTICE: Record<NonNullable<LoadedState['notice']>, string> = {
  corrupt: '저장 파일이 손상돼 옆에 백업(state.json.….bak)해 두고 새로 시작했습니다.',
  repaired: '저장 파일의 일부를 읽지 못해 원본을 백업(state.json.….bak)해 두고 읽을 수 있는 부분만 열었습니다.',
  newer: '더 새 버전의 Taskminal 이 만든 저장 파일이라 읽기 전용으로 열었습니다 — 바꾼 내용은 저장되지 않습니다.',
}

// 읽기는 페이지마다 한 번만 — 개발 모드 StrictMode 가 effect 를 두 번 돌려도 load(손상 파일 백업 같은 부수 효과)를 두 번 하지 않게.
let loadOnce: Promise<LoadedState> | null = null
const loadState = () => (loadOnce ??= window.taskminal.state.load())

const newId = () => crypto.randomUUID()

const NOTIFY_TITLE: Record<NotifyKind, string> = {
  wait: '입력을 기다립니다',
  long: '명령이 끝났습니다',
  fail: '명령이 실패했습니다',
  exit: '셸이 닫혔습니다',
}

/** 테마 '시스템 따라가기' 를 푼 값 */
function useSystemDark(): boolean {
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const on = () => setDark(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return dark
}

/** 탭을 모두 닫은 일감: 일감은 남기고 새 탭 버튼. 보이는 일감이면 버튼이 포커스를 받는다(키보드로 바로 새 탭). */
function NoTabs({ active, focusSignal, onAdd }: { active: boolean; focusSignal: number; onAdd(): void }) {
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (active) ref.current?.focus()
  }, [active, focusSignal])
  return (
    <div className="empty" data-testid="no-tabs">
      <p className="hint">탭이 없습니다</p>
      <button ref={ref} type="button" className="button primary" onClick={onAdd}>
        새 탭
      </button>
    </div>
  )
}

export function App() {
  const [state, dispatch] = useReducer(reducer, undefined, emptyState)
  const [load, setLoad] = useState<LoadStatus>({ phase: 'loading' })
  const [saveError, setSaveError] = useState<string | null>(null)
  // 새 일감 대화상자 — 팔레트에서 열면 이름 · 템플릿을 미리 채운다
  const [creating, setCreating] = useState<NewTaskInitial | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // 팔레트에서 고른 출력 줄 — 그 pane 이 보이게 그린 뒤에 스크롤 · 선택한다(숨은 터미널에서 하면 스크롤이 맞지 않는다)
  const [pendingReveal, setPendingReveal] = useState<{ paneId: string; line: number; query: string } | null>(null)
  const [removing, setRemoving] = useState<Task | null>(null)
  // 실행 중인 것을 닫기 전 확인 (⌘W · 탭 ×)
  // 대상은 id 로만 들고 있다가 확인하는 순간의 상태로 다시 찾는다(그 사이 셸이 끝나 탭 · pane 이 바뀔 수 있다)
  const [confirming, setConfirming] = useState<
    { kind: 'pane'; paneId: string; command?: string } | { kind: 'tab'; taskId: string; tabId: string; busy: number } | null
  >(null)
  // pane 의 활동 — 저장하지 않는 런타임 값 (shared/activity.ts)
  const [activity, setActivity] = useState<Readonly<Record<string, PaneActivity>>>({})
  const [windowFocused, setWindowFocused] = useState(() => document.hasFocus())
  // 대화상자가 닫히면 올려서 보이는 터미널이 포커스를 다시 가져가게 한다
  const [focusSignal, setFocusSignal] = useState(0)
  const refocus = () => setFocusSignal((n) => n + 1)
  // 한 번이라도 본 탭만 터미널(셸)을 띄운다 — 저장된 일감 · 탭이 많아도 시작 때 셸을 한꺼번에 띄우지 않게.
  // 한 번 띄운 셸은 다른 탭 · 일감으로 옮겨도 숨겨 둔 채 유지한다.
  const [seenTabs, setSeenTabs] = useState<ReadonlySet<string>>(() => new Set())
  const loadedRef = useRef<LoadedState['state'] | null>(null)

  useEffect(() => window.taskminal.state.onError(setSaveError), [])

  useEffect(() => {
    let alive = true
    loadState().then(
      (loaded) => {
        if (!alive) return
        // 앱을 열 때(설정): 목록만 · 빈 창이면 일감을 열지 않는다 — 셸은 일감을 고를 때 뜬다
        const startup = loaded.state.settings.startup
        const state = startup === 'restore' ? loaded.state : { ...loaded.state, activeTaskId: null }
        loadedRef.current = state
        dispatch({ type: 'loaded', state })
        setLoad({ phase: 'ready', readOnly: loaded.readOnly, notice: loaded.notice })
        if (startup === 'blank') setCreating({})
      },
      (error: unknown) => {
        // 읽지 못했으면 저장도 하지 않는다 — 빈 상태가 실제 파일을 덮지 않게.
        if (alive) setLoad({ phase: 'failed', error: String(error) })
      },
    )
    return () => {
      alive = false
    }
  }, [])

  // 읽기가 끝나기 전 · 읽기 전용 · 읽기 실패면 저장하지 않는다.
  const canSave = load.phase === 'ready' && !load.readOnly
  useEffect(() => {
    // 막 읽은 상태를 그대로 다시 쓰지 않는다 — 바뀐 것이 있을 때만.
    if (canSave && state !== loadedRef.current) window.taskminal.state.save(state)
  }, [state, canSave])

  const shownTabId = state.tasks.find((t) => t.id === state.activeTaskId)?.activeTabId ?? null
  useEffect(() => {
    if (shownTabId && !seenTabs.has(shownTabId)) setSeenTabs((s) => new Set(s).add(shownTabId))
  }, [shownTabId, seenTabs])

  // 사용자가 보고 있는 pane: 활성 일감 · 활성 탭 · 활성 pane, 창에 포커스가 있을 때만 (다른 앱을 보는 동안의 벨은 확인 필요)
  useEffect(() => {
    const on = () => setWindowFocused(true)
    const off = () => setWindowFocused(false)
    window.addEventListener('focus', on)
    window.addEventListener('blur', off)
    return () => {
      window.removeEventListener('focus', on)
      window.removeEventListener('blur', off)
    }
  }, [])
  const activeTabNow = state.tasks.find((t) => t.id === state.activeTaskId)?.tabs.find((t) => t.id === shownTabId)
  const viewedPane = windowFocused && activeTabNow ? activeTabNow.activePaneId : null
  const viewedRef = useRef(viewedPane)
  viewedRef.current = viewedPane

  // 활동의 원본은 ref — 사건 하나에서 이전 · 다음을 함께 보고 알릴지 정한다(setState 갱신 함수 안에서 알림을 보내지 않게)
  const activityRef = useRef(activity)
  const putActivity = (next: Readonly<Record<string, PaneActivity>>) => {
    activityRef.current = next
    setActivity(next)
  }
  const stateRef = useRef(state)
  stateRef.current = state

  /** 설정의 '알림 · 활동': macOS 알림 · 소리. 보고 있는 pane 이면(설정) 알리지 않는다. 누르면 그 pane 으로 */
  const deliver = (kind: NotifyKind, paneId: string, act: PaneActivity | undefined) => {
    const s = stateRef.current
    const way = s.settings.notify[kind]
    if (!way.banner && !way.sound) return
    if (s.settings.muteViewed && paneId === viewedRef.current) return
    const taskId = findPaneTask(s, paneId)
    const taskName = s.tasks.find((t) => t.id === taskId)?.name ?? ''
    const detail =
      kind === 'wait'
        ? act?.message
        : kind === 'fail'
          ? `exit ${act?.exitCode ?? '?'}`
          : kind === 'long' && act?.startedAt !== undefined && act.endedAt !== undefined
            ? formatDuration(act.endedAt - act.startedAt)
            : undefined
    const body = [taskName, act?.command, detail].filter(Boolean).join(' · ')
    if (!way.banner) return window.taskminal.beep()
    const n = new Notification(NOTIFY_TITLE[kind], { body, silent: !way.sound })
    n.onclick = () => {
      window.focus()
      const id = findPaneTask(stateRef.current, paneId)
      if (!id) return
      dispatch({ type: 'task/select', id })
      dispatch({ type: 'pane/focus', taskId: id, paneId })
      refocus()
    }
  }

  const updateActivity = (paneId: string, ev: ActivityEvent) => {
    const prev = activityRef.current[paneId]
    const next = applyActivity(prev, ev, { viewed: paneId === viewedRef.current, now: Date.now() })
    if (next === prev) return
    putActivity({ ...activityRef.current, [paneId]: next })
    const kind = notifyKind(prev, next, ev, stateRef.current.settings.longAfterSec * 1000)
    if (kind) deliver(kind, paneId, next)
  }
  const updateActivityRef = useRef(updateActivity)
  updateActivityRef.current = updateActivity
  const deliverRef = useRef(deliver)
  deliverRef.current = deliver

  // 셸이 깨끗하게 끝나면(exit 0) 그 pane 을 닫는다 — 마지막 pane 이면 탭도. 아니면 TerminalPane 이 이유를 보여 주고 키를 누를 때 닫는다.
  // 우리가 끝낸 셸(탭 닫기 · 새로 고침 …)은 main 이 알리지 않는다 → 여기 오는 것은 모두 셸이 스스로 닫힌 것(알림 '셸 닫힘')
  useEffect(
    () =>
      window.taskminal.pty.onExit((paneId, exit) => {
        deliverRef.current('exit', paneId, activityRef.current[paneId])
        if (cleanExit(exit)) dispatch({ type: 'pane/exited', paneId })
      }),
    [],
  )
  // 보는 pane 이 바뀌면(일감 · 탭 · pane 이동, 창으로 돌아옴) 그 pane 의 확인 필요를 끈다
  useEffect(() => {
    if (viewedPane) updateActivityRef.current(viewedPane, { type: 'viewed' })
  }, [viewedPane])
  // 닫힌 pane 의 활동은 지운다
  useEffect(() => {
    const prev = activityRef.current
    const live = new Set(state.tasks.flatMap((t) => Object.keys(t.panes)))
    const gone = Object.keys(prev).filter((id) => !live.has(id))
    if (gone.length === 0) return
    const next = { ...prev }
    for (const id of gone) delete next[id]
    putActivity(next)
  }, [state.tasks])

  // main 에 알리는 값: 실행 중 명령 수(끄기 전 확인) · 확인 필요 일감 수(Dock 배지)
  const { settings } = state
  const busyTotal = Object.values(activity).filter((a) => a.busy).length
  const attentionTasks = state.tasks.filter((t) => taskActivity(Object.keys(t.panes).map((id) => activity[id])).attention).length
  useEffect(() => window.taskminal.setQuitGuard(settings.confirmQuit ? busyTotal : 0), [settings.confirmQuit, busyTotal])
  useEffect(() => window.taskminal.setBadge(settings.dockBadge ? attentionTasks : 0), [settings.dockBadge, attentionTasks])
  // 바꾼 단축키: renderer 가 처리하는 표 · 앱 메뉴의 표시
  const shortcuts = useMemo(() => shortcutTable(settings.keys), [settings.keys])
  const shortcutsRef = useRef(shortcuts)
  shortcutsRef.current = shortcuts
  useEffect(() => {
    if (load.phase !== 'loading') window.taskminal.setMenuKeys(settings.keys)
  }, [settings.keys, load.phase])

  // 모양: 테마 · 강조색 · 분할 흐림 — CSS 변수로
  const systemDark = useSystemDark()
  const theme = settings.theme === 'system' ? (systemDark ? 'dark' : 'light') : settings.theme
  useEffect(() => {
    const root = document.documentElement
    root.dataset['theme'] = theme
    root.style.setProperty('--accent', settings.accent)
    root.style.setProperty('--accent-soft', `${settings.accent}22`)
    root.style.setProperty('--running', settings.accent)
    root.style.setProperty('--dim-opacity', String(settings.dimOpacity))
  }, [theme, settings.accent, settings.dimOpacity])
  const term = useMemo(() => termSettings(settings, theme), [settings, theme])
  const busyPanes = (ids: string[]) => ids.filter((id) => activity[id]?.busy).length

  const addTab = (taskId: string) => dispatch({ type: 'tab/add', taskId, tabId: newId(), paneId: newId() })

  const closeTab = (task: Task, tabId: string, confirmed = false) => {
    const tab = task.tabs.find((t) => t.id === tabId)
    if (!tab) return
    const busy = busyPanes(paneIds(tab.layout))
    if (busy > 0 && !confirmed) return setConfirming({ kind: 'tab', taskId: task.id, tabId, busy })
    setConfirming(null)
    // 그 탭의 셸만 끝낸다 — 다른 탭 · 일감의 셸은 그대로.
    for (const paneId of paneIds(tab.layout)) window.taskminal.pty.kill(paneId)
    dispatch({ type: 'tab/close', taskId: task.id, tabId })
    // 이웃 탭이 활성이 되면 그 터미널이, 마지막 탭이었으면 '새 탭' 버튼이 포커스를 받는다
    refocus()
  }

  const create = (input: NewTaskInput) => {
    dispatch({ type: 'task/create', task: createTask(input, state.settings, newId, Date.now()) })
    setCreating(null)
    refocus()
  }

  const closeDialogs = () => {
    setCreating(null)
    setRemoving(null)
    setConfirming(null)
    setPaletteOpen(false)
    refocus()
  }

  const remove = (task: Task) => {
    // 그 일감의 셸을 모두 끝내고 목록에서 뺀다 (화면에서 빠지는 것만으로는 셸이 끝나지 않는다).
    for (const paneId of Object.keys(task.panes)) window.taskminal.pty.kill(paneId)
    dispatch({ type: 'task/remove', id: task.id })
    closeDialogs()
  }

  const activeTask = state.tasks.find((t) => t.id === state.activeTaskId) ?? null
  const dialogOpen = creating !== null || removing !== null || confirming !== null || paletteOpen || settingsOpen

  const closePane = (paneId: string, confirmed = false) => {
    const act = activity[paneId]
    if (!confirmed && act?.busy) return setConfirming({ kind: 'pane', paneId, ...(act.command ? { command: act.command } : {}) })
    setConfirming(null)
    // 그 pane 의 셸만 끝내고 닫는다 — 마지막 pane 이면 탭도
    window.taskminal.pty.kill(paneId)
    dispatch({ type: 'pane/exited', paneId })
    refocus()
  }

  // 앱 명령 하나 — 단축키(아래 keydown)와 앱 메뉴(main → onCommand)가 같은 길로 온다.
  // fromPalette: 팔레트에서 고른 명령 — 팔레트가 닫히는 중이라 '대화상자 열림' 규칙에 막히지 않게 한다
  const runCommand = (command: AppCommand, fromPalette = false) => {
    // 대화상자가 열려 있으면 뒤의 화면을 바꾸지 않는다 (⌘T 가 대화상자 뒤에서 탭을 만들지 않게)
    // 읽기가 끝나기 전에는 상태가 비어 있어 받지 않는다. 읽기에 실패한 실행(저장만 안 함)에서는 된다.
    if ((dialogOpen && !fromPalette) || load.phase === 'loading') return
    const task = activeTask
    const tab = task?.tabs.find((t) => t.id === task.activeTabId)
    const font = (how: 'bigger' | 'smaller' | 'reset') =>
      dispatch({ type: 'settings/font', size: stepFontSize(state.settings.fontSize, how) })
    switch (command) {
      case 'new-task':
        return setCreating({})
      case 'palette':
        return setPaletteOpen(true)
      case 'settings':
        return setSettingsOpen(true)
      case 'font-bigger':
        return font('bigger')
      case 'font-smaller':
        return font('smaller')
      case 'font-reset':
        return font('reset')
      case 'next-attention': {
        const target = nextAttention(state, activity, viewedRef.current)
        if (!target) return
        dispatch({ type: 'task/select', id: target.taskId })
        dispatch({ type: 'pane/focus', taskId: target.taskId, paneId: target.paneId })
        return refocus()
      }
      case 'next-task':
      case 'prev-task': {
        const id = adjacentTask(state, command === 'next-task' ? 1 : -1)
        if (id) dispatch({ type: 'task/select', id })
        return refocus()
      }
    }
    if (!task) return
    switch (command) {
      case 'new-tab':
        addTab(task.id)
        return refocus()
      case 'split-right':
      case 'split-down':
        dispatch({ type: 'pane/split', taskId: task.id, dir: command === 'split-right' ? 'right' : 'down', paneId: newId() })
        return refocus()
      case 'next-tab':
      case 'prev-tab':
        dispatch({ type: 'tab/cycle', taskId: task.id, step: command === 'next-tab' ? 1 : -1 })
        return refocus()
      case 'last-tab':
        dispatch({ type: 'tab/nth', taskId: task.id, n: 9 })
        return refocus()
      case 'next-pane':
      case 'prev-pane':
        dispatch({ type: 'pane/cycle', taskId: task.id, step: command === 'next-pane' ? 1 : -1 })
        return refocus()
    }
    if (command.startsWith('tab-')) {
      dispatch({ type: 'tab/nth', taskId: task.id, n: Number(command.slice(4)) })
      return refocus()
    }
    if (!tab) return
    switch (command) {
      case 'close-pane':
        return closePane(tab.activePaneId)
      case 'clear':
        terminals.get(tab.activePaneId)?.clear()
        return refocus()
    }
  }
  // 팔레트에서 고른 것을 실행한다 — 팔레트는 먼저 닫는다
  const runPaletteItem = (item: PaletteItem, query: string, newTab: boolean) => {
    setPaletteOpen(false)
    switch (item.kind) {
      case 'task':
        dispatch({ type: 'task/select', id: item.id })
        if (newTab) addTab(item.id)
        return refocus()
      case 'command':
        // 대화상자를 여는 명령(새 일감)이어도 대화상자가 포커스를 갖는다 — 대화상자의 마운트 효과가 터미널보다 나중에 돈다(e2e 로 확인)
        if (isAppCommand(item.id)) runCommand(item.id, true)
        return refocus()
      case 'template':
        return setCreating({ templateId: item.id })
      case 'create':
        return setCreating({ name: item.label })
      case 'output': {
        const paneId = item.paneId!
        const taskId = findPaneTask(state, paneId)
        if (!taskId) return refocus()
        dispatch({ type: 'task/select', id: taskId })
        dispatch({ type: 'pane/focus', taskId, paneId })
        setPendingReveal({ paneId, line: item.line!, query })
        return refocus()
      }
    }
  }

  useEffect(() => {
    if (!pendingReveal) return
    const { paneId, line, query } = pendingReveal
    // 보이게 된 다음 프레임(크기 맞춤 뒤)에. 아래 setPendingReveal(null) 의 다시 그리기가 이 프레임을 취소하지 않게 정리 함수는 두지 않는다
    requestAnimationFrame(() => terminals.get(paneId)?.reveal(line, query))
    setPendingReveal(null)
  }, [pendingReveal])

  const runCommandRef = useRef(runCommand)
  runCommandRef.current = runCommand

  useEffect(() => {
    // capture 단계에서 받는다. xterm 은 ⌘ 가 눌린 키를 셸로 보내지 않으므로(@xterm Keyboard.ts) 전파는 막지 않는다.
    const onKey = (e: KeyboardEvent) => {
      // 글을 고치는 칸(탭 이름 · 대화상자)에서는 ⌘ 키가 그 칸의 편집 몫 — ⌘W 가 뒤의 셸을 끝내지 않게. xterm 의 입력칸은 제외.
      const t = e.target
      if (t instanceof HTMLInputElement || (t instanceof HTMLTextAreaElement && !t.classList.contains('xterm-helper-textarea'))) return
      const command = commandForKey(e, shortcutsRef.current)
      if (!command) return
      e.preventDefault()
      if (e.repeat && !repeatable(command)) return
      runCommandRef.current(command)
    }
    window.addEventListener('keydown', onKey, true)
    const offMenu = window.taskminal.onCommand((command) => {
      if (isAppCommand(command)) runCommandRef.current(command)
    })
    return () => {
      window.removeEventListener('keydown', onKey, true)
      offMenu()
    }
  }, [])

  const message =
    load.phase === 'failed'
      ? `저장 파일을 읽지 못해 이번 실행에서는 저장하지 않습니다: ${load.error}`
      : saveError
        ? `상태를 저장하지 못했습니다 (${saveError}) — 다음에 바뀔 때 다시 시도합니다.`
        : load.phase === 'ready' && load.notice
          ? NOTICE[load.notice]
          : null

  return (
    <div className="app">
      {message && (
        <p className="notice" role="status" data-testid="state-notice">
          {message}
        </p>
      )}
      <div className="app-body">
        <Sidebar
          state={state}
          activity={activity}
          loading={load.phase === 'loading'}
          onSelect={(id) => {
            dispatch({ type: 'task/select', id })
            refocus()
          }}
          onNew={() => setCreating({})}
          onRemove={setRemoving}
          onEdit={(id, patch) => dispatch({ type: 'task/edit', id, patch })}
          onToggleGroup={(id) => dispatch({ type: 'group/toggle', id })}
          onSettings={() => runCommand('settings')}
          onMenuClosed={refocus}
        />
        <main className="workspace">
          {/* 전환해도 셸 · 화면이 남도록 본 탭의 pane 은 모두 마운트해 두고, 활성이 아닌 일감 · 탭은 숨긴다. */}
          {state.tasks.map((task) => {
            const taskActive = task.id === state.activeTaskId
            return (
              <section
                key={task.id}
                className="task-view"
                style={{ display: taskActive ? 'flex' : 'none' }}
                data-testid="task-view"
                data-task-name={task.name}
                aria-hidden={!taskActive}
              >
                <TabBar
                  task={task}
                  activity={activity}
                  visible={taskActive}
                  onSelect={(tabId) => dispatch({ type: 'tab/select', taskId: task.id, tabId })}
                  onAdd={() => addTab(task.id)}
                  onClose={(tabId) => closeTab(task, tabId)}
                  onRename={(tabId, title) => dispatch({ type: 'tab/rename', taskId: task.id, tabId, title })}
                  onDone={refocus}
                  onSplit={(dir) => dispatch({ type: 'pane/split', taskId: task.id, dir, paneId: newId() })}
                />
                {task.tabs.map((tab) => {
                  const tabActive = tab.id === task.activeTabId
                  const mounted = (taskActive && tabActive) || seenTabs.has(tab.id)
                  return (
                    <div
                      key={tab.id}
                      className="tab-view"
                      role="tabpanel"
                      id={tabPanelId(tab.id)}
                      aria-labelledby={tabElementId(tab.id)}
                      style={{ display: tabActive ? 'flex' : 'none' }}
                      data-testid="tab-view"
                      data-tab-id={tab.id}
                    >
                      {mounted && (
                        <SplitView
                          tab={tab}
                          panes={task.panes}
                          visible={taskActive && tabActive}
                          focusSignal={focusSignal}
                          term={term}
                          activity={activity}
                          onActivity={updateActivity}
                          onFocusPane={(paneId) => dispatch({ type: 'pane/focus', taskId: task.id, paneId })}
                          onRatio={(path, ratio) => dispatch({ type: 'pane/ratio', taskId: task.id, tabId: tab.id, path, ratio })}
                          onClosePane={(paneId) => dispatch({ type: 'pane/exited', paneId })}
                          onDragEnd={refocus}
                        />
                      )}
                    </div>
                  )
                })}
                {task.tabs.length === 0 && (
                  <NoTabs active={taskActive} focusSignal={focusSignal} onAdd={() => addTab(task.id)} />
                )}
              </section>
            )
          })}
          {load.phase !== 'loading' && state.tasks.length > 0 && !activeTask && (
            <div className="empty" data-testid="pick-view">
              <h1>Taskminal</h1>
              <p className="hint">왼쪽에서 일감을 고르면 터미널이 시작됩니다</p>
            </div>
          )}
          {load.phase !== 'loading' && state.tasks.length === 0 && (
            <div className="empty" data-testid="empty-view">
              <h1>Taskminal</h1>
              <p className="hint">일감이 없습니다</p>
              <button type="button" className="button primary" onClick={() => setCreating({})}>
                새 일감
              </button>
            </div>
          )}
        </main>
      </div>
      {settingsOpen && (
        <SettingsView
          state={state}
          shortcuts={shortcuts}
          dispatch={dispatch}
          newId={newId}
          onClose={() => {
            setSettingsOpen(false)
            refocus()
          }}
        />
      )}
      {creating && <NewTaskDialog state={state} initial={creating} onCreate={create} onCancel={closeDialogs} />}
      {paletteOpen && <Palette state={state} shortcuts={shortcuts} onRun={runPaletteItem} onClose={closeDialogs} />}
      {removing && (
        <ConfirmDialog
          title="일감 지우기"
          message={`‘${removing.name}’ 일감을 지울까요? 터미널 ${Object.keys(removing.panes).length}개가 함께 종료됩니다.${
            busyPanes(Object.keys(removing.panes)) > 0 ? ` 그중 ${busyPanes(Object.keys(removing.panes))}개에서 명령이 실행 중입니다.` : ''
          }`}
          confirmLabel="지우기"
          onConfirm={() => remove(removing)}
          onCancel={closeDialogs}
        />
      )}
      {confirming && (
        <ConfirmDialog
          title={confirming.kind === 'pane' ? 'pane 닫기' : '탭 닫기'}
          message={
            confirming.kind === 'pane'
              ? `실행 중인 명령${confirming.command ? ` ‘${confirming.command}’` : ''}이 함께 끝납니다.`
              : `이 탭에서 명령 ${confirming.busy}개가 실행 중입니다. 닫으면 함께 끝납니다.`
          }
          confirmLabel="닫기"
          onConfirm={() => {
            // 지금 상태에서 다시 찾는다 — 없어졌으면(셸이 스스로 끝남) 대화상자만 닫는다
            const c = confirming
            if (c.kind === 'pane') {
              if (findPaneTask(state, c.paneId)) closePane(c.paneId, true)
              else closeDialogs()
            } else {
              const task = state.tasks.find((t) => t.id === c.taskId)
              if (task?.tabs.some((t) => t.id === c.tabId)) closeTab(task, c.tabId, true)
              else closeDialogs()
            }
          }}
          onCancel={closeDialogs}
        />
      )}
    </div>
  )
}
