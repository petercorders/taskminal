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

function itemsOf(keys: Readonly<Record<string, string>> = {}): MenuItemConstructorOptions[] {
  const out: MenuItemConstructorOptions[] = []
  const walk = (items: readonly MenuItemConstructorOptions[]) => {
    for (const i of items) {
      if (i.id && !i.role) out.push(i)
      if (Array.isArray(i.submenu)) walk(i.submenu)
    }
  }
  walk(buildAppMenu(false, keys) as unknown as MenuItemConstructorOptions[])
  return out
}
/** 단축키가 붙은 메뉴 항목 — 키 없는 항목(업데이트 확인… 등)은 키 표 대조에서 뺀다. 키가 있어야 할 명령이 키 없이 들어가면 기대 목록에서 빠져 실패한다 */
function commandsOf(keys: Readonly<Record<string, string>> = {}): string[] {
  return itemsOf(keys)
    .filter((i) => i.accelerator !== undefined)
    .map((i) => `${i.id}:${String(i.accelerator)}`)
    .sort()
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
  it('키 없는 메뉴 항목은 키 표에서 키 없는 명령만 — 업데이트 확인… 은 앱 메뉴에 (18단계)', () => {
    const unkeyed = itemsOf().filter((i) => i.accelerator === undefined)
    expect(unkeyed.map((i) => i.id)).toEqual(['update-check'])
    expect(unkeyed[0]!.label).toBe('업데이트 확인…')
    expect(SHORTCUTS.find((s) => s.command === 'update-check')!.accel).toBeFalsy()
  })
})
