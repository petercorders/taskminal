// 28단계: 간격 척도 검사 — styles.css 의 padding · margin · gap 에 쓴 px 값이 4px 배수 척도(--space-*) 안에 있는지 센다.
// 척도: 0 · 2(반 칸 — 아이콘과 글자 사이 같은 좁은 틈만) · 4 · 8 · 12 · 16 · 20 · 24 · 32 · 40 · 48 · 64. 음수도 같은 척도(예: -4px).
// 쓰는 법: `node tool/check-spacing.mjs [css 파일]` — 척도 밖 값이 있으면 줄 번호와 함께 찍고 종료 코드 1.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const SPACE_SCALE = [0, 2, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64]
const PROPS = /^(padding|margin)(-(top|right|bottom|left|inline|block)(-(start|end))?)?$|^(row-|column-)?gap$/

/** css 글에서 척도 밖 간격 값을 모은다: [{ line, prop, value, decl }] 와 센 수 */
export function scanSpacing(css) {
  const blank = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')) // 줄 번호를 지키며 주석을 지운다
  const bad = []
  let total = 0
  let tokens = 0
  const re = /([a-z-]+)\s*:\s*([^;{}]+)(?=[;}])/g
  let m
  while ((m = re.exec(blank))) {
    const prop = m[1]
    if (!PROPS.test(prop)) continue
    const line = blank.slice(0, m.index).split('\n').length
    tokens += (m[2].match(/var\(--space-/g) ?? []).length
    for (const t of m[2].matchAll(/(-?\d*\.?\d+)px/g)) {
      const v = Number(t[1])
      if (Math.abs(v) > 64) continue // calc · max 안의 폭(760px 등)
      total++
      const ok = SPACE_SCALE.includes(Math.abs(v))
      if (!ok) bad.push({ line, prop, value: v, decl: `${prop}: ${m[2].trim()}` })
    }
  }
  return { bad, total, tokens }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2] ?? new URL('../src/renderer/styles.css', import.meta.url).pathname
  const { bad, total, tokens } = scanSpacing(readFileSync(file, 'utf8'))
  for (const b of bad) console.log(`${file}:${b.line}  ${b.decl}`)
  console.log(`간격 값 ${total + tokens}개 (var(--space-*) ${tokens} · px 직접 ${total}) 중 척도 밖 ${bad.length}개`)
  process.exit(bad.length ? 1 : 0)
}
