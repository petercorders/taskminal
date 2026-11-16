import { useEffect, useRef, useState } from 'react'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

/** PDF bytes are parsed by a local worker. No PDF JavaScript/actions or remote requests. */
export function PdfPreview({ dataUrl, name }: { dataUrl: string; name: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [page, setPage] = useState(1),
    [pages, setPages] = useState(0),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false)
  useEffect(() => {
    setPage(1)
  }, [dataUrl])
  useEffect(() => {
    let alive = true,
      cleanup = () => {}
    setLoading(true)
    setError('')
    void (async () => {
      const pdfjs = await import('pdfjs-dist')
      if (!alive) return
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
      const encoded = dataUrl.split(',')[1] ?? '',
        bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))
      const task = pdfjs.getDocument({ data: bytes, enableXfa: false, useSystemFonts: true, maxImageSize: 16_000_000 })
      cleanup = () => {
        void task.destroy()
      }
      const doc = await task.promise
      if (!alive) return
      setPages(doc.numPages)
      const sheet = await doc.getPage(Math.min(page, doc.numPages))
      if (!alive || !canvas.current) return
      const target = canvas.current,
        viewport = sheet.getViewport({ scale: Math.min(2, 800 / sheet.getViewport({ scale: 1 }).width, 4000 / sheet.getViewport({ scale: 1 }).height) })
      target.width = viewport.width
      target.height = viewport.height
      const render = sheet.render({ canvas: target, viewport })
      cleanup = () => {
        render.cancel()
        void task.destroy()
      }
      await render.promise
      if (alive) setLoading(false)
    })().catch(() => {
      if (alive) {
        setLoading(false)
        setError('PDF를 표시하지 못했어요. 암호화 여부와 파일을 확인해 주세요.')
      }
    })
    return () => {
      alive = false
      cleanup()
    }
  }, [dataUrl, page])
  return (
    <section aria-label={`PDF ${name}`}>
      <div className="work-tools-row">
        <button className="button" disabled={page <= 1 || loading} onClick={() => setPage((n) => n - 1)}>
          이전 페이지
        </button>
        <span>
          {page} / {pages || '…'}
        </span>
        <button className="button" disabled={page >= pages || loading} onClick={() => setPage((n) => n + 1)}>
          다음 페이지
        </button>
      </div>
      {loading && <p role="status">PDF 읽는 중…</p>}
      {error && <p role="alert">{error}</p>}
      <canvas ref={canvas} className="work-pdf-canvas" aria-label={`PDF ${page}페이지`} />
    </section>
  )
}
