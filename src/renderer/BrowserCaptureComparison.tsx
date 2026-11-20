import { compareCaptureConditions, type CaptureForComparison } from '../shared/browser-capture-comparison'

const fieldLabel = { url: '주소', viewport: 'PNG 크기', theme: '브라우저 테마 설정', head: '일감 HEAD', zoom: '브라우저 확대' }
const stateLabel = { same: '같음', different: '다름', unknown: '미확인' }

export function BrowserCaptureComparison({ before, after, clear }: {
  before: CaptureForComparison; after: CaptureForComparison; clear(): void
}) {
  const conditions = compareCaptureConditions(before.conditions, after.conditions)
  return <section aria-label="전후 캡처 비교" className="capture-comparison">
    <div className="capture-comparison-grid">
      <figure><figcaption>변경 전</figcaption><img src={before.dataUrl} alt="변경 전 브라우저 화면" /></figure>
      <figure><figcaption>변경 후</figcaption><img src={after.dataUrl} alt="변경 후 브라우저 화면" /></figure>
    </div>
    <ul aria-label="캡처 조건">{conditions.map(row => <li key={row.field}>
      {fieldLabel[row.field]} · {stateLabel[row.state]} · {row.left ?? '미확인'} → {row.right ?? '미확인'}
    </li>)}</ul>
    <button type="button" className="button" onClick={clear}>비교 캡처 비우기</button>
  </section>
}
