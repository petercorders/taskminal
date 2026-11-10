import { useEffect, useReducer, useRef, useState } from 'react'
import { emptyState } from '../shared/model'
import type { LoadedState } from '../shared/ipc'
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

// 4단계: 상태를 읽고 바뀔 때마다 저장. 일감 화면(사이드바 · 탭)은 5·6단계, 터미널은 아직 하나.
export function App() {
  const [state, dispatch] = useReducer(reducer, undefined, emptyState)
  const [load, setLoad] = useState<LoadStatus>({ phase: 'loading' })
  const [saveError, setSaveError] = useState<string | null>(null)
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

  const message =
    load.phase === 'failed'
      ? `저장 파일을 읽지 못해 이번 실행에서는 저장하지 않습니다: ${load.error}`
      : saveError
        ? `상태를 저장하지 못했습니다 (${saveError}) — 다음에 바뀔 때 다시 시도합니다.`
      : load.phase === 'ready' && load.notice
        ? NOTICE[load.notice]
        : null

  return (
    <main className="app">
      {message && (
        <p className="notice" role="status" data-testid="state-notice">
          {message}
        </p>
      )}
      <TerminalPane paneId="pane-1" cwd="~" />
    </main>
  )
}
