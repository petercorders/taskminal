import { chmodSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installCli } from '../../src/main/cli-install'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0).reverse()) {
    try {
      chmodSync(d, 0o755)
    } catch {
      // 이미 지움
    }
    rmSync(d, { recursive: true, force: true })
  }
})
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'tm-install-'))
  dirs.push(d)
  return d
}
const SRC = '/Applications/Taskminal.app/Contents/Resources/bin/taskminal'

describe('installCli', () => {
  it('링크를 만들고, 다시 누르면 이미 설치', () => {
    const d = temp()
    expect(installCli(SRC, d)).toEqual({ kind: 'installed', path: join(d, 'taskminal') })
    expect(readlinkSync(join(d, 'taskminal'))).toBe(SRC)
    expect(installCli(SRC, d).kind).toBe('already')
  })

  it('옛 자리를 가리키는 우리 링크는 바꾸고, 남의 파일 · 링크는 덮지 않는다', () => {
    const d = temp()
    symlinkSync('/Users/me/old/Taskminal.app/Contents/Resources/bin/taskminal', join(d, 'taskminal'))
    expect(installCli(SRC, d).kind).toBe('installed')
    expect(readlinkSync(join(d, 'taskminal'))).toBe(SRC)

    const e = temp()
    writeFileSync(join(e, 'taskminal'), '#!/bin/sh\n')
    expect(installCli(SRC, e)).toEqual({ kind: 'conflict', path: join(e, 'taskminal') })
    const f = temp()
    symlinkSync('/opt/other/taskminal-cli', join(f, 'taskminal'))
    expect(installCli(SRC, f).kind).toBe('conflict')
  })

  it('쓸 수 없는 폴더면 칠 명령(따옴표)을 돌려준다', () => {
    const d = temp()
    const ro = join(d, "it's")
    mkdirSync(ro)
    chmodSync(ro, 0o555)
    dirs.push(ro)
    const r = installCli(SRC, ro)
    expect(r.kind).toBe('denied')
    if (r.kind === 'denied') expect(r.command).toBe(`sudo mkdir -p '${d}/it'\\''s' && sudo ln -sf '${SRC}' '${d}/it'\\''s/taskminal'`)
  })
})
