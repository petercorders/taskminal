import { useEffect, useRef, useState } from 'react'
import type { WorkspaceEntry, WorkspaceFile } from '../shared/workspace'
import type { ChatImage } from '../shared/chat'
import { PdfPreview } from './PdfPreview'

export function WorkspaceFiles({ root, onAttach }: { root: string; onAttach(text: string, images?: ChatImage[]): void }) {
  const [path, setPath] = useState(''),
    [query, setQuery] = useState('')
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]),
    [file, setFile] = useState<WorkspaceFile | null>(null)
  const [error, setError] = useState(''),
    [loading, setLoading] = useState(false)
  const [range, setRange] = useState({ from: 1, to: 100 }),
    [retry, setRetry] = useState(0),
    [rendered, setRendered] = useState(true)
  const generation = useRef(0)
  useEffect(() => {
    setPath('')
    setFile(null)
  }, [root])
  useEffect(() => {
    const n = ++generation.current
    setLoading(true)
    setError('')
    setFile(null)
    void window.taskminal.workspace
      .list(root, path)
      .then(
        (rows) => {
          if (generation.current === n) setEntries(rows)
        },
        () => {
          if (generation.current === n) setError('폴더를 읽지 못했어요. 권한과 경로를 확인해 주세요.')
        },
      )
      .finally(() => {
        if (generation.current === n) setLoading(false)
      })
    return () => {
      generation.current++
    }
  }, [root, path, retry])
  const open = async (entry: WorkspaceEntry) => {
    if (entry.directory) {
      setPath(entry.path)
      return
    }
    const n = ++generation.current
    setLoading(true)
    setError('')
    try {
      const f = await window.taskminal.workspace.read(root, entry.path)
      if (generation.current === n) {
        setFile(f)
        setRange({ from: 1, to: Math.min(100, f.text?.split('\n').length ?? 1) })
      }
    } catch {
      if (generation.current === n) setError('파일을 읽지 못했어요. 민감 파일·폴더 밖 경로·크기 제한을 확인해 주세요.')
    } finally {
      if (generation.current === n) setLoading(false)
    }
  }
  const attach = async () => {
    if (!file || loading) return
    const snapshot = file,
      n = generation.current
    setLoading(true)
    setError('')
    try {
      const latest = await window.taskminal.workspace.read(root, snapshot.path)
      if (generation.current !== n) return
      if (latest.signature !== snapshot.signature) {
        setError('파일이 바뀌었어요. 다시 열어 내용을 확인한 뒤 첨부해 주세요.')
        return
      }
      if (snapshot.kind === 'text') {
        const lines = snapshot.text!.split('\n')
        const from = Math.max(1, Math.min(lines.length, Math.trunc(range.from))),
          to = Math.max(from, Math.min(lines.length, Math.trunc(range.to)))
        if (to - from >= 2000) {
          setError('한 번에 2,000줄까지 확인하고 첨부할 수 있어요. 범위를 나눠 주세요.')
          return
        }
        const selected = lines.slice(from - 1, to).join('\n')
        if (selected.length > 40000) {
          setError('첨부할 범위를 40,000자 이하로 줄여 주세요.')
          return
        }
        onAttach(`파일 ${snapshot.path}:${from}-${to} (확인한 내용)\n\`\`\`\n${selected}\n\`\`\``)
      } else if (snapshot.kind === 'image') {
        if (snapshot.size > 5 * 1024 * 1024) {
          setError('대화에는 5 MB 이하 그림만 붙일 수 있어요.')
          return
        }
        const match = /^data:(image\/[^;]+);base64,(.*)$/.exec(snapshot.dataUrl ?? '')
        if (match && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(match[1]!))
          onAttach(`그림: ${snapshot.path}`, [{ name: snapshot.path.split('/').pop()!, mime: match[1] as ChatImage['mime'], data: match[2]! }])
      } else onAttach(`파일 참조 (내용 미전달): ${root}/${snapshot.path}\n필요하면 이 파일을 직접 읽어 주세요.`)
    } catch {
      if (generation.current === n) setError('파일이 사라졌거나 권한이 바뀌었어요. 다시 열어 주세요.')
    } finally {
      if (generation.current === n) setLoading(false)
    }
  }
  return (
    <div className="workspace-files" data-testid="workspace-files">
      <nav className="work-tools-row" aria-label="파일 경로">
        <button className="button" disabled={!path} onClick={() => setPath(path.split('/').slice(0, -1).join('/'))}>
          상위 폴더
        </button>
        <span className="work-path">{path || root}</span>
        <button className="button" onClick={() => setRetry((n) => n + 1)}>
          새로고침
        </button>
      </nav>
      <label className="work-tools-row">
        파일 이름 찾기
        <input value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      {error && <p role="alert">{error}</p>}
      {loading && <p role="status">읽는 중…</p>}
      <div className="work-files-layout">
        <div className="work-file-list" aria-label="파일 목록">
          {entries
            .filter((e) => e.name.toLowerCase().includes(query.toLowerCase()))
            .map((e) => (
              <button
                className="work-file-entry"
                key={e.path}
                draggable={!e.directory}
                onDragStart={(event) => event.dataTransfer.setData('application/x-taskminal-file', JSON.stringify({ root, path: e.path }))}
                onClick={() => void open(e)}
              >
                {e.directory ? '▸ ' : ''}
                {e.name}
              </button>
            ))}
          {!loading && entries.filter((e) => e.name.toLowerCase().includes(query.toLowerCase())).length === 0 && <p>맞는 파일이 없어요.</p>}
        </div>
        <div className="work-file-preview">
          {!file ? (
            <p>파일을 골라 내용을 확인하세요.</p>
          ) : (
            <>
              <div className="work-tools-row">
                <strong className="work-path">{file.path}</strong>
                <button
                  className="button"
                  onClick={() => void navigator.clipboard.writeText(`${root}/${file.path}`).catch(() => setError('경로를 복사하지 못했어요.'))}
                >
                  경로 복사
                </button>
              </div>
              {file.kind === 'text' && (
                <>
                  <div className="work-tools-row">
                    <label>
                      시작 줄
                      <input
                        aria-label="첨부 시작 줄"
                        type="number"
                        min={1}
                        value={range.from}
                        onChange={(e) => setRange({ ...range, from: Number(e.target.value) || 1 })}
                      />
                    </label>
                    <label>
                      끝 줄
                      <input
                        aria-label="첨부 끝 줄"
                        type="number"
                        min={range.from}
                        value={range.to}
                        onChange={(e) => setRange({ ...range, to: Number(e.target.value) || 1 })}
                      />
                    </label>
                    {/\.md$/i.test(file.path) && (
                      <button className="button" onClick={() => setRendered((v) => !v)}>
                        {rendered ? '소스 보기' : 'Markdown 미리보기'}
                      </button>
                    )}
                  </div>
                  {/\.md$/i.test(file.path) && rendered ? (
                    <div className="work-markdown">
                      {file
                        .text!.split('\n')
                        .slice(Math.max(0, Math.trunc(range.from) - 1), Math.max(0, Math.trunc(range.from) - 1) + 2000)
                        .map((line, i) =>
                          line.startsWith('### ') ? (
                            <h4 key={i}>{line.slice(4)}</h4>
                          ) : line.startsWith('## ') ? (
                            <h3 key={i}>{line.slice(3)}</h3>
                          ) : line.startsWith('# ') ? (
                            <h2 key={i}>{line.slice(2)}</h2>
                          ) : line.startsWith('- ') ? (
                            <div key={i}>• {line.slice(2)}</div>
                          ) : (
                            <p key={i}>{line}</p>
                          ),
                        )}
                    </div>
                  ) : (
                    <pre className="work-source">
                      {file
                        .text!.split('\n')
                        .slice(Math.max(0, Math.trunc(range.from) - 1), Math.max(0, Math.trunc(range.from) - 1) + 2000)
                        .map((line, i) => (
                          <span key={i}>
                            <span className="work-line-number">{i + Math.max(1, Math.trunc(range.from))}</span>
                            {line}
                            {'\n'}
                          </span>
                        ))}
                    </pre>
                  )}
                </>
              )}
              {file.kind === 'text' && <p className="dim small">시작 줄부터 2,000줄까지 표시합니다. 시작 줄을 바꾸면 다음 범위를 볼 수 있어요.</p>}
              {file.kind === 'image' && <img className="work-preview-image" src={file.dataUrl} alt={file.path} />}
              {file.kind === 'pdf' && <PdfPreview dataUrl={file.dataUrl!} name={file.path} />}
              {file.kind === 'binary' && <p>바이너리 파일 · {file.size.toLocaleString()}바이트</p>}
              <div className="work-tools-row">
                <button className="button primary" disabled={loading} onClick={() => void attach()}>
                  {file.kind === 'pdf' || file.kind === 'binary' ? '파일 참조를 대화에 추가' : '확인한 내용을 대화에 추가'}
                </button>
                <button
                  className="button"
                  onClick={() => void window.taskminal.workspace.external(root, file.path).catch(() => setError('외부 편집기로 열지 못했어요.'))}
                >
                  외부 편집기로 열기
                </button>
              </div>
              <p className="dim small">추가한 뒤 대화 입력칸에서 확인하고 보내세요. PDF·바이너리는 경로만 전달합니다.</p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
