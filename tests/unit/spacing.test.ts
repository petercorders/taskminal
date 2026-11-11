import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
  it('64px 를 넘는 값은 calc · max · min · clamp 밖이면 잡는다 (28c 리뷰)', () => {
    const r = scan('.a { padding: 80px }\n.b { margin-top: -96px }\n.c { gap: min(100px, 10%) }\n.d { padding-left: clamp(var(--space-2), 2vw, 120px) }')
    expect(r.code).toBe(1)
    expect(r.out).toContain(':1  padding: 80px')
    expect(r.out).toContain(':2  margin-top: -96px')
    expect(r.out).toMatch(/척도 밖 2개/)
  })
  it('한글 · 공백이 든 폴더에서도 기본 파일(../src/renderer/styles.css)을 찾는다 (28c 리뷰)', () => {
    const root = join(realpathSync(dir), '한글 폴더') // macOS 임시 폴더는 링크 — 실제 경로여야 스크립트가 '직접 실행' 으로 안다
    mkdirSync(join(root, 'tool'), { recursive: true })
    mkdirSync(join(root, 'src/renderer'), { recursive: true })
    copyFileSync(SCRIPT, join(root, 'tool/check-spacing.mjs'))
    writeFileSync(join(root, 'src/renderer/styles.css'), '.a { padding: 6px }')
    const r = spawnSync('node', [join(root, 'tool/check-spacing.mjs')], { encoding: 'utf8' })
    expect(r.stderr).toBe('')
    expect(r.stdout).toMatch(/척도 밖 1개/)
  })
})
