import { TerminalPane } from './TerminalPane'

// 3단계: 창 전체에 셸 하나. 사이드바 · 탭 · 분할은 5·6·7단계에서.
export function App() {
  return (
    <main className="app">
      <TerminalPane paneId="pane-1" cwd="~" />
    </main>
  )
}
