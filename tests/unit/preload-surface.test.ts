import { expect, test, vi } from 'vitest'
import { PRELOAD_GROUPS, PRELOAD_SURFACE } from '../preload-surface'

// preload 를 electron 없이 불러 contextBridge 에 넘긴 객체를 붙잡는다.
const exposed = vi.hoisted(() => new Map<string, Record<string, unknown>>())
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (name: string, api: Record<string, unknown>) => exposed.set(name, api) },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn(), send: vi.fn() },
}))
import '../../src/preload/index'

// e2e window.spec 은 단계 끝 전체 검사에서만 돌아, preload 에 키를 더하고 목록을 안 고친 것이 늦게 드러났다(50 · 55 · 56단계).
// 이 시험은 preload 를 고친 턴의 `vitest related` 에서 바로 돈다.
test('preload 가 여는 키는 허용 목록(tests/preload-surface.ts)과 같다', () => {
  const api = exposed.get('taskminal')
  expect(api).toBeDefined()
  const actual = {
    apiKeys: Object.keys(api!),
    ...Object.fromEntries(PRELOAD_GROUPS.map((group) => [group, Object.keys(api![group] as object)])),
  }
  expect(actual).toEqual(PRELOAD_SURFACE)
})
