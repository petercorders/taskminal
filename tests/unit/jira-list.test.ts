import { describe, expect, it } from 'vitest'
import { JiraList } from '../../src/shared/jira-list'
import type { IssuePage, IssueRecord } from '../../src/shared/issues'

const issue = (key: string): IssueRecord => ({ provider: 'jira', id: key.replace(/\D/g, ''), key, title: key, body: '', url: `https://a.atlassian.net/browse/${key}`, state: 'To Do' })
function gated() {
  const calls: Array<{ jql: string; resolve(p: IssuePage): void; reject(e: Error): void }> = []
  const read = (jql: string) => new Promise<IssuePage>((resolve, reject) => { calls.push({ jql, resolve, reject }) })
  return { calls, read }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('Jira 목록 화면 상태', () => {
  it('늦게 도착한 옛 응답은 버린다 — 느린 첫 요청 · 빠른 둘째 요청 순서 뒤집기', async () => {
    const g = gated()
    const list = new JiraList(g.read, () => true, () => '오류')
    void list.load('old')
    list.reset() // 토큰을 바꿔 저장
    const second = list.load('old')
    g.calls[1]!.resolve({ items: [issue('NEW-2')] })
    await second
    g.calls[0]!.resolve({ items: [issue('OLD-1')] })
    await tick()
    expect(list.view.items.map((i) => i.key)).toEqual(['NEW-2'])
    expect(list.view.loading).toBe(false)
  })
  it('읽는 중 다시 누르면 같은 요청을 기다린다', async () => {
    const g = gated()
    const list = new JiraList(g.read, () => true, () => '오류')
    const a = list.load('q'), b = list.load('q')
    expect(a).toBe(b)
    expect(g.calls).toHaveLength(1)
    g.calls[0]!.resolve({ items: [issue('A-1')] })
    await a
  })
  it('안 보일 때 다시 읽기는 멈추고, 보이면 한 번 — 느린 읽기 중 알림 3번은 끝난 뒤 한 번', async () => {
    const g = gated()
    let visible = false
    const list = new JiraList(g.read, () => visible, () => '오류')
    list.refresh('q'); list.refresh('q')
    expect(g.calls).toHaveLength(0)
    visible = true
    list.resume('q')
    expect(g.calls).toHaveLength(1)
    list.refresh('q'); list.refresh('q'); list.refresh('q')
    expect(g.calls).toHaveLength(1)
    g.calls[0]!.resolve({ items: [] })
    await tick(); await tick()
    expect(g.calls).toHaveLength(2)
    g.calls[1]!.resolve({ items: [] })
    await tick(); await tick()
    expect(g.calls).toHaveLength(2)
  })
  it('실패하면 마지막으로 받은 목록과 받은 시각을 남기고 오류 글을 보인다', async () => {
    const g = gated()
    let now = 1000
    const list = new JiraList(g.read, () => true, (e) => `글:${(e as Error).message}`, () => now)
    const first = list.load('q'); g.calls[0]!.resolve({ items: [issue('A-1')], truncated: true }); await first
    now = 5000
    const second = list.load('q'); g.calls[1]!.reject(new Error('응답이 없어요')); await second
    expect(list.view).toMatchObject({ items: [{ key: 'A-1' }], truncated: true, at: 1000, loading: false, error: '글:응답이 없어요' })
  })
})
