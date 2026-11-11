import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { applyActivity, formatDuration, taskActivity, type ActivityEvent, type PaneActivity } from '../shared/activity'
import { paneIds } from '../shared/layout'
import { commandForKey, isAppCommand, repeatable, shortcutTable, stepFontSize, type AppCommand } from '../shared/keymap'
import { notifyKind } from '../shared/notify'
import type { PaletteItem } from '../shared/palette'
import { cleanExit } from '../shared/pty'
import { cwdLike } from '../shared/cwd'
import { keepIfSame, taskDirs, type Branches } from '../shared/git'
import { branchChat, createTask, dropQuick, emptyState, findPaneTask, findQuick, findReviewPane, openReviewPane, resolveCwd, tabLabel, tabToTemplate, taskToTemplate, templateIdCount, type QuickScope } from '../shared/model'
import type { ReviewMode, ReviewRequest } from './ReviewPane'
import { advanceRun, closeRun, decideRun, quickButtons, quickStatus, WHERE_LABEL, type QuickButton, type QuickCommand, type QuickRun, type QuickSource } from '../shared/quick'
import { portConflict, type PortChip } from '../shared/ports'
import type { BackupMark, LoadedState } from '../shared/ipc'
import type { AppState, NewTaskInput, NotifyKind, Task, Template } from '../shared/types'
import { restoreTask, type Restored } from '../shared/backup'
import { redact, SECRET_TOGGLES, type SecretOptions, type SecretToggleId } from '../shared/redact'
import { CMD_MAX, hasMask, type HistoryEntry } from '../shared/history'
import { isDangerous } from '../shared/danger'
import { useHistory } from './history-state'
import { HistoryPanel } from './history-ui'
import { FIND_MEMO, GlobalFind, type FindMemo, type FindTarget } from './GlobalFind'
import type { CommandDone } from './TerminalPane'
import type { ChatPermission } from '../shared/chat'
import type { MaskSettings } from './secret-mask'
import { Toast, type ToastSpec } from './Toast'
import { dateClock } from './settings/BackupSection'
import { ConfirmDialog } from './ConfirmDialog'
import { NewTaskDialog, type NewTaskInitial } from './NewTaskDialog'
import { Palette } from './Palette'
import { Sidebar } from './Sidebar'
import { maskActivity, textMasker } from './activity-mask'
import { adjacentTask, stepStatus, nextAttention, unreadTasks } from './sidebar-model'
import { reducer } from './store'
import { TabBar, tabElementId, tabPanelId } from './TabBar'
import { TemplateNameDialog } from './TemplateNameDialog'
import { SettingsView, type SettingsJump } from './settings/SettingsView'
import { SplitView } from './SplitView'
import { termSettings } from './term-settings'
import { dirtyPanes, integratedPanes, osc7Panes, restoredWithText, runtime } from './runtime'
import { PopupMenu, type PopupItem } from './PopupMenu'
import { draftOf, QuickBar, QuickConfirm, QuickEditor, type QuickDraft } from './quick-ui'
import { usePorts } from './ports-state'
import { PortConflictBar, PortKillConfirm, portUrl } from './ports-ui'
import { HostBanners, useHostView, type StartupNotes } from './host-ui'
import { UpdateBanners, useUpdateView } from './update-ui'
import { FirstRun } from './FirstRun'
import { summarizeResume } from '../shared/ptyhost'
import { terminals } from './terminals'

type LoadStatus = { phase: 'loading' } | { phase: 'ready'; readOnly: boolean; notice: LoadedState['notice']; recoveredAt?: number | undefined } | { phase: 'failed'; error: string }

const NOTICE: Record<NonNullable<LoadedState['notice']>, string> = {
  corrupt: '저장 파일이 손상돼 옆에 백업(state.json.….bak)해 두고 새로 시작했습니다.',
  recovered: '저장 파일이 손상돼 마지막 백업으로 되살렸어요. 손상된 파일은 옆에(state.json.….bak) 남겨 뒀어요.',
  repaired: '저장 파일의 일부를 읽지 못해 원본을 백업(state.json.….bak)해 두고 읽을 수 있는 부분만 열었습니다.',
  newer: '더 새 버전의 Taskminal 이 만든 저장 파일이라 읽기 전용으로 열었습니다 — 바꾼 내용은 저장되지 않습니다.',
}

// 읽기는 페이지마다 한 번만 — 개발 모드 StrictMode 가 effect 를 두 번 돌려도 load(손상 파일 백업 같은 부수 효과)를 두 번 하지 않게.
let loadOnce: Promise<LoadedState> | null = null
// appInfo(이 Mac 이름 · lsof 주기)를 먼저 채워 둔다 — 셸이 뜨자마자 보내는 OSC 7 을 호스트로 거르려면 pane 이 마운트되기 전에 있어야 한다
const loadState = () =>
  (loadOnce ??= window.taskminal.appInfo().then(
    (info) => {
      runtime.host = info.host
      runtime.home = info.home
      runtime.cwdPollMs = info.cwdPollMs
      runtime.portPollMs = info.portPollMs
      runtime.claudeTui = info.claudeTui
      runtime.codexTui = info.codexTui
      runtime.renderer = info.renderer
      runtime.crashedLast = info.crashedLast
      return window.taskminal.state.load()
    },
    () => window.taskminal.state.load(),
  ))

/**
 * 스크롤 저장할 글 — 마지막 저장 뒤 출력이 온 pane 만(나머지는 이미 파일에 있다). 글을 만든 pane 만 '바뀜' 을 지우고,
 * 만들다 실패한 pane 은 남겨 다음 주기가 다시 본다. 닫혀 터미널이 없는 pane 은 지운다(파일은 main 이 live 로 정리).
 * 되살리는 중인 pane 은 셸을 아직 띄우지 않아 출력이 없으니 여기 오지 않는다 — 빈 화면이 저장된 글을 덮지 않는다.
 */
function collectScrollback(): Record<string, string> {
  const panes: Record<string, string> = {}
  for (const paneId of [...dirtyPanes]) {
    const handle = terminals.get(paneId)
    if (!handle) {
      dirtyPanes.delete(paneId)
      continue
    }
    try {
      panes[paneId] = handle.serialize()
      dirtyPanes.delete(paneId)
    } catch {
      // 다음 주기가 다시 본다
    }
  }
  return panes
}

/** 스크롤 주기 저장 — 렌더러 충돌 · 강제 종료 때 잃는 것을 이만큼으로 줄인다 */
const SCROLLBACK_SAVE_MS = 30_000
const BRANCH_POLL_MS = 5_000 // 셸에서 git switch 한 것을 따라가는 주기 (파일 몇 개 읽기)

const newId = () => crypto.randomUUID()

/** 빠른 명령 단추를 가리키는 열쇠 — 일감 · 출처(모든 일감이면 settings) · id */
interface QuickRef {
  taskId: string
  source: QuickSource
  id: string
}

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
  const [branches, setBranches] = useState<Branches>({})
  // ⌘F 찾기 막대가 열린 pane (15d) — signal 은 다시 누를 때 입력칸으로 가게
  const [finding, setFinding] = useState<{ paneId: string | null; signal: number; query?: string }>({ paneId: null, signal: 0 })
  // 새 일감 대화상자 — 팔레트에서 열면 이름 · 템플릿을 미리 채운다
  const [creating, setCreating] = useState<NewTaskInitial | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // 설정을 열 때 보일 칸 (⌘P '셸 지킴이 보기' 등) — 닫으면 지운다
  const [settingsSection, setSettingsSection] = useState<SettingsJump | null>(null)
  // 17단계: 아래 알림(지운 일감 되돌리기 · 비밀값 아님 되돌리기) · 백업 실패 줄
  const [toast, setToast] = useState<ToastSpec | null>(null)
  const toastRef = useRef(toast)
  toastRef.current = toast
  const showToast = (t: Omit<ToastSpec, 'id'>) => {
    // 되돌렸는지는 알림이 내려갈 때(onEnd) 알린다 — 되돌리기 · ⌘Z 둘 다 action.run 을 지난다
    let undone = false
    let ended = false
    const { action, onEnd } = t
    setToast({
      ...t,
      id: Date.now() + Math.random(),
      ...(action ? { action: { ...action, run: () => ((undone = true), action.run()) } } : {}),
      ...(onEnd
        ? {
            onEnd: () => {
              if (ended) return
              ended = true
              onEnd(undone)
            },
          }
        : {}),
    })
  }
  // 알림이 바뀌거나 내려가면 앞 알림의 onEnd — 한 번만
  const endedToast = useRef<ToastSpec | null>(null)
  useEffect(() => {
    const prev = endedToast.current
    endedToast.current = toast
    if (prev && prev !== toast) prev.onEnd?.(false)
  }, [toast])
  // 창이 내려가기 전(종료 · 새로 고침)에도 — 지운 기록이 다음 실행에 되살아나지 않게
  useEffect(() => {
    const flush = () => endedToast.current?.onEnd?.(false)
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [])
  const [backupError, setBackupError] = useState<string | null>(null)
  // 셸 지킴이 (16단계): 상태 · 처음 읽힐 때 정한 줄 · 확인 창
  const hostView = useHostView()
  // 18단계: 업데이트 · 첫 실행 안내('first' = 처음 · 'again' = 다시 보기) · '다음에' 로 닫은 받아 둔 버전
  const updateView = useUpdateView()
  const [firstRun, setFirstRun] = useState<'first' | 'again' | null>(null)
  const [laterVersion, setLaterVersion] = useState<string | null>(null)
  const [startup, setStartup] = useState<StartupNotes | null>(null)
  const [hostConfirm, setHostConfirm] = useState<'restart' | 'replace-old' | null>(null)
  // 팔레트에서 고른 출력 줄 — 그 pane 이 보이게 그린 뒤에 스크롤 · 선택한다(숨은 터미널에서 하면 스크롤이 맞지 않는다)
  const [pendingReveal, setPendingReveal] = useState<{ paneId: string; line: number; query: string } | null>(null)
  const [removing, setRemoving] = useState<Task | null>(null)
  // 19단계: 명령 기록 칸(signal = ⌘Y 로 열 때마다 찾기 칸으로) · 모든 출력 찾기 창 · 그 창의 기억 · 출력으로 가기
  const [historyOpen, setHistoryOpen] = useState<{ signal: number } | null>(null)
  const [globalFind, setGlobalFind] = useState(false)
  const findMemo = useRef<FindMemo>(FIND_MEMO)
  const [pendingMarker, setPendingMarker] = useState<{ paneId: string; id: string } | null>(null)
  const [clearingHistory, setClearingHistory] = useState(false)
  // 이 일감(tabId null) · 탭을 템플릿으로 저장 — 이름을 묻는 중
  // 연 순간의 탭/일감을 템플릿으로 떠 둔다 — 대화상자가 열린 동안 그 탭이 닫혀도 본 것을 저장하고 제목도 바뀌지 않게
  const [savingTemplate, setSavingTemplate] = useState<{ what: string; initialName: string; template: Template } | null>(null)
  // 실행 중인 것을 닫기 전 확인 (⌘W · 탭 ×)
  // 대상은 id 로만 들고 있다가 확인하는 순간의 상태로 다시 찾는다(그 사이 셸이 끝나 탭 · pane 이 바뀔 수 있다)
  const [confirming, setConfirming] = useState<
    { kind: 'pane'; paneId: string; command?: string } | { kind: 'tab'; taskId: string; tabId: string; busy: number } | null
  >(null)
  // 빠른 명령 (20단계): 누른 기록(런타임) · 메뉴 · 만들기 창 · 실행 확인. 단추는 id 로만 들고 누르는 순간 다시 찾는다
  const [quickRuns, setQuickRuns] = useState<Readonly<Record<string, QuickRun>>>({})
  const [quickEdit, setQuickEdit] = useState<{ taskId: string; ref: QuickRef | null; draft: QuickDraft; fromTemplate?: string | undefined } | null>(null)
  const [quickAsk, setQuickAsk] = useState<(QuickRef & { qc: QuickCommand }) | null>(null)
  const [popup, setPopup] = useState<
    | ({ kind: 'quick'; x: number; y: number } & QuickRef)
    | { kind: 'more'; taskId: string; x: number; y: number }
    | { kind: 'port'; chip: PortChip; x: number; y: number }
    | null
  >(null)
  // 포트 (20단계): 끄기 확인(연 순간의 pid · 포트 — main 이 끄기 직전에 다시 확인) · 겹침 알림
  const [portKill, setPortKill] = useState<PortChip | null>(null)
  const [portClash, setPortClash] = useState<{ port: number; wanted: number; ownerPaneId: string; taskId: string; ownerTaskId: string } | null>(null)
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
  useEffect(() => window.taskminal.backup.onError(setBackupError), [])

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
        setLoad({ phase: 'ready', readOnly: loaded.readOnly, notice: loaded.notice, recoveredAt: loaded.recoveredAt })
        if (loaded.firstRun) setFirstRun('first')
        else if (startup === 'blank') setCreating({})
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
  // ⌘F 막대는 보이는 탭의 pane 에만 — 탭 · 일감을 옮기거나 pane 이 닫히면 닫는다(숨은 pane 이 출력마다 다시 찾지 않게, 15d 리뷰)
  const shownPanesKey = activeTabNow ? paneIds(activeTabNow.layout).join(' ') : ''
  useEffect(() => {
    setFinding((f) => (f.paneId && !shownPanesKey.split(' ').includes(f.paneId) ? { ...f, paneId: null } : f))
  }, [shownPanesKey])
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
    const body = diskMaskRef.current([taskName, act?.command, detail].filter(Boolean).join(' · '))
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
    const viewed = paneId === viewedRef.current
    const next = applyActivity(prev, ev, { viewed, now: Date.now() })
    if (next !== prev) putActivity({ ...activityRef.current, [paneId]: next })
    // 보고 있는 pane 의 벨 · 알림은 확인 필요가 되지 않지만(applyActivity), '보고 있어도 알리기'(muteViewed 끔)면 알린다 — deliver 가 설정을 본다
    const kind = notifyKind(prev, next, ev, stateRef.current.settings.longAfterSec * 1000) ?? (viewed && (ev.type === 'bell' || ev.type === 'notify') ? 'wait' : null)
    if (kind) deliver(kind, paneId, ev.type === 'notify' ? { ...next, message: ev.text } : next)
  }
  const updateActivityRef = useRef(updateActivity)
  updateActivityRef.current = updateActivity
  const deliverRef = useRef(deliver)
  deliverRef.current = deliver

  // 16단계: 앱이 처음 읽히면 셸 지킴이에 남은 셸을 본다 — 꺼져 있던 동안의 입력 기다림 · 실패를 활동(사이드바 확인 필요)으로 넣고,
  // 이어진 셸 수 · 기다리는 셸을 위 줄로. 아직 마운트되지 않은 탭의 pane 도 들어간다. 한 번만(clearUnseen).
  const loadedOnce = load.phase === 'ready'
  useEffect(() => {
    if (!loadedOnce) return
    let alive = true
    window.taskminal.host.sessions(true).then(
      (sessions) => {
        if (!alive) return
        const st = stateRef.current
        const summary = summarizeResume(sessions, st.tasks.flatMap((t) => Object.keys(t.panes)))
        const inState = new Set(st.tasks.flatMap((t) => Object.keys(t.panes)))
        for (const s of sessions) if (s.command && !s.exited && inState.has(s.paneId)) updateActivityRef.current(s.paneId, { type: 'command', text: s.command })
        // 꺼져 있던 동안 생긴 것 — 지금 보고 있는 pane 이어도 사용자는 못 봤다(보지 않음으로 넣어 확인 필요가 되게). 알림은 위 줄이 대신한다
        const away = (paneId: string, ev: ActivityEvent) => {
          const next = applyActivity(activityRef.current[paneId], ev, { viewed: false, now: Date.now() })
          putActivity({ ...activityRef.current, [paneId]: next })
        }
        for (const f of summary.failed) away(f.paneId, { type: 'end', code: f.code })
        for (const w of summary.waiting) away(w.paneId, { type: 'notify', text: w.message ?? '' })
        const label = (paneId: string) => st.tasks.find((t) => t.id === findPaneTask(st, paneId))?.name ?? paneId
        setStartup({ resumed: summary.resumed, awayMs: summary.awayMs, waiting: summary.waiting.map((w) => ({ label: label(w.paneId), ...(w.message ? { message: w.message } : {}) })), fresh: false })
      },
      () => {},
    )
    // 지킴이 없이(재부팅 · 충돌) 새로 띄워 이전 출력을 되살린 pane 이 있으면 안내 — pane 들이 되살리기를 마친 뒤
    const t = setTimeout(() => {
      void window.taskminal.host.view().then((v) => {
        if (alive && v.fresh && restoredWithText.size > 0) setStartup((s) => ({ resumed: 0, awayMs: 0, waiting: [], ...s, fresh: true }))
      })
    }, 1500)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [loadedOnce])

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
  // ─── 13단계: 스크롤 저장 · 작업 폴더 ───
  // 저장은 상태를 읽은 뒤에만 — 빈 상태의 live=[] 가 저장된 스크롤을 모두 지우지 않게
  const scrollReady = load.phase === 'ready'
  const restoreOn = state.settings.restoreScrollback
  useEffect(() => {
    if (!scrollReady) return
    const live = () => stateRef.current.tasks.flatMap((t) => Object.keys(t.panes))
    if (!restoreOn) {
      // 끄면 저장된 것을 모두 지운다(디스크에 터미널 출력을 남기지 않게)
      window.taskminal.scrollback.save({ live: [], panes: {} })
      return
    }
    const timer = setInterval(() => {
      if (dirtyPanes.size > 0) window.taskminal.scrollback.save({ live: live(), panes: collectScrollback() })
    }, SCROLLBACK_SAVE_MS)
    // 앱 종료 · 창 닫기 · 새로 고침: 페이지가 내려가기 전에 동기로 — main 이 다 쓴 뒤에 페이지가 사라진다. 바뀐 pane 만(창이 크면 다 보내면 끄기가 멈칫한다)
    const flush = () => window.taskminal.scrollback.saveNow({ live: live(), panes: collectScrollback() })
    window.addEventListener('beforeunload', flush)
    return () => {
      clearInterval(timer)
      window.removeEventListener('beforeunload', flush)
    }
  }, [scrollReady, restoreOn])
  // 사이드바 둘째 줄의 git 브랜치 (15c) — 일감 폴더가 바뀔 때 · 창이 포커스를 받을 때 읽고, 포커스가 있는 동안만 5초마다.
  // 앞 요청이 안 끝났으면 건너뛴다(끊긴 NAS 같은 느린 폴더에서 요청이 쌓이지 않게). 정리 뒤 온 옛 응답은 버리고, 같으면 다시 그리지 않는다.
  const dirsKey = taskDirs(state.tasks.map((t) => t.cwd)).join('\n')
  useEffect(() => {
    const dirs = dirsKey ? dirsKey.split('\n') : []
    if (dirs.length === 0) return setBranches((prev) => keepIfSame(prev, {}))
    let alive = true
    let busy = false
    const read = () => {
      if (busy) return
      busy = true
      void window.taskminal
        .gitBranches(dirs)
        .then(
          (found) => {
            if (alive) setBranches((prev) => keepIfSame(prev, found))
          },
          () => {},
        )
        .finally(() => (busy = false))
    }
    read() // 폴더가 바뀜 · 포커스를 받음(windowFocused 가 바뀌어 다시 돎)
    if (!windowFocused) return () => void (alive = false)
    const timer = setInterval(read, BRANCH_POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [dirsKey, windowFocused])
  // 셸 통합(OSC 7)이 없는 셸의 폴더는 lsof 로 — 마운트된 pane 중 OSC 7 을 한 번도 보내지 않은 것만
  useEffect(() => {
    if (!scrollReady) return
    let alive = true
    const timer = setInterval(() => {
      const ids = [...terminals.keys()].filter((id) => !osc7Panes.has(id))
      if (ids.length === 0) return
      void window.taskminal.pty.cwds(ids).then(
        (found) => {
          if (!alive) return
          for (const [paneId, cwd] of Object.entries(found)) {
            if (osc7Panes.has(paneId)) continue
            const s = stateRef.current
            const task = s.tasks.find((t) => t.id === findPaneTask(s, paneId))
            if (task) dispatch({ type: 'pane/cwd', paneId, cwd: cwdLike(cwd, task.cwd, runtime.home) })
          }
        },
        () => {},
      )
    }, runtime.cwdPollMs)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [scrollReady])

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
  const findingRef = useRef(finding)
  findingRef.current = finding
  const findProps = {
    paneId: finding.paneId,
    signal: finding.signal,
    ...(finding.query !== undefined ? { query: finding.query } : {}),
    onClose: () => {
      setFinding((f) => ({ ...f, paneId: null }))
      refocus()
    },
    shortcuts,
  }
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
  // 터미널 칸이 바뀔 때만 새 객체 — 상태 색 · 묶음 접기 같은 다른 설정이 모든 터미널의 옵션을 다시 넣지 않게
  const term = useMemo(
    () => termSettings(settings, theme),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settings.fontFamily, settings.fontSize, settings.lineHeight, settings.cursorStyle, settings.cursorBlink, settings.scrollback, settings.optionAsMeta, settings.copyOnSelect, settings.accent, settings.shell, settings.shellIntegration, settings.restoreScrollback, theme],
  )
  const busyPanes = (ids: string[]) => ids.filter((id) => activity[id]?.busy).length
  // 화면에서 비밀값 가리기 (17단계) — 이 칸들이 바뀔 때만 새 객체(바뀌면 모든 pane 이 처음부터 다시 훑는다)
  const maskSettings = useMemo<MaskSettings>(
    () => ({
      enabled: settings.maskScreen,
      toggles: new Set<SecretToggleId>(SECRET_TOGGLES.map((t) => t.id).filter((id) => !settings.maskKindsOff.includes(id))),
      allow: new Set(settings.secretAllow.map((a) => a.hash)),
      custom: settings.secretCustom,
    }),
    [settings.maskScreen, settings.maskKindsOff, settings.secretAllow, settings.secretCustom],
  )

  // 기록에 넣기 전에 renderer 도 가린다(화면에 보이는 기록) — main 이 쓸 때 다시 가린다. 디스크는 종류 끄기와 상관없이 모두
  const historyRedact = useMemo<SecretOptions>(() => ({ allow: maskSettings.allow, custom: maskSettings.custom }), [maskSettings])
  // 화면에 보이는 명령 글(칸 머리 · 사이드바 둘째 줄 · 닫기 확인) — 화면 가리기를 따른다. 판단은 원래 activity 로(작은 고침 2026-11-11)
  const screenMask = useMemo(
    () => (maskSettings.enabled ? textMasker({ toggles: maskSettings.toggles, allow: maskSettings.allow, custom: maskSettings.custom }) : null),
    [maskSettings],
  )
  // 기록(⌘Y) 의 실행 중 줄 · 시스템 알림(알림 센터 = 디스크)은 저장된 기록처럼 늘 가린다
  const diskMask = useMemo(() => textMasker(historyRedact), [historyRedact])
  const diskMaskRef = useRef(diskMask)
  diskMaskRef.current = diskMask
  const shownActivity = useMemo(() => maskActivity(activity, screenMask), [activity, screenMask])
  const historyActivity = useMemo(() => maskActivity(activity, diskMask), [activity, diskMask])
  const history = useHistory(load.phase === 'ready')
  const onCommandDone = (paneId: string, done: CommandDone) => {
    const s = stateRef.current
    const taskId = findPaneTask(s, paneId)
    const pane = s.tasks.find((t) => t.id === taskId)?.panes[paneId]
    if (!taskId || !pane) return
    const entry: HistoryEntry = {
      id: done.id,
      taskId,
      paneId,
      cmd: redact(done.cmd.slice(0, CMD_MAX), historyRedact),
      cwd: redact(pane.cwd, historyRedact),
      startedAt: done.startedAt,
      endedAt: done.endedAt,
      code: done.code,
      tail: done.tail.map((l) => redact(l, historyRedact)),
    }
    history.add(entry)
  }
  const activePaneNow = activeTabNow?.activePaneId ?? null
  /** ↩ 입력줄에 넣기 — 지금 pane, 실행하지 않는다 */
  const historyInsert = (e: HistoryEntry) => {
    if (!activePaneNow) return
    if (terminals.get(activePaneNow)?.insert(e.cmd) === false) showToast({ text: '여러 줄 명령은 이 pane 에 바로 넣지 않았어요.', sub: '셸이 붙여넣기 보호를 켜지 않아 줄바꿈이 실행될 수 있어요 · ⋯ 명령 복사로 붙여 넣어 주세요.' })
    refocus()
  }
  /** ⌥↩ 그 기록의 폴더로 오른쪽 분할 — 위험 명령 · 가린 자리가 든 명령(원래 값이 아니다)이면 넣기만 */
  const historySplit = (e: HistoryEntry) => {
    const task = stateRef.current.tasks.find((t) => t.id === stateRef.current.activeTaskId)
    if (!task || !task.activeTabId) return
    dispatch({ type: 'pane/split', taskId: task.id, dir: 'right', paneId: newId(), spec: { cwd: e.cwd, command: e.cmd, ...(isDangerous(e.cmd) || hasMask(e.cmd) ? { insert: true } : {}) } })
    refocus()
  }
  /** ⌘O 출력으로 — 누르는 순간 paneId 로 다시 찾는다(그 사이 닫혔으면 아무 일 없음) */
  const historyGoto = (e: HistoryEntry) => {
    const taskId = findPaneTask(stateRef.current, e.paneId)
    if (!taskId || !terminals.get(e.paneId)?.hasMarker(e.id)) return
    dispatch({ type: 'task/select', id: taskId })
    dispatch({ type: 'pane/focus', taskId, paneId: e.paneId })
    setPendingMarker({ paneId: e.paneId, id: e.id })
  }
  const historyNewTab = (e: HistoryEntry) => {
    const task = stateRef.current.tasks.find((t) => t.id === stateRef.current.activeTaskId)
    if (!task) return
    const paneId = newId()
    dispatch({ type: 'tab/add', taskId: task.id, tabId: newId(), paneId })
    dispatch({ type: 'pane/cwd', paneId, cwd: e.cwd })
    refocus()
  }
  /** 이 기록 지우기 — 화면에서 바로 숨기고, 파일에서는 알림(5초 · ⌘Z)이 끝난 뒤 */
  const historyRemove = (e: HistoryEntry) => {
    history.hide([e.id])
    showToast({
      text: '기록 1개를 지웠어요.',
      ms: 5000,
      action: { label: '되돌리기', run: () => history.unhide([e.id]) },
      onEnd: (undone) => {
        if (!undone) history.drop(e.taskId, [e.id])
      },
    })
  }
  // ─── 빠른 명령 (20단계) ───────────────────────────────────
  // 단추는 id 로만 들고 있다가 누르는 순간 다시 찾는다(확인 창 · 메뉴가 열린 사이 지워질 수 있다)
  const scopeOf = (r: QuickRef): QuickScope => (r.source === 'all' ? 'all' : { taskId: r.taskId })
  const refOf = (taskId: string, b: QuickButton): QuickRef => ({ taskId, source: b.source, id: b.qc.id })
  const runKeyOf = (r: QuickRef) => `${r.taskId}|${r.source === 'all' ? 'a' : 't'}:${r.id}`
  const quickGone = () => showToast({ text: '그 단추는 지워졌어요.' })

  const runQuick = (r: QuickRef, opts: { confirmed?: boolean; insertOnly?: boolean } = {}) => {
    const s = stateRef.current
    const task = s.tasks.find((t) => t.id === r.taskId)
    const qc = task ? findQuick(s, scopeOf(r), r.id) : null
    if (!task || !qc) return quickGone()
    if (qc.confirm && !opts.confirmed && !opts.insertOnly) return setQuickAsk({ ...r, qc })
    if (s.activeTaskId !== task.id) dispatch({ type: 'task/select', id: task.id })
    const activePane = task.tabs.find((t) => t.id === task.activeTabId)?.activePaneId ?? null
    const where = opts.insertOnly ? 'insert' : qc.where
    if (where === 'insert') {
      if (!activePane || terminals.get(activePane)?.insert(qc.command) !== true)
        showToast({ text: '입력줄에 넣지 못했어요.', sub: '터미널이 아직 뜨지 않았거나, 셸이 붙여넣기 보호를 켜지 않았어요.' })
      return refocus()
    }
    const target = activePane && terminals.has(activePane) ? { busy: activityRef.current[activePane]?.busy === true, integrated: integratedPanes.has(activePane) } : null
    const decided = decideRun(where, target)
    const spec = { cwd: resolveCwd(task.cwd, qc.cwd), command: qc.command }
    let paneId: string
    if (decided.where === 'current' && activePane) {
      paneId = activePane
      window.taskminal.pty.write(paneId, qc.command + '\r')
    } else if (decided.where === 'splitRight' || decided.where === 'splitDown') {
      paneId = newId()
      dispatch({ type: 'pane/split', taskId: task.id, dir: decided.where === 'splitRight' ? 'right' : 'down', paneId, spec })
    } else {
      paneId = newId()
      dispatch({ type: 'tab/add', taskId: task.id, tabId: newId(), paneId, spec })
    }
    const run: QuickRun = { paneId, sentAt: Date.now() }
    setQuickRuns((prev) => ({ ...prev, [runKeyOf(r)]: run }))
    if (decided.fallback)
      showToast({
        text: !target
          ? `그 일감의 터미널이 아직 뜨지 않아 새 탭에서 ‘${qc.label}’ 을 실행했어요.`
          : target.busy
            ? `지금 pane 이 바빠서 새 탭에서 ‘${qc.label}’ 을 실행했어요.`
            : `지금 pane 은 셸 통합이 없어 새 탭에서 ‘${qc.label}’ 을 실행했어요.`,
        sub: '프롬프트가 아닌 셸에는 끼워 넣지 않아요.',
      })
    refocus()
  }
  const quickStatusOf = (taskId: string) => (b: QuickButton) => {
    const run = quickRuns[`${taskId}|${b.runKey}`]
    return quickStatus(run, run ? integratedPanes.has(run.paneId) : false)
  }
  /** 실패 단추 말풍선 — 그 실행의 명령 기록 꼬리의 마지막 줄(가린 글) */
  const quickLastLine = (taskId: string) => (b: QuickButton) => {
    const run = quickRuns[`${taskId}|${b.runKey}`]
    if (!run) return null
    // 그 실행 = 보낸 뒤 그 pane 의 첫 기록 (같은 pane 의 다음 명령 기록이 아니라)
    const e = history.entries.find((h) => h.paneId === run.paneId && h.startedAt >= run.sentAt)
    return e?.tail.findLast((l) => l.trim() !== '') ?? null
  }
  const openQuickEditor = (taskId: string, r: QuickRef | null, command = '') => {
    const s = stateRef.current
    const qc = r ? findQuick(s, scopeOf(r), r.id) : null
    if (r && !qc) return quickGone()
    setQuickEdit({ taskId, ref: r, draft: draftOf(qc, r?.source === 'all' ? 'all' : 'task', command), fromTemplate: qc?.fromTemplate })
  }
  const saveQuickDraft = (d: QuickDraft) => {
    const ed = quickEdit
    if (!ed) return
    setQuickEdit(null)
    const s = stateRef.current
    const base = ed.ref ? findQuick(s, scopeOf(ed.ref), ed.ref.id) : null
    if (ed.ref && !base) return quickGone()
    if (d.scope === 'task' && !s.tasks.some((t) => t.id === ed.taskId)) return showToast({ text: '그 일감이 지워져 저장하지 않았어요.' })
    const keepCwd = d.where === 'newTab' || d.where === 'splitRight' || d.where === 'splitDown'
    const qc: QuickCommand = {
      id: ed.ref?.id ?? newId(),
      label: d.label.trim(),
      command: d.command.trim(),
      where: d.where,
      ...(keepCwd && d.cwd.trim() ? { cwd: d.cwd.trim() } : {}),
      ...(d.confirm ? { confirm: true as const } : {}),
      ...(base?.fromTemplate ? { fromTemplate: base.fromTemplate } : {}),
    }
    const scope: QuickScope = d.scope === 'all' ? 'all' : { taskId: ed.taskId }
    // 어디에 두나를 바꿨으면 옛 자리에서 빼고 새 자리에
    if (ed.ref && (ed.ref.source === 'all') !== (d.scope === 'all')) dispatch({ type: 'quick/remove', scope: scopeOf(ed.ref), id: ed.ref.id })
    dispatch({ type: 'quick/save', scope, qc })
    refocus()
  }
  const removeQuickButton = (r: QuickRef) => {
    const scope = scopeOf(r)
    const { removed, index } = dropQuick(stateRef.current, scope, r.id)
    if (!removed) return quickGone()
    dispatch({ type: 'quick/remove', scope, id: r.id })
    showToast({
      text: `‘${removed.label}’ 를 지웠어요.`,
      ms: 5000,
      action: { label: '되돌리기', run: () => dispatch({ type: 'quick/restore', scope, qc: removed, index }) },
    })
    refocus()
  }
  const quickMenuItems = (r: QuickRef): PopupItem[] => {
    const run = quickRuns[runKeyOf(r)]
    const failed = run !== undefined && quickStatus(run, integratedPanes.has(run.paneId)).kind === 'failed'
    const qc = findQuick(stateRef.current, scopeOf(r), r.id)
    return [
      { label: '실행…', run: () => runQuick(r) },
      { label: '입력줄에 넣기', key: '⇧↩', run: () => runQuick(r, { insertOnly: true }) },
      { label: '명령 복사', run: () => void navigator.clipboard.writeText(qc?.command ?? '').catch(() => {}) },
      { label: '고치기…', run: () => openQuickEditor(r.taskId, r) },
      ...(failed ? [{ label: '표시 지우기', run: () => setQuickRuns(({ [runKeyOf(r)]: _x, ...rest }) => rest) }] : []),
      { label: '지우기', danger: true, run: () => removeQuickButton(r) },
    ]
  }
  /** ⌥1~9 실행 · ⌥0 더 보기 — 처리했으면 true (아니면 셸로 보낸다) */
  const quickKey = (n: number, repeat: boolean): boolean => {
    if (document.querySelector('[aria-modal="true"], .menu-backdrop, .palette-backdrop')) return false
    const s = stateRef.current
    // 'Option 을 Meta 로' 면 ⌥숫자는 셸 · emacs 의 M-숫자 — 가로채지 않는다
    if (s.settings.optionAsMeta) return false
    const task = s.tasks.find((t) => t.id === s.activeTaskId)
    if (!task) return false
    const { shown, more } = quickButtons(task, s.settings.quickCommands)
    if (n === 0) {
      if (more.length === 0) return false
      const el = document.querySelector<HTMLElement>(`[data-testid="task-view"][aria-hidden="false"] [data-testid="quick-more"]`)
      const rect = el?.getBoundingClientRect()
      if (!repeat) setPopup({ kind: 'more', taskId: task.id, x: rect?.left ?? 200, y: (rect?.bottom ?? 60) + 2 })
      return true
    }
    const b = shown[n - 1]
    if (!b) return false
    if (!repeat) runQuick(refOf(task.id, b))
    return true
  }
  // pane 활동이 바뀔 때마다 단추 실행의 시작 · 끝을 굳힌다. 그 pane 이 닫혔으면 끝을 놓친 것으로(실행 중으로 남지 않게)
  useEffect(() => {
    setQuickRuns((prev) => {
      let changed = false
      const next: Record<string, QuickRun> = {}
      for (const [k, run] of Object.entries(prev)) {
        const r = findPaneTask(state, run.paneId) === null ? closeRun(run, Date.now()) : advanceRun(run, activity[run.paneId])
        if (r !== run) changed = true
        next[k] = r
      }
      return changed ? next : prev
    })
  }, [activity, state])
  const quickKeyRef = useRef(quickKey)
  quickKeyRef.current = quickKey

  // ─── 포트 (20단계) ────────────────────────────────────────
  const hiddenPorts = new Set(state.settings.hiddenPorts)
  const onPortsOpened = (opened: PortChip[], all: Record<string, PortChip[]>) => {
    const s = stateRef.current
    const hidden = new Set(s.settings.hiddenPorts)
    const shown = opened.filter((c) => !hidden.has(c.port))
    if (shown.length === 0) return
    for (const c of shown) {
      const clash = portConflict(c, all, (paneId) => findPaneTask(stateRef.current, paneId))
      if (clash) {
        const taskId = findPaneTask(s, c.paneId)
        const ownerTaskId = findPaneTask(s, clash.ownerPaneId)
        if (taskId && ownerTaskId) setPortClash({ ...clash, taskId, ownerTaskId })
        break
      }
    }
    // 처음 한 번만: 서버가 떴어요 · 눌러서 열어요
    if (!s.settings.portTipSeen) {
      const c = shown[0]!
      dispatch({ type: 'settings/patch', patch: { portTipSeen: true } })
      // 알림의 단추는 ⌘Z 를 받는다(되돌리기 자리) — 여는 일은 칩으로 안내만
      showToast({ text: `${c.port} 에서 서버가 떴어요 · 탭의 :${c.port} 를 눌러 열어요.` })
    }
  }
  const ports = usePorts(load.phase === 'ready', activity, windowFocused, onPortsOpened)
  const chipsOf = (ids: readonly string[]) => ids.flatMap((id) => ports.chips[id] ?? []).filter((c) => !hiddenPorts.has(c.port))
  const openPort = (c: PortChip) => {
    window.taskminal.openLink(portUrl(c.port))
  }
  const gotoPane = (paneId: string) => {
    const taskId = findPaneTask(stateRef.current, paneId)
    if (!taskId) return
    dispatch({ type: 'task/select', id: taskId })
    dispatch({ type: 'pane/focus', taskId, paneId })
    refocus()
  }
  const hidePort = (port: number) => {
    const s = stateRef.current
    if (s.settings.hiddenPorts.includes(port)) return
    dispatch({ type: 'settings/patch', patch: { hiddenPorts: [...s.settings.hiddenPorts, port] } })
    showToast({
      text: `${port} 를 숨겼어요.`,
      sub: '설정 › 터미널 › 숨긴 포트에서 다시 보여요.',
      ms: 5000,
      action: { label: '되돌리기', run: () => dispatch({ type: 'settings/patch', patch: { hiddenPorts: stateRef.current.settings.hiddenPorts.filter((p) => p !== port) } }) },
    })
    refocus()
  }
  const killPortNow = (c: PortChip) => {
    setPortKill(null)
    void window.taskminal.ports.kill(c.paneId, c.port, c.pid).then(
      (r) => {
        showToast({ text: r === 'killed' ? `${c.port} 의 ${c.proc} 를 껐어요.` : r === 'gone' ? `${c.port} 의 서버는 이미 꺼졌어요.` : `${c.port} 의 서버를 끄지 못했어요.` })
        ports.refresh()
      },
      () => showToast({ text: `${c.port} 의 서버를 끄지 못했어요.` }),
    )
    refocus()
  }
  const portMenuItems = (c: PortChip): PopupItem[] => [
    { label: `열기 — ${portUrl(c.port)}`, key: '↩', run: () => openPort(c) },
    { label: '주소 복사', run: () => void navigator.clipboard.writeText(portUrl(c.port)).catch(() => {}) },
    { label: '이 서버를 띄운 터미널로', run: () => gotoPane(c.paneId) },
    { label: '이 포트 끄기…', danger: true, run: () => setPortKill(c) },
    { label: '이 포트 숨기기', run: () => hidePort(c.port) },
  ]
  const tabPorts = (task: Task) => ({
    of: (tabId: string) => {
      const tab = task.tabs.find((t) => t.id === tabId)
      return tab ? chipsOf(paneIds(tab.layout)) : []
    },
    failed: ports.failed,
    onOpen: openPort,
    onMenu: (c: PortChip, x: number, y: number) => setPopup({ kind: 'port', chip: c, x, y }),
  })
  const paletteports = Object.values(ports.chips)
    .flat()
    .filter((c) => c.closedAt === undefined && !hiddenPorts.has(c.port))
    .map((c) => {
      const task = state.tasks.find((t) => t.id === findPaneTask(state, c.paneId))
      return { id: `${c.paneId}:${c.port}`, port: c.port, taskName: task?.name ?? '', proc: c.proc }
    })

  /** ⇧⌘F 결과로 — 그 일감 · 탭 · pane 을 보이게 하고 그 줄로 · ⌘F 막대에 같은 글자 */
  const findJump = (t: FindTarget, keepOpen: boolean) => {
    const taskId = findPaneTask(stateRef.current, t.paneId)
    if (!taskId) {
      showToast({ text: '그 pane 은 닫혔어요.' })
      return
    }
    dispatch({ type: 'task/select', id: taskId })
    dispatch({ type: 'pane/focus', taskId, paneId: t.paneId })
    setPendingReveal({ paneId: t.paneId, line: t.line, query: t.text })
    if (!keepOpen) {
      setGlobalFind(false)
      setFinding((f) => ({ paneId: t.paneId, signal: f.signal + 1, query: t.text }))
    }
  }

  const addTab = (taskId: string) => dispatch({ type: 'tab/add', taskId, tabId: newId(), paneId: newId() })
  const addTemplateTab = (taskId: string, templateId: string) => {
    const template = state.settings.templates.find((t) => t.id === templateId)
    if (!template) return
    dispatch({ type: 'tab/add-template', taskId, template, ids: Array.from({ length: templateIdCount(template) }, newId) })
    refocus()
  }
  const openSaveTemplate = (task: Task, tabId: string | null) => {
    const tab = tabId ? task.tabs.find((t) => t.id === tabId) : undefined
    if (tabId && !tab) return
    const template = tab ? tabToTemplate(task, tab.id, '', newId)! : taskToTemplate(task, '', newId)
    setSavingTemplate({ what: tab ? '탭' : '일감', initialName: tab ? tabLabel(task, tab) : task.name, template })
  }
  const saveTemplate = (name: string) => {
    // 이름은 대화상자가 templateNameError 로 막는다
    if (savingTemplate) dispatch({ type: 'template/add', template: { ...savingTemplate.template, name: name.trim() } })
    closeDialogs()
  }

  const closeTab = (task: Task, tabId: string, confirmed = false) => {
    const tab = task.tabs.find((t) => t.id === tabId)
    if (!tab) return
    const busy = busyPanes(paneIds(tab.layout))
    if (busy > 0 && !confirmed) return setConfirming({ kind: 'tab', taskId: task.id, tabId, busy })
    setConfirming(null)
    // 그 탭의 셸만 끝낸다 — 다른 탭 · 일감의 셸은 그대로.
    for (const paneId of paneIds(tab.layout)) {
      if (task.panes[paneId]?.kind === 'chat') window.taskminal.chat.close(paneId, true)
      else window.taskminal.pty.kill(paneId)
    }
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
    setSavingTemplate(null)
    setPaletteOpen(false)
    setGlobalFind(false)
    setClearingHistory(false)
    setQuickEdit(null)
    setQuickAsk(null)
    setPopup(null)
    setPortKill(null)
    refocus()
  }

  const remove = (task: Task) => {
    // 지우기 전 모습 — 아래 알림의 [되돌리기 ⌘Z] 가 이것으로 되살린다(25단계 '최근 지운 것' 전까지). 디스크엔 main 이 '지움' 백업을 만든다
    const before = stateRef.current
    // 그 일감의 셸을 모두 끝내고 목록에서 뺀다 (화면에서 빠지는 것만으로는 셸이 끝나지 않는다).
    for (const paneId of Object.keys(task.panes)) window.taskminal.pty.kill(paneId)
    dispatch({ type: 'task/remove', id: task.id })
    closeDialogs()
    showToast({
      text: `‘${task.name}’ 일감을 지웠어요.`,
      sub: '되돌리면 탭 · 폴더가 돌아오고 셸은 새로 열려요.',
      action: {
        label: '되돌리기',
        run: () => {
          const r = restoreTask(stateRef.current, before, task.id, newId)
          if (!r) return
          for (const id of r.kill) window.taskminal.pty.kill(id)
          dispatch({ type: 'state/replace', state: r.state })
          refocus()
        },
      },
      // 그 일감의 명령 기록은 되돌리기를 놓친 뒤 지운다 (되돌리면 그대로)
      onEnd: (undone) => {
        if (undone) return
        history.dropTask(task.id)
        // 대화 화면 기록도 되돌리기를 놓친 뒤 지운다 (프로세스는 일감이 빠질 때 이미 끝났다)
        for (const p of Object.values(task.panes)) if (p.kind === 'chat') window.taskminal.chat.close(p.id, true)
      },
    })
  }

  /** 백업 · 가져오기로 상태를 바꾼다 — 먼저 main 이 지금 모습을 백업(되돌리기 전 · 가져오기 전). 그게 실패하면 바꾸지 않는다 */
  const applyRestore = async (make: (cur: AppState) => Restored | null, mark: BackupMark): Promise<string | null> => {
    try {
      await window.taskminal.backup.mark(mark)
    } catch (e) {
      const why = e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)
      return `지금 모습을 백업하지 못해 바꾸지 않았어요 (${why})`
    }
    // 백업하는 동안 바뀐 것까지 — 지금 상태로 다시 만든다
    const r = make(stateRef.current)
    if (!r) return '되살릴 일감이 백업에 없어요'
    for (const id of r.kill) window.taskminal.pty.kill(id)
    dispatch({ type: 'state/replace', state: r.state })
    return null
  }

  /** 가린 칸 메뉴 '비밀값 아님' — 이 값만(해시) 화면 · 디스크에서 다시 가리지 않는다 */
  const allowSecret = (paneId: string, hit: { hash: string; kind: string }) => {
    const s = stateRef.current
    const where = s.tasks.find((t) => t.id === findPaneTask(s, paneId))?.name ?? ''
    dispatch({ type: 'settings/patch', patch: { secretAllow: [...s.settings.secretAllow.filter((a) => a.hash !== hit.hash), { hash: hit.hash, kind: hit.kind, where, at: Date.now() }] } })
    showToast({
      text: '이 값을 이제 가리지 않아요.',
      sub: '디스크에도 원문으로 남아요.',
      action: {
        label: '되돌리기',
        run: () => dispatch({ type: 'settings/patch', patch: { secretAllow: stateRef.current.settings.secretAllow.filter((a) => a.hash !== hit.hash) } }),
      },
    })
  }

  const activeTask = state.tasks.find((t) => t.id === state.activeTaskId) ?? null
  const dialogOpen = creating !== null || removing !== null || confirming !== null || savingTemplate !== null || paletteOpen || settingsOpen || hostConfirm !== null || firstRun !== null || globalFind || clearingHistory

  // 사이드바 '안 본 것'(21단계) — 일감을 떠날 때 · 고를 때 본 시각을 남긴다(저장하지 않는 값)
  const [seenAt, setSeenAt] = useState<Record<string, number>>({})
  const lastActiveTask = useRef<string | null>(null)
  useEffect(() => {
    const prev = lastActiveTask.current
    const cur = state.activeTaskId
    if (prev === cur) return
    lastActiveTask.current = cur
    const now = Date.now()
    setSeenAt((s) => ({ ...s, ...(prev ? { [prev]: now } : {}), ...(cur ? { [cur]: now } : {}) }))
  }, [state.activeTaskId])
  const unread = useMemo(() => unreadTasks(state, activity, seenAt), [state, activity, seenAt])
  const [filterSignal, setFilterSignal] = useState(0)

  // 상태에서 빠진 대화 pane(일감 지우기 · 되돌리기 · 백업 되살리기 …)의 claude 를 끝낸다 — 화면 기록은 지우는 쪽이 정한다
  const chatPaneIds = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (load.phase === 'loading') return
    const now = new Set(state.tasks.flatMap((t) => Object.values(t.panes).filter((p) => p.kind === 'chat').map((p) => p.id)))
    for (const id of chatPaneIds.current) if (!now.has(id)) window.taskminal.chat.close(id, false)
    chatPaneIds.current = now
  }, [state.tasks, load.phase])
  const isChatPane = (paneId: string) => {
    const s = stateRef.current
    return s.tasks.find((t) => t.id === findPaneTask(s, paneId))?.panes[paneId]?.kind === 'chat'
  }
  const chatAgentOf = (paneId: string) => {
    const s = stateRef.current
    return s.tasks.find((t) => t.id === findPaneTask(s, paneId))?.panes[paneId]?.chat?.agent ?? 'claude'
  }
  /** ⇧⌘J — 같은 자리에 새 id 의 터미널 pane 을 두고 claude --resume · codex resume. 대화 프로세스를 끝내고 화면 기록도 지운다(대화는 터미널이 같은 세션으로 잇는다 · 되돌리기 없음) */
  const chatToTerminalPane = (paneId: string) => {
    const bin = chatAgentOf(paneId) === 'codex' ? runtime.codexTui : runtime.claudeTui
    window.taskminal.chat.close(paneId, true)
    dispatch({ type: 'chat/to-terminal', paneId, newPaneId: newId(), bin })
    refocus()
  }
  /** 로그인 띠 — 같은 폴더 새 탭에서 claude(사용자가 /login) · codex login */
  const chatLogin = (paneId: string) => {
    const s = stateRef.current
    const task = s.tasks.find((t) => t.id === findPaneTask(s, paneId))
    const pane = task?.panes[paneId]
    if (!task || !pane) return
    const command = pane.chat?.agent === 'codex' ? `${runtime.codexTui} login` : runtime.claudeTui
    dispatch({ type: 'tab/add', taskId: task.id, tabId: newId(), paneId: newId(), spec: { cwd: pane.cwd, command } })
    refocus()
  }
  /** 나누기 (22단계) — main 이 그 턴까지의 기록을 새 pane 으로 쓴 뒤에 pane 을 만든다(마운트가 기록을 읽는다) */
  const chatBranch = async (paneId: string, index: number, at: number) => {
    const to = newId()
    // 나눌 수 없으면(칸이 좁음 · 아직 세션 없음) main 이 새 기록 파일을 쓰기 전에 멈춘다 — 남는 파일이 없게(리뷰)
    const canSplit = () => {
      const s = stateRef.current
      const tid = findPaneTask(s, paneId)
      const t = tid ? s.tasks.find((x) => x.id === tid) : undefined
      return t !== undefined && branchChat(t, paneId, to, 'probe') !== t
    }
    if (!canSplit()) return showToast({ text: '여기서 나누지 못했어요.', sub: '칸이 좁거나 아직 보낸 적 없는 대화예요.' })
    const r = await window.taskminal.chat.branch(paneId, to, index, at).catch(() => null)
    if (!r) return showToast({ text: '여기서 나누지 못했어요.', sub: '그 사이 대화가 바뀌었거나 아직 끝나지 않은 턴이에요.' })
    if (!isChatPane(paneId) || !canSplit()) {
      window.taskminal.chat.close(to, true) // 기다리는 사이 pane 이 닫혔다 · 좁아졌다 — 써 둔 기록을 지운다
      return
    }
    dispatch({ type: 'chat/branch', paneId, newPaneId: to, forkAt: r.forkAt, ...(r.sessionId ? { sessionId: r.sessionId } : {}) })
  }
  // ─── 변경 pane (23단계) ───
  const [reviewReq, setReviewReq] = useState<{ paneId: string; req: ReviewRequest } | null>(null)
  const [chatDraft, setChatDraft] = useState<{ paneId: string; text: string; n: number } | null>(null)
  /** ⇧⌘G · ⌘P · 대화 카드 — 변경 pane 을 열거나 그리로 가서 mode · 파일을 알린다. 만들 pane id 는 같은 순수 함수로 미리 안다 */
  const openReview = (taskId: string, mode: ReviewMode, file?: string) => {
    const task = stateRef.current.tasks.find((t) => t.id === taskId)
    if (!task) return
    const ids: [string, string] = [newId(), newId()]
    const left = [...ids]
    const found = findReviewPane(openReviewPane(task, () => left.shift()!))
    if (!found) return
    dispatch({ type: 'task/select', id: taskId })
    dispatch({ type: 'review/open', taskId, ids })
    setReviewReq({ paneId: found.paneId, req: { mode, ...(file ? { file } : {}), n: Date.now() } })
  }
  /** '대화에 묻기' · '고쳐 달라고 하기' — 그 일감의 대화 pane 입력칸에(보이는 탭 것 먼저), 없으면 대화로 오른쪽 나누기 */
  const askChat = (taskId: string, text: string) => {
    const task = stateRef.current.tasks.find((t) => t.id === taskId)
    if (!task) return
    const tab = task.tabs.find((t) => t.id === task.activeTabId)
    const inTab = tab ? paneIds(tab.layout).filter((id) => task.panes[id]?.kind === 'chat') : []
    const any = Object.values(task.panes).filter((x) => x.kind === 'chat').map((x) => x.id)
    const target = inTab[0] ?? any[0]
    if (target) {
      dispatch({ type: 'pane/focus', taskId, paneId: target })
      setChatDraft({ paneId: target, text, n: Date.now() })
      return
    }
    const paneId = newId()
    if (task.tabs.length === 0) dispatch({ type: 'chat/add-tab', taskId, tabId: newId(), paneId, agent: 'claude' })
    else dispatch({ type: 'chat/split', taskId, paneId, agent: 'claude' })
    setChatDraft({ paneId, text, n: Date.now() })
  }
  /** 빈 화면의 'git init 넣기' 등 — 일감 폴더 터미널을 오른쪽에 열고 넣기만(실행하지 않음) */
  const insertTerminal = (taskId: string, command: string) => {
    const task = stateRef.current.tasks.find((t) => t.id === taskId)
    if (!task) return
    if (task.tabs.length === 0) dispatch({ type: 'tab/add', taskId, tabId: newId(), paneId: newId(), spec: { cwd: task.cwd, command, insert: true } })
    else dispatch({ type: 'pane/split', taskId, dir: 'right', paneId: newId(), spec: { cwd: task.cwd, command, insert: true } })
    refocus()
  }
  const reviewStatus = state.settings.statuses.find((x) => x.name.includes('리뷰')) ?? null
  const reviewProps = (taskId: string) => ({
    request: reviewReq,
    toReview: reviewStatus ? { name: reviewStatus.name, run: () => dispatch({ type: 'task/edit', id: taskId, patch: { statusId: reviewStatus.id } }) } : null,
    onAskChat: (text: string) => askChat(taskId, text),
    onInsertTerminal: (command: string) => insertTerminal(taskId, command),
    onToast: showToast,
    onRequestTaken: (n: number) => setReviewReq((r) => (r?.req.n === n ? null : r)),
  })

  const chatProps = {
    permission: state.settings.chatPermission,
    onPermission: (p: ChatPermission) => dispatch({ type: 'settings/patch', patch: { chatPermission: p } }),
    onSession: (paneId: string, sessionId: string) => dispatch({ type: 'chat/session', paneId, sessionId }),
    onToTerminal: chatToTerminalPane,
    onOpenLogin: chatLogin,
    onRewound: (paneId: string, forkAt: string | null, sessionId?: string) => dispatch({ type: 'chat/rewound', paneId, forkAt, ...(sessionId ? { sessionId } : {}) }),
    onBranch: (paneId: string, index: number, at: number) => void chatBranch(paneId, index, at),
    onToast: (text: string, sub?: string) => showToast({ text, ...(sub ? { sub } : {}) }),
    onOpenDiff: (paneId: string, path: string) => {
      const taskId = findPaneTask(stateRef.current, paneId)
      if (taskId) openReview(taskId, 'diff', path)
    },
    draft: chatDraft,
    onDraftTaken: (n: number) => setChatDraft((d) => (d?.n === n ? null : d)),
  }

  const closePane = (paneId: string, confirmed = false) => {
    const act = activity[paneId]
    if (!confirmed && act?.busy) return setConfirming({ kind: 'pane', paneId, ...(act.command ? { command: screenMask ? screenMask(act.command) : act.command } : {}) })
    setConfirming(null)
    // 그 pane 의 셸만 끝내고 닫는다 — 마지막 pane 이면 탭도. 대화 pane 이면 claude 를 끝내고 화면 기록도 지운다(되돌리기 없음)
    if (isChatPane(paneId)) window.taskminal.chat.close(paneId, true)
    else window.taskminal.pty.kill(paneId)
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
      case 'host-view':
      case 'host-orphans':
        setSettingsSection('host')
        return setSettingsOpen(true)
      case 'backup-restore':
        setSettingsSection('backup')
        return setSettingsOpen(true)
      case 'privacy':
        setSettingsSection('privacy')
        return setSettingsOpen(true)
      case 'update-check':
        window.taskminal.update.action('check')
        setSettingsSection('about')
        return setSettingsOpen(true)
      case 'error-log':
        setSettingsSection('about')
        return setSettingsOpen(true)
      case 'first-run':
        return setFirstRun('again')
      case 'history':
        // 다시 누르면 닫는다 — 찾기 칸에 포커스가 있을 때는 칸이 키를 받는다(onKeyDown)
        if (historyOpen) {
          setHistoryOpen(null)
          return refocus()
        }
        return setHistoryOpen({ signal: Date.now() })
      case 'global-find':
        return setGlobalFind(true)
      case 'history-clear':
        return setClearingHistory(true)
      case 'mask-toggle': {
        const on = !state.settings.maskScreen
        dispatch({ type: 'settings/patch', patch: { maskScreen: on } })
        showToast({ text: on ? '화면에서 비밀값을 가려요.' : '화면에서 비밀값을 가리지 않아요.', sub: '디스크에는 늘 가려서 써요.' })
        return refocus()
      }
      case 'quit-all':
        return window.taskminal.host.action('quit-all')
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
      case 'status-next':
      case 'status-prev': {
        // 지금 일감을 이전 · 다음 상태 칸으로 (작은 고침 2026-11-11). 그 사이 지워졌으면 아무것도 안 한다
        const t = state.tasks.find((x) => x.id === state.activeTaskId)
        if (!t) return
        const to = stepStatus(state, t.id, command === 'status-next' ? 1 : -1)
        if (!to) {
          showToast({ text: command === 'status-next' ? '이미 마지막 상태예요.' : '이미 첫 상태예요.' })
          return refocus()
        }
        dispatch({ type: 'task/edit', id: t.id, patch: { statusId: to } })
        showToast({ text: `‘${t.name}’ → ${state.settings.statuses.find((x) => x.id === to)?.name ?? to}` })
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
      case 'sidebar-filter':
        setFilterSignal((n) => n + 1)
        return
      case 'review':
      case 'review-commit':
      case 'review-reverted':
        return openReview(task.id, command === 'review' ? 'diff' : command === 'review-commit' ? 'commit' : 'reverted')
      case 'chat-new':
      case 'chat-new-codex': {
        const agent = command === 'chat-new-codex' ? 'codex' : 'claude'
        dispatch({ type: 'chat/add-tab', taskId: task.id, tabId: newId(), paneId: newId(), agent })
        return refocus()
      }
      case 'chat-split':
      case 'chat-split-codex': {
        const agent = command === 'chat-split-codex' ? 'codex' : 'claude'
        if (task.tabs.length === 0) dispatch({ type: 'chat/add-tab', taskId: task.id, tabId: newId(), paneId: newId(), agent })
        else dispatch({ type: 'chat/split', taskId: task.id, paneId: newId(), agent })
        return refocus()
      }
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
      case 'find':
        // 보고 있는 pane 에 막대 — 이미 열려 있으면 입력칸으로 (15d)
        setFinding((f) => ({ paneId: tab.activePaneId, signal: f.signal + 1 }))
        return
      case 'mask-next':
      case 'mask-prev':
        // 가린 칸으로 포커스 — 그동안 키는 셸로 가지 않는다(칸이 버튼). 없으면 그대로
        terminals.get(tab.activePaneId)?.maskFocus(command === 'mask-next' ? 1 : -1)
        return
      case 'chat-terminal':
        if (task.panes[tab.activePaneId]?.kind !== 'chat') return showToast({ text: '대화 pane 에서만 터미널로 바꿀 수 있어요.' })
        return chatToTerminalPane(tab.activePaneId)
    }
  }
  // 팔레트에서 고른 것을 실행한다 — 팔레트는 먼저 닫는다
  const runPaletteItem = (item: PaletteItem, query: string, newTab: boolean, shift?: boolean) => {
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
      case 'history': {
        const e = history.entries.find((h) => h.id === item.id)
        if (e) historyInsert(e)
        return refocus()
      }
      case 'quick': {
        // id = `일감 id|t:단추` 또는 `일감 id|a:단추`(모든 일감 — 지금 일감에서)
        const [taskId, key] = item.id.split('|') as [string, string]
        const r: QuickRef = { taskId, source: key.startsWith('a:') ? 'all' : 'task', id: key.slice(2) }
        return runQuick(r, { insertOnly: shift === true })
      }
      case 'port': {
        const at = item.id.lastIndexOf(':')
        const paneId = item.id.slice(0, at)
        const port = Number(item.id.slice(at + 1))
        if (newTab) return gotoPane(paneId)
        window.taskminal.openLink(portUrl(port))
        return refocus()
      }
      case 'find-all':
        findMemo.current = { ...findMemo.current, query, selected: null }
        return setGlobalFind(true)
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
    // 보이게 된 다음 프레임(크기 맞춤 뒤)에. 아래 setPendingReveal(null) 의 다시 그리기가 이 프레임을 취소하지 않게 정리 함수는 두지 않는다.
    // 안 연 탭(⇧⌘F 저장된 출력)은 이제 막 셸을 띄우고 이전 출력을 되살리는 중 — 글자가 보일 때까지 3초 동안 다시 해 본다.
    // 찾으면 그 pane 의 ⌘F 막대(같은 글자로 열렸으면)도 그 자리부터 다시 센다
    let tries = 0
    const attempt = () => {
      const found = terminals.get(paneId)?.reveal(line, query) ?? false
      if (found) {
        if (findingRef.current.paneId === paneId && findingRef.current.query === query) terminals.get(paneId)?.find.next(query, true)
      } else if (++tries < 30) setTimeout(attempt, 100)
    }
    requestAnimationFrame(attempt)
    setPendingReveal(null)
  }, [pendingReveal])
  useEffect(() => {
    if (!pendingMarker) return
    const { paneId, id } = pendingMarker
    requestAnimationFrame(() => terminals.get(paneId)?.gotoMarker(id))
    setPendingMarker(null)
  }, [pendingMarker])

  const runCommandRef = useRef(runCommand)
  runCommandRef.current = runCommand

  useEffect(() => {
    // capture 단계에서 받는다. xterm 은 ⌘ 가 눌린 키를 셸로 보내지 않으므로(@xterm Keyboard.ts) 전파는 막지 않는다.
    const onKey = (e: KeyboardEvent) => {
      // 글을 고치는 칸(탭 이름 · 대화상자)에서는 ⌘ 키가 그 칸의 편집 몫 — ⌘W 가 뒤의 셸을 끝내지 않게. xterm 의 입력칸은 제외.
      const t = e.target
      if (t instanceof HTMLInputElement || (t instanceof HTMLTextAreaElement && !t.classList.contains('xterm-helper-textarea'))) return
      // 아래 알림의 되돌리기 — 알림이 떠 있을 때만 ⌘Z 를 앱이 받는다(17단계)
      const undo = toastRef.current?.action
      if (undo && e.metaKey && e.code === 'KeyZ' && !e.shiftKey && !e.altKey && !e.ctrlKey) {
        e.preventDefault()
        undo.run()
        setToast(null)
        return
      }
      // ⌥1~9 빠른 명령 · ⌥0 더 보기 (20단계) — 물리 키로(한글 · ⌥ 가 만드는 글자와 상관없이). 단추가 없으면 셸로 보낸다
      if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && /^Digit\d$/.test(e.code) && quickKeyRef.current(Number(e.code.slice(5)), e.repeat)) {
        e.preventDefault()
        e.stopPropagation()
        return
      }
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
          ? load.notice === 'recovered' && load.recoveredAt
            ? `저장 파일이 손상돼 ${dateClock(load.recoveredAt)} 백업으로 되살렸어요. 손상된 파일은 옆에(state.json.….bak) 남겨 뒀어요.`
            : NOTICE[load.notice]
          : null

  return (
    <div className="app">
      {message && (
        <p className="notice" role="status" data-testid="state-notice">
          {message}
        </p>
      )}
      {backupError && (
        <p className="notice" role="status" data-testid="backup-error">
          백업을 만들지 못했어요 ({backupError}) — 상태는 계속 저장돼요.
          <button type="button" className="link" onClick={() => setBackupError(null)}>
            닫기
          </button>
        </p>
      )}
      <HostBanners
        view={hostView}
        startup={startup}
        onOpenSettings={() => runCommand('host-view')}
        onNextAttention={() => runCommand('next-attention')}
        onConfirm={setHostConfirm}
      />
      <UpdateBanners
        view={updateView}
        crashed={runtime.crashedLast}
        later={laterVersion}
        onLater={setLaterVersion}
        onSkip={(version) => dispatch({ type: 'settings/patch', patch: { updateSkip: version } })}
        onOpenLog={() => runCommand('error-log')}
      />
      <div className="app-body">
        <Sidebar
          state={state}
          activity={shownActivity}
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
          onSaveTemplate={(task) => openSaveTemplate(task, null)}
          onMenuClosed={refocus}
          branches={branches}
          portsOf={(t) => chipsOf(Object.keys(t.panes))}
          updateChip={updateView?.state === 'downloaded' && updateView.version === laterVersion ? laterVersion : null}
          onUpdateChip={() => runCommand('error-log')}
          unread={unread}
          filterSignal={filterSignal}
          onView={(v) => dispatch({ type: 'settings/patch', patch: { sidebarView: v } })}
          onToggleSection={(key) => {
            const cur = stateRef.current.settings.sidebarClosed
            dispatch({ type: 'settings/patch', patch: { sidebarClosed: cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key] } })
          }}
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
                {(() => {
                  const { shown, more } = quickButtons(task, state.settings.quickCommands)
                  return (
                    <QuickBar
                      taskName={task.name}
                      shown={shown}
                      more={more}
                      statusOf={quickStatusOf(task.id)}
                      lastLineOf={quickLastLine(task.id)}
                      onRun={(b) => runQuick(refOf(task.id, b))}
                      onMenu={(b, x, y) => setPopup({ kind: 'quick', ...refOf(task.id, b), x, y })}
                      onMore={(x, y) => setPopup({ kind: 'more', taskId: task.id, x, y })}
                      onAdd={() => openQuickEditor(task.id, null)}
                    />
                  )
                })()}
                <TabBar
                  task={task}
                  activity={activity}
                  visible={taskActive}
                  ports={tabPorts(task)}
                  onSelect={(tabId) => dispatch({ type: 'tab/select', taskId: task.id, tabId })}
                  onAdd={() => addTab(task.id)}
                  onClose={(tabId) => closeTab(task, tabId)}
                  onRename={(tabId, title) => dispatch({ type: 'tab/rename', taskId: task.id, tabId, title })}
                  onDone={refocus}
                  onSplit={(dir) => dispatch({ type: 'pane/split', taskId: task.id, dir, paneId: newId() })}
                  templates={state.settings.templates}
                  onAddTemplate={(id) => addTemplateTab(task.id, id)}
                  onSaveTemplate={(tabId) => openSaveTemplate(task, tabId)}
                  historyOpen={historyOpen !== null}
                  onHistory={() => runCommand('history')}
                />
                {/* 겹침 알림은 탭 줄 바로 아래 — 아래 알림(Toast)이 화면 아래를 덮는다 */}
                {portClash && portClash.taskId === task.id && (
                  <PortConflictBar
                    port={portClash.port}
                    wanted={portClash.wanted}
                    ownerName={state.tasks.find((t) => t.id === portClash.ownerTaskId)?.name ?? '다른 일감'}
                    onOpen={() => window.taskminal.openLink(portUrl(portClash.port))}
                    onGoto={() => {
                      setPortClash(null)
                      gotoPane(portClash.ownerPaneId)
                    }}
                    onKillOwner={() => {
                      const owner = (ports.chips[portClash.ownerPaneId] ?? []).find((c) => c.port === portClash.wanted && c.closedAt === undefined)
                      setPortClash(null)
                      if (owner) setPortKill(owner)
                      else showToast({ text: `${portClash.wanted} 의 서버는 이미 꺼졌어요.` })
                    }}
                    onClose={() => {
                      setPortClash(null)
                      refocus()
                    }}
                  />
                )}
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
                          activity={shownActivity}
                          onActivity={updateActivity}
                          onFocusPane={(paneId) => dispatch({ type: 'pane/focus', taskId: task.id, paneId })}
                          onRatio={(path, ratio) => dispatch({ type: 'pane/ratio', taskId: task.id, tabId: tab.id, path, ratio })}
                          onClosePane={(paneId) => dispatch({ type: 'pane/exited', paneId })}
                          onStartSent={(paneId) => dispatch({ type: 'pane/command-sent', paneId })}
                          onCommandDone={onCommandDone}
                          onCwd={(paneId, cwd) => dispatch({ type: 'pane/cwd', paneId, cwd: cwdLike(cwd, task.cwd, runtime.home) })}
                          onDragEnd={refocus}
                          find={findProps}
                          mask={maskSettings}
                          onAllow={allowSecret}
                          chat={chatProps}
                          review={reviewProps(task.id)}
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
        {historyOpen && (
          <HistoryPanel
            view={history}
            tasks={state.tasks}
            activeTaskId={state.activeTaskId}
            activePaneId={activePaneNow}
            activity={historyActivity}
            signal={historyOpen.signal}
            onInsert={historyInsert}
            onRunSplit={historySplit}
            onGoto={historyGoto}
            onNewTab={historyNewTab}
            onSaveQuick={(e) => {
              // 그 기록이 난 일감에 (모든 일감 범위에서 다른 일감 기록을 골랐을 수 있다) — 지워진 일감이면 지금 일감에
              const taskId = state.tasks.some((t) => t.id === e.taskId) ? e.taskId : state.activeTaskId
              if (taskId) openQuickEditor(taskId, null, e.cmd)
            }}
            onRemove={historyRemove}
            onClose={() => {
              setHistoryOpen(null)
              refocus()
            }}
          />
        )}
      </div>
      {settingsOpen && (
        <SettingsView
          state={state}
          shortcuts={shortcuts}
          dispatch={dispatch}
          newId={newId}
          initialSection={settingsSection ?? undefined}
          busy={busyTotal}
          onRestore={applyRestore}
          onClearHistory={() => {
            setSettingsOpen(false)
            setSettingsSection(null)
            setClearingHistory(true)
          }}
          update={updateView}
          onFirstRun={() => {
            setSettingsOpen(false)
            setSettingsSection(null)
            setFirstRun('again')
          }}
          onClose={() => {
            setSettingsOpen(false)
            setSettingsSection(null)
            refocus()
          }}
        />
      )}
      {firstRun && (
        <FirstRun
          home={runtime.home}
          again={firstRun === 'again'}
          onCreate={(cwd) => {
            const name = cwd === runtime.home || cwd === '~' ? '홈' : cwd.replace(/\/+$/, '').split('/').pop() || '홈'
            create({ name, cwd: cwdLike(cwd, '~', runtime.home), templateId: null, statusId: state.settings.statuses[0]?.id ?? '', groupId: null, color: null })
          }}
          onDone={() => {
            if (firstRun === 'first') window.taskminal.firstRunDone()
            setFirstRun(null)
            refocus()
          }}
        />
      )}
      {toast && <Toast toast={toast} onDone={() => setToast((t) => (t?.id === toast.id ? null : t))} />}
      {creating && <NewTaskDialog state={state} initial={creating} onCreate={create} onCancel={closeDialogs} />}
      {paletteOpen && <Palette state={state} shortcuts={shortcuts} history={history.entries} ports={paletteports} onRun={runPaletteItem} onClose={closeDialogs} />}
      {popup?.kind === 'quick' && (
        <PopupMenu label="빠른 명령 메뉴" testId="quick-menu" x={popup.x} y={popup.y} items={quickMenuItems(popup)} onClose={(picked) => (setPopup(null), picked || refocus())} />
      )}
      {popup?.kind === 'more' &&
        (() => {
          const task = state.tasks.find((t) => t.id === popup.taskId)
          const more = task ? quickButtons(task, state.settings.quickCommands).more : []
          return (
            <PopupMenu
              label="빠른 명령 더 보기"
              testId="quick-more-menu"
              x={popup.x}
              y={popup.y}
              items={more.map((b) => ({ label: b.qc.label + (b.qc.confirm ? '…' : ''), run: () => runQuick(refOf(popup.taskId, b)) }))}
              onClose={(picked) => (setPopup(null), picked || refocus())}
            />
          )
        })()}
      {popup?.kind === 'port' && (
        <PopupMenu
          label={`포트 ${popup.chip.port} 메뉴`}
          heading={`:${popup.chip.port} · ${popup.chip.proc} (${popup.chip.pid})`}
          testId="port-menu"
          x={popup.x}
          y={popup.y}
          items={portMenuItems(popup.chip)}
          onClose={(picked) => (setPopup(null), picked || refocus())}
        />
      )}
      {quickEdit && <QuickEditor initial={quickEdit.draft} isNew={quickEdit.ref === null} fromTemplate={quickEdit.fromTemplate} taskName={state.tasks.find((t) => t.id === quickEdit.taskId)?.name ?? ''} onSave={saveQuickDraft} onCancel={closeDialogs} />}
      {quickAsk &&
        (() => {
          const task = state.tasks.find((t) => t.id === quickAsk.taskId)
          const where = quickAsk.qc.where === 'current' ? '지금 pane 에서 실행해요.' : `${WHERE_LABEL[quickAsk.qc.where]}에서 ${resolveCwd(task?.cwd ?? '~', quickAsk.qc.cwd)} 기준으로 실행해요.`
          return (
            <QuickConfirm
              qc={quickAsk.qc}
              where={where}
              onCancel={closeDialogs}
              onRun={(dontAsk) => {
                const r: QuickRef = { taskId: quickAsk.taskId, source: quickAsk.source, id: quickAsk.id }
                setQuickAsk(null)
                const now = findQuick(stateRef.current, scopeOf(r), r.id)
                if (dontAsk && now) {
                  const { confirm: _c, ...rest } = now
                  dispatch({ type: 'quick/save', scope: scopeOf(r), qc: rest })
                }
                runQuick(r, { confirmed: true })
              }}
            />
          )
        })()}
      {portKill && <PortKillConfirm chip={portKill} onKill={() => killPortNow(portKill)} onCancel={closeDialogs} />}
      {globalFind && (
        <GlobalFind
          state={state}
          redact={historyRedact}
          memo={findMemo.current}
          onMemo={(m) => (findMemo.current = m)}
          onJump={findJump}
          onClose={closeDialogs}
        />
      )}
      {clearingHistory && (
        <ConfirmDialog
          title="명령 기록 모두 지우기"
          message="모든 일감의 명령 기록을 지울까요? 되돌릴 수 없어요. 셸의 history(~/.zsh_history)는 그대로예요."
          confirmLabel="모두 지우기"
          onConfirm={() => {
            void history.clearAll().then(
              () => showToast({ text: '명령 기록을 모두 지웠어요.' }),
              () => showToast({ text: '명령 기록을 지우지 못했어요.' }),
            )
            closeDialogs()
          }}
          onCancel={closeDialogs}
        />
      )}
      {savingTemplate && (
        <TemplateNameDialog what={savingTemplate.what} initialName={savingTemplate.initialName} onSave={saveTemplate} onCancel={closeDialogs} />
      )}
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
      {hostConfirm && (
        <ConfirmDialog
          title={hostConfirm === 'restart' ? '셸 지킴이 다시 시작' : '옛 지킴이 바꾸기'}
          message={
            hostConfirm === 'restart'
              ? `셸이 모두 끝나요${busyTotal > 0 ? ` — 지금 실행 중인 명령 ${busyTotal}개도` : ''}. 폴더와 출력만 되살아나요.`
              : `옛 지킴이의 셸 ${hostView?.oldHost?.sessions ?? 0}개가 끝나요.`
          }
          confirmLabel={hostConfirm === 'restart' ? '다시 시작' : '지금 바꾸기'}
          onConfirm={() => {
            window.taskminal.host.action(hostConfirm)
            setHostConfirm(null)
            refocus()
          }}
          onCancel={() => {
            setHostConfirm(null)
            refocus()
          }}
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
