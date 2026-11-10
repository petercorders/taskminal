import { useEffect, useState } from 'react'

// 2단계: 빈 화면. 사이드바 · 탭 · 터미널은 3·5·6단계에서 채운다.
export function App() {
  const [version, setVersion] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    window.taskminal.appInfo().then((info) => {
      if (alive) setVersion(info.version)
    })
    return () => {
      alive = false
    }
  }, [])

  return (
    <main className="empty">
      <h1>Taskminal</h1>
      <p className="version" data-testid="app-version">
        {version ?? ''}
      </p>
      <p className="hint">일감이 없습니다</p>
    </main>
  )
}
