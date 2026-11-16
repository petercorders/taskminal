// 55단계 Jira 목록의 화면 상태 — 요청 번호로 옛 응답을 버리고, 읽기는 한 번에 하나, 안 보이면 다시 읽기를 미룬다.
import type { IssuePage, IssueRecord } from './issues'

export interface JiraListView {
  items: IssueRecord[]
  truncated: boolean
  /** 마지막으로 목록을 받은 시각 — 실패해도 남긴다 */
  at: number | null
  loading: boolean
  error: string
}
const EMPTY: JiraListView = { items: [], truncated: false, at: null, loading: false, error: '' }

export class JiraList {
  view: JiraListView = EMPTY
  private seq = 0
  private current: { jql: string; promise: Promise<void> } | null = null
  private again = false
  private readonly listeners = new Set<() => void>()
  constructor(
    private readonly read: (jql: string) => Promise<IssuePage>,
    private readonly visible: () => boolean,
    private readonly message: (reason: unknown) => string,
    private readonly now: () => number = Date.now,
  ) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private set(patch: Partial<JiraListView>) { this.view = { ...this.view, ...patch }; this.listeners.forEach((l) => l()) }
  /** 사용자가 누른 읽기 — 같은 JQL 을 읽는 중이면 그 요청을 기다린다 */
  load(jql: string): Promise<void> {
    if (this.current && this.current.jql === jql) return this.current.promise
    const seq = ++this.seq
    this.set({ loading: true, error: '' })
    const promise = this.read(jql).then((page) => {
      if (seq !== this.seq) return
      this.set({ items: page.items, truncated: !!page.truncated, at: this.now(), error: '' })
    }, (reason: unknown) => {
      if (seq !== this.seq) return
      this.set({ error: this.message(reason) })
    }).finally(() => {
      if (seq !== this.seq) return
      this.current = null
      this.set({ loading: false })
      if (this.again && this.visible()) { this.again = false; void this.load(jql) }
    })
    this.current = { jql, promise }
    return promise
  }
  /** 토큰 · 사이트가 바뀜 — 읽는 중인 옛 요청의 답은 버리고 처음부터 */
  reset(): void {
    this.seq++
    this.current = null
    this.again = false
    this.set(EMPTY)
  }
  /** 화면 복귀 같은 부수 다시 읽기 — 안 보이면 미루고, 읽는 중이면 끝난 뒤 한 번 */
  refresh(jql: string): void {
    if (!this.visible() || this.current) { this.again = true; return }
    void this.load(jql)
  }
  /** 다시 보임 — 미룬 다시 읽기를 한 번 */
  resume(jql: string): void {
    if (this.again && this.visible() && !this.current) { this.again = false; void this.load(jql) }
  }
}
