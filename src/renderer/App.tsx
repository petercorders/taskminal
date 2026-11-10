import { useEffect, useReducer, useRef, useState } from 'react'
import { createTask, emptyState } from '../shared/model'
import type { LoadedState } from '../shared/ipc'
import type { NewTaskInput, Task } from '../shared/types'
import { ConfirmDialog } from './ConfirmDialog'
import { NewTaskDialog } from './NewTaskDialog'
import { Sidebar } from './Sidebar'
import { reducer } from './store'
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

/** 일감마다 보여 줄 pane: 활성 탭의 활성 pane (탭은 6단계, 분할은 7단계). */
function visiblePane(task: Task) {
  const tab = task.tabs.find((t) => t.id === task.activeTabId) ?? task.tabs[0]
  const pane = tab ? task.panes[tab.activePaneId] : undefined
  return pane ?? null
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
  // 한 번이라도 연 일감만 터미널(셸)을 띄운다 — 저장된 일감이 많아도 시작 때 셸을 한꺼번에 띄우지 않게.
  // 한 번 띄운 셸은 다른 일감으로 옮겨도 숨겨 둔 채 유지한다.
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set())
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

  const activeId = state.activeTaskId
  useEffect(() => {
    if (activeId && !opened.has(activeId)) setOpened((s) => new Set(s).add(activeId))
  }, [activeId, opened])

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
          {/* 전환해도 셸 · 화면이 남도록 모든 일감의 pane 을 마운트해 두고, 활성이 아닌 것은 숨긴다. */}
          {state.tasks.map((task) => {
            const pane = visiblePane(task)
            const active = task.id === state.activeTaskId
            const mounted = active || opened.has(task.id)
            return (
              <section
                key={task.id}
                className="task-view"
                style={{ display: active ? 'flex' : 'none' }}
                data-testid="task-view"
                data-task-name={task.name}
                aria-hidden={!active}
              >
                {pane && mounted && <TerminalPane paneId={pane.id} cwd={pane.cwd} active={active} focusSignal={focusSignal} />}
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
