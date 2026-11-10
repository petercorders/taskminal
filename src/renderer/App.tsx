import { useEffect, useReducer, useRef, useState } from 'react'
import { paneIds } from '../shared/layout'
import { createTask, emptyState } from '../shared/model'
import type { LoadedState } from '../shared/ipc'
import type { NewTaskInput, Task } from '../shared/types'
import { ConfirmDialog } from './ConfirmDialog'
import { NewTaskDialog } from './NewTaskDialog'
import { Sidebar } from './Sidebar'
import { reducer } from './store'
import { TabBar, tabElementId, tabPanelId } from './TabBar'
import { TerminalPane } from './TerminalPane'

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
  const [creating, setCreating] = useState(false)
  const [removing, setRemoving] = useState<Task | null>(null)
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
        loadedRef.current = loaded.state
        dispatch({ type: 'loaded', state: loaded.state })
        setLoad({ phase: 'ready', readOnly: loaded.readOnly, notice: loaded.notice })
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

  const addTab = (taskId: string) => dispatch({ type: 'tab/add', taskId, tabId: newId(), paneId: newId() })

  const closeTab = (task: Task, tabId: string) => {
    const tab = task.tabs.find((t) => t.id === tabId)
    if (!tab) return
    // 그 탭의 셸만 끝낸다 — 다른 탭 · 일감의 셸은 그대로.
    for (const paneId of paneIds(tab.layout)) window.taskminal.pty.kill(paneId)
    dispatch({ type: 'tab/close', taskId: task.id, tabId })
    // 이웃 탭이 활성이 되면 그 터미널이, 마지막 탭이었으면 '새 탭' 버튼이 포커스를 받는다
    refocus()
  }

  const create = (input: NewTaskInput) => {
    dispatch({ type: 'task/create', task: createTask(input, state.settings, newId, Date.now()) })
    setCreating(false)
    refocus()
  }

  const closeDialogs = () => {
    setCreating(false)
    setRemoving(null)
    refocus()
  }

  const remove = (task: Task) => {
    // 그 일감의 셸을 모두 끝내고 목록에서 뺀다 (화면에서 빠지는 것만으로는 셸이 끝나지 않는다).
    for (const paneId of Object.keys(task.panes)) window.taskminal.pty.kill(paneId)
    dispatch({ type: 'task/remove', id: task.id })
    closeDialogs()
  }

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
          loading={load.phase === 'loading'}
          onSelect={(id) => dispatch({ type: 'task/select', id })}
          onNew={() => setCreating(true)}
          onRemove={setRemoving}
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
                  visible={taskActive}
                  onSelect={(tabId) => dispatch({ type: 'tab/select', taskId: task.id, tabId })}
                  onAdd={() => addTab(task.id)}
                  onClose={(tabId) => closeTab(task, tabId)}
                  onRename={(tabId, title) => dispatch({ type: 'tab/rename', taskId: task.id, tabId, title })}
                  onDone={refocus}
                />
                {task.tabs.map((tab) => {
                  const tabActive = tab.id === task.activeTabId
                  // 분할은 7단계 — 지금은 탭마다 활성 pane 하나
                  const pane = task.panes[tab.activePaneId]
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
                      {pane && mounted && (
                        <TerminalPane paneId={pane.id} cwd={pane.cwd} active={taskActive && tabActive} focusSignal={focusSignal} />
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
          {load.phase !== 'loading' && state.tasks.length === 0 && (
            <div className="empty" data-testid="empty-view">
              <h1>Taskminal</h1>
              <p className="hint">일감이 없습니다</p>
              <button type="button" className="button primary" onClick={() => setCreating(true)}>
                새 일감
              </button>
            </div>
          )}
        </main>
      </div>
      {creating && <NewTaskDialog settings={state.settings} onCreate={create} onCancel={closeDialogs} />}
      {removing && (
        <ConfirmDialog
          title="일감 지우기"
          message={`‘${removing.name}’ 일감을 지울까요? 터미널 ${Object.keys(removing.panes).length}개가 함께 종료됩니다.`}
          confirmLabel="지우기"
          onConfirm={() => remove(removing)}
          onCancel={closeDialogs}
        />
      )}
    </div>
  )
}
