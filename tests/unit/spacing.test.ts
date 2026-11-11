import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

// 28단계: 간격 척도 검사(tool/check-spacing.mjs) — padding · margin · gap 의 px 값은 4px 배수 척도(--space-*) 안에만 쓴다.
const SCRIPT = resolve(__dirname, '../../tool/check-spacing.mjs')
const dir = mkdtempSync(join(tmpdir(), 'taskminal-spacing-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function scan(css: string) {
  const file = join(dir, `t${Math.random().toString(36).slice(2)}.css`)
  writeFileSync(file, css)
  const r = spawnSync('node', [SCRIPT, file], { encoding: 'utf8' })
  return { code: r.status, out: r.stdout }
}

describe('간격 척도', () => {
  it('앱 styles.css 에는 척도 밖 간격 값이 없다', () => {
    const r = spawnSync('node', [SCRIPT], { encoding: 'utf8' })
    expect(r.stdout).toMatch(/척도 밖 0개/)
    expect(r.status).toBe(0)
  })
  it('척도 안의 값 · var(--space-*) · 0 · 척도 밖 속성(top · width)은 통과한다', () => {
    const r = scan('.a { padding: 4px 8px 12px 16px; margin: 0 auto; gap: var(--space-2); top: 7px; width: 13px; margin-left: -4px }')
    expect(r.code).toBe(0)
  })
  it('5 · 6 · 7 · 10 · 14px 같은 척도 밖 값은 줄 번호와 함께 잡는다', () => {
    const r = scan('.a {\n  padding: 6px 12px;\n}\n.b { gap: 10px }\n.c { margin: 0 0 5px }\n.d { padding-inline: 14px }')
    expect(r.code).toBe(1)
    expect(r.out).toContain(':2  padding: 6px 12px')
    expect(r.out).toContain('gap: 10px')
    expect(r.out).toContain('margin: 0 0 5px')
    expect(r.out).toContain('padding-inline: 14px')
    expect(r.out).toMatch(/척도 밖 4개/)
  })
  it('주석 안의 값과 calc 안의 큰 폭은 세지 않는다', () => {
    const r = scan('/* padding: 6px */\n.a { padding: 0 max(var(--space-4), calc((100% - 760px) / 2)) }')
    expect(r.code).toBe(0)
  })
})
