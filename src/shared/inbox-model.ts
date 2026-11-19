// 66단계 받은편지함 화면 쪽 모델 — renderer 가 가진 목록이 기준이고 main 에는 바뀐 것만 보낸다(답을 기다리지 않는다).
// 처음 한 번 읽는 동안 생긴 알림 · 읽음은 읽어 온 목록과 id 로 합친다 — 읽기 답이 그 사이 바뀐 것을 덮지 않게.
import { INBOX_BODY_MAX, INBOX_TITLE, markInboxRead, mergeInbox, pruneInbox, type InboxApi, type InboxEntry, type InboxRead } from './inbox'
import type { NotifyKind } from './types'

export class InboxModel {
  entries: readonly InboxEntry[] = []
  private loaded = false
  /** 읽는 동안 들어온 읽음 표시 — 읽어 온 옛 항목에도 다시 적용한다 */
  private pendingReads: InboxRead[] = []
  /** 읽는 동안 지운 일감 · 비우기 — 읽어 온 목록이 되살리지 않게 */
  private removedTasks = new Set<string>()
  private cleared = false
  private readonly listeners = new Set<() => void>()
  constructor(
    private readonly api: InboxApi,
    private readonly now: () => number = Date.now,
    private readonly onError: (what: string, reason: unknown) => void = () => {},
  ) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private set(next: readonly InboxEntry[]) {
    if (next === this.entries) return
    this.entries = next
    this.listeners.forEach((l) => l())
  }
  /** 앱이 처음 읽힐 때 한 번 */
  load(): Promise<void> {
    return this.api.list().then((saved) => {
      const kept = this.cleared ? [] : saved.filter((e) => !this.removedTasks.has(e.taskId))
      let merged: readonly InboxEntry[] = mergeInbox(kept, this.entries, this.now())
      for (const how of this.pendingReads) merged = markInboxRead(merged, how)
      this.settle()
      this.set(merged)
    }, (reason) => {
      this.settle()
      this.onError('list', reason)
    })
  }
  private settle() {
    this.loaded = true
    this.pendingReads = []
    this.removedTasks.clear()
    this.cleared = false
  }
  /** 알림 하나를 남긴다 — 보고 있지 않은 pane 의 알림만 부른다(부르는 쪽이 정한다) */
  add(input: { id: string; kind: NotifyKind; taskId: string; paneId: string; body: string }): void {
    const entry: InboxEntry = { ...input, body: input.body.slice(0, INBOX_BODY_MAX), at: this.now(), title: INBOX_TITLE[input.kind], read: false }
    if (this.entries.some((e) => e.id === entry.id)) return
    this.set(pruneInbox([entry, ...this.entries], this.now()))
    this.api.add(entry).catch((reason) => this.onError('add', reason))
  }
  /** 읽음 — 바뀐 것이 없으면(안 읽은 것이 없으면) main 에 보내지 않는다 */
  read(how: InboxRead): void {
    if (!this.loaded) this.pendingReads.push(how)
    const next = markInboxRead(this.entries, how)
    if (next === this.entries && this.loaded) return
    this.set(next)
    this.api.read(how).catch((reason) => this.onError('read', reason))
  }
  /** 모두 읽음 — 화면에 있는 안 읽은 것만 id 로(처음 읽기가 실패했으면 보지 못한 파일의 것은 건드리지 않는다) */
  readAll(): void {
    const ids = this.entries.filter((e) => !e.read).map((e) => e.id)
    if (ids.length > 0) this.read({ ids })
  }
  /** 그 pane 을 봤다 — 안 읽은 것이 없으면 read 가 보내지 않는다 */
  viewed(paneId: string): void {
    this.read({ paneId, until: this.now() })
  }
  removeTask(taskId: string): void {
    if (!this.loaded) this.removedTasks.add(taskId)
    this.set(this.entries.filter((e) => e.taskId !== taskId))
    this.api.removeTask(taskId).catch((reason) => this.onError('remove', reason))
  }
  /** 비우기 — 실패하면 지운 목록을 되돌린다(파일에는 남아 있고, 다시 비울 수 있게) */
  clear(): Promise<void> {
    const before = this.entries
    const wasLoaded = this.loaded
    if (!wasLoaded) this.cleared = true
    this.set([])
    return this.api.clear().catch((reason: unknown) => {
      if (!wasLoaded && !this.loaded) this.cleared = false
      this.set(mergeInbox(before, this.entries, this.now()))
      throw reason
    })
  }
}
