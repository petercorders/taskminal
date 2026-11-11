import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { buildAppMenu } from '../../src/main/menu'
import { SHORTCUTS, shortcutTable } from '../../src/shared/keymap'

// electron 은 vitest 에서 뜨지 않는다 — buildFromTemplate 가 받은 틀을 그대로 돌려줘 메뉴 모양만 본다(vi.mock 은 import 위로 올라간다).
// 정적 import 라야 키 표(keymap.ts) · menu.ts 를 고칠 때 `vitest related` 가 이 시험을 고른다
// (e2e keys.spec 메뉴 대조는 전체 검사에서야 돈다 — 17단계 회고).
vi.mock('electron', () => ({
  app: { name: 'Taskminal', isPackaged: false },
  BrowserWindow: class {},
  Menu: { buildFromTemplate: (t: unknown) => t, setApplicationMenu: () => {} },
}))

function commandsOf(keys: Readonly<Record<string, string>> = {}): string[] {
  const out: string[] = []
  const walk = (items: readonly MenuItemConstructorOptions[]) => {
    for (const i of items) {
      if (i.id && !i.role) out.push(`${i.id}:${String(i.accelerator)}`)
      if (Array.isArray(i.submenu)) walk(i.submenu)
    }
  }
  walk(buildAppMenu(false, keys) as unknown as MenuItemConstructorOptions[])
  return out.sort()
}

describe('앱 메뉴 ↔ 키 표', () => {
  it('키가 있는 명령은 모두 메뉴에 한 번씩, 같은 단축키로', () => {
    expect(commandsOf()).toEqual(SHORTCUTS.filter((s) => s.accel).map((s) => `${s.command}:${s.accel}`).sort())
  })
  it('설정에서 바꾼 단축키도 메뉴 표시에 따른다', () => {
    const keys = { 'new-tab': 'Command+Shift+T' }
    const want = shortcutTable(keys).filter((s) => s.accel).map((s) => `${s.command}:${s.accel}`).sort()
    expect(commandsOf(keys)).toEqual(want)
  })
})
