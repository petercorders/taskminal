import { useEffect, useReducer, useState } from 'react'
import { emptyState } from '../shared/model'
import type { LoadedState } from '../shared/ipc'
import { reducer } from './store'
import { TerminalPane } from './TerminalPane'

type LoadStatus = { phase: 'loading' } | { phase: 'ready'; readOnly: boolean; notice: LoadedState['notice'] } | { phase: 'failed'; error: string }

const NOTICE: Record<NonNullable<LoadedState['notice']>, string> = {
  corrupt: '저장 파일이 손상돼 옆에 백업(state.json.….bak)해 두고 새로 시작했습니다.',
  newer: '더 새 버전의 Taskminal 이 만든 저장 파일이라 읽기 전용으로 열었습니다 — 바꾼 내용은 저장되지 않습니다.',
}

// 4단계: 상태를 읽고 바뀔 때마다 저장. 일감 화면(사이드바 · 탭)은 5·6단계, 터미널은 아직 하나.
export function App() {
  const [state, dispatch] = useReducer(reducer, undefined, emptyState)
  const [load, setLoad] = useState<LoadStatus>({ phase: 'loading' })

  useEffect(() => {
    let alive = true
    window.taskminal.state.load().then(
      (loaded) => {
        if (!alive) return
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
    if (canSave) window.taskminal.state.save(state)
  }, [state, canSave])

  const message =
    load.phase === 'failed'
      ? `저장 파일을 읽지 못해 이번 실행에서는 저장하지 않습니다: ${load.error}`
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
