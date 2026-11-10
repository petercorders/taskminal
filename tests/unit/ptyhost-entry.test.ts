import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// 지킴이는 ELECTRON_RUN_AS_NODE 로 도는 node 프로세스라 electron 모듈이 없다 — import 하면 지킴이가 뜨자마자 죽는다.
// 지킴이 폴더와 그 폴더가 부르는 shared 파일을 읽어 막는다.
const dir = join(__dirname, '../../src/main/ptyhost')
const IMPORT = /(?:from\s*|import\s*\(\s*|require\(\s*)['"]([^'"]+)['"]/g

function importsOf(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(IMPORT)].map((m) => m[1]!)
}

describe('셸 지킴이 소스', () => {
  const files = readdirSync(dir).filter((f) => f.startsWith('host-') && f.endsWith('.ts'))
  it('지킴이 파일이 있다', () => {
    expect(files).toEqual(expect.arrayContaining(['host-core.ts', 'host-entry.ts']))
  })
  it.each(files)('%s 는 electron 도, main 의 다른 파일도 import 하지 않는다', (f) => {
    for (const spec of importsOf(join(dir, f))) {
      expect(spec).not.toBe('electron')
      // main 의 다른 파일(../index 등)은 electron 을 부를 수 있다 — 지킴이 폴더 안(./) 과 shared 만
      if (spec.startsWith('.')) expect(spec.startsWith('./') || spec.startsWith('../../shared/')).toBe(true)
    }
  })
})
