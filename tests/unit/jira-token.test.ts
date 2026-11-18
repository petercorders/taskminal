import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraStatus } from '../../src/shared/jira'

// 64단계: 일감 머리의 쓰기 단추가 따르는 토큰 여부 — 모듈 상태라 시험마다 새로 싣는다.
type Mod = typeof import('../../src/renderer/jira-token')
let m: Mod
const status = (token: boolean) => ({ token, storage: 'encrypted', site: '' }) as unknown as JiraStatus
const tick = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }
async function load() {
  vi.resetModules()
  m = await import('../../src/renderer/jira-token')
}

describe('Jira 토큰 여부 (일감 머리 쓰기 단추)', () => {
  beforeEach(load)
  it('처음 읽기가 실패하면 다음 머리가 그려질 때 다시 읽는다 · 읽는 중이면 또 읽지 않는다', async () => {
    const api = { status: vi.fn<() => Promise<JiraStatus>>() }
    api.status.mockRejectedValueOnce(new Error('No handler registered'))
    m.loadJiraToken(api)
    m.loadJiraToken(api)
    expect(api.status).toHaveBeenCalledTimes(1)
    await tick()
    let release!: (s: JiraStatus) => void
    api.status.mockReturnValueOnce(new Promise((r) => { release = r }))
    m.loadJiraToken(api)
    m.loadJiraToken(api)
    expect(api.status).toHaveBeenCalledTimes(2)
    release(status(true))
    await tick()
    // 답을 받은 뒤에는 머리가 그려질 때마다 읽지 않는다(패널의 저장 · 지움이 갱신한다)
    m.loadJiraToken(api)
    expect(api.status).toHaveBeenCalledTimes(2)
  })
  it('늦게 끝난 옛 읽기는 더 새 저장 · 지움의 답을 덮지 않는다', async () => {
    let old!: (s: JiraStatus) => void
    m.loadJiraToken({ status: () => new Promise<JiraStatus>((r) => { old = r }) })
    expect(m.jiraToken()).toBeNull()
    // 그 사이 패널에서 토큰을 지웠다
    m.trackJiraStatus(Promise.resolve(status(false)))
    await tick()
    expect(m.jiraToken()).toBe(false)
    old(status(true))
    await tick()
    expect(m.jiraToken()).toBe(false)
    // 더 새 저장은 따른다
    m.trackJiraStatus(Promise.resolve(status(true)))
    await tick()
    expect(m.jiraToken()).toBe(true)
  })
})
