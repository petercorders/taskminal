import { browserPageUrl, browserTabId, browserTaskId, storedBrowserUrl, validBrowserTabsJournal, type BrowserCaptureTicket, type BrowserTabsJournal, type BrowserTabState, type BrowserTaskState } from '../shared/browser-tabs'

interface Journal { load(fallback: BrowserTabsJournal): BrowserTabsJournal; save(value: BrowserTabsJournal): void }
export interface BrowserTabsDeps { id(): string; validTask(taskId: string): boolean; redact(value: string): string }
export class BrowserTabsStore {
  private tasks: BrowserTaskState[] = []
  private failure = ''
  private retired = new Set<string>()
  private restored = new Set<string>()
  private serialized = ''
  constructor(private readonly store: Journal, private readonly deps: BrowserTabsDeps) {
    try {
      const saved = store.load({ tasks: [] })
      if (!validBrowserTabsJournal(saved)) throw new Error('브라우저 탭 기록이 손상되어 원본을 보존했습니다.')
      this.tasks = saved.tasks.map(task => ({ ...task, selectionEpoch: 0, tabs: task.tabs.map(tab => ({ id: tab.id, url: tab.url ? storedBrowserUrl(tab.url, value => this.deps.redact(value)) ?? '' : '', title: this.safeTitle(tab.title ?? ''), navigationEpoch: 0 })) }))
      for (const task of this.tasks) for (const tab of task.tabs) this.restored.add(tab.id)
      this.serialized = JSON.stringify(saved)
    } catch (reason) { this.failure = reason instanceof Error ? reason.message : '브라우저 탭 기록을 읽지 못했습니다.' }
  }
  private ready() { if (this.failure) throw new Error(this.failure) }
  private safeTitle(value: string): string {
    // Reject oversized untrusted input rather than saving an unrecognizable
    // secret prefix. Recognize secrets in the complete bounded source first.
    return value.length > 64 * 1024 ? '' : this.deps.redact(value).slice(0, 300)
  }
  get failureReason(): string { return this.failure }
  /** The native owner coalesces untrusted page events; explicit metadata writes also flush. */
  flush() { this.commit(structuredClone(this.tasks)) }
  private require(tasks: BrowserTaskState[], taskId: string): BrowserTaskState {
    this.ready()
    const task = tasks.find(item => item.taskId === taskId)
    if (!this.deps.validTask(taskId) || !task) throw new Error('브라우저를 열 일감이 사라졌습니다.')
    return task
  }
  private requireTab(task: BrowserTaskState, tabId?: string): BrowserTabState {
    const tab = task.tabs.find(item => item.id === (tabId ?? task.selectedTabId))
    if (!tab) throw new Error('브라우저 탭이 닫혔습니다.')
    return tab
  }
  private blank(): BrowserTabState {
    const id = this.deps.id()
    if (!browserTabId(id) || this.retired.has(id) || this.tasks.some(task => task.tabs.some(tab => tab.id === id))) throw new Error('새 브라우저 탭 번호를 만들지 못했습니다.')
    return { id, url: '', title: '', navigationEpoch: 0 }
  }
  private commit(tasks: BrowserTaskState[]) {
    this.ready()
    try {
      const journal: BrowserTabsJournal = { tasks: tasks.map(task => ({ taskId: task.taskId, remember: task.remember, selectedTabId: task.selectedTabId, tabs: task.tabs.map(tab => {
        const url = task.remember ? storedBrowserUrl(tab.url, value => this.deps.redact(value)) : undefined
        const title = task.remember ? this.safeTitle(tab.title) : ''
        return { id: tab.id, ...(url ? { url } : {}), ...(title ? { title } : {}) }
      }) })) }
      if (!validBrowserTabsJournal(journal)) throw new Error('브라우저 탭 기록을 확인해 주세요.')
      const serialized = JSON.stringify(journal)
      if (serialized !== this.serialized) this.store.save(journal)
      this.serialized = serialized
      this.tasks = tasks
    } catch (reason) {
      this.failure = reason instanceof Error ? reason.message : '브라우저 탭을 저장하지 못했습니다.'
      throw new Error(this.failure)
    }
  }
  view(taskId: string): BrowserTaskState | null {
    this.ready()
    if (!this.deps.validTask(taskId)) return null
    let task = this.tasks.find(task => task.taskId === taskId)
    if (!task) return null
    if (task.tabs.some(tab => this.restored.has(tab.id))) {
      // App settings may load after this store. Resolve persisted destinations
      // against that authoritative policy before exposing anything for lazy load.
      const copy = structuredClone(this.tasks)
      task = copy.find(item => item.taskId === taskId)!
      const sanitized: string[] = []
      for (const tab of task.tabs) if (this.restored.has(tab.id)) {
        tab.url = tab.url ? storedBrowserUrl(tab.url, value => this.deps.redact(value)) ?? '' : ''
        tab.title = this.safeTitle(tab.title)
        sanitized.push(tab.id)
      }
      this.commit(copy) // A failed durable scrub must not return a restored URL.
      for (const id of sanitized) this.restored.delete(id)
    }
    return structuredClone(task)
  }
  openTask(taskId: string): BrowserTaskState {
    this.ready()
    if (!browserTaskId(taskId) || !this.deps.validTask(taskId)) throw new Error('현재 일감을 확인해 주세요.')
    const existing = this.view(taskId)
    if (existing) return existing
    if (this.tasks.length >= 200) throw new Error('브라우저 탭을 저장한 일감이 200개입니다. 삭제된 일감 기록을 정리해 주세요.')
    const tab = this.blank()
    const task: BrowserTaskState = { taskId, remember: false, selectedTabId: tab.id, selectionEpoch: 0, tabs: [tab] }
    this.commit([...structuredClone(this.tasks), task])
    return structuredClone(task)
  }
  createTab(taskId: string): BrowserTaskState {
    const copy = structuredClone(this.tasks), task = this.require(copy, taskId)
    if (task.tabs.length >= 6) throw new Error('일감마다 브라우저 탭은 6개까지 열 수 있습니다.')
    const tab = this.blank(); task.tabs.push(tab); task.selectedTabId = tab.id; task.selectionEpoch++
    this.commit(copy); return structuredClone(task)
  }
  selectTab(taskId: string, tabId: string): BrowserTaskState {
    const copy = structuredClone(this.tasks), task = this.require(copy, taskId)
    this.requireTab(task, tabId)
    if (task.selectedTabId !== tabId) { task.selectedTabId = tabId; task.selectionEpoch++ }
    this.commit(copy); return structuredClone(task)
  }
  closeTab(taskId: string, tabId?: string): BrowserTaskState {
    const copy = structuredClone(this.tasks), task = this.require(copy, taskId), tab = this.requireTab(task, tabId)
    task.tabs = task.tabs.filter(item => item.id !== tab.id)
    if (!task.tabs.length) task.tabs.push(this.blank())
    if (task.selectedTabId === tab.id) task.selectedTabId = task.tabs[0]!.id
    task.selectionEpoch++
    this.commit(copy); this.retired.add(tab.id); this.restored.delete(tab.id); return structuredClone(task)
  }
  setRemember(taskId: string, remember: boolean): BrowserTaskState {
    if (typeof remember !== 'boolean') throw new Error('주소 저장 설정을 확인해 주세요.')
    const copy = structuredClone(this.tasks), task = this.require(copy, taskId)
    task.remember = remember; this.commit(copy); return structuredClone(task)
  }
  beginNavigation(taskId: string, tabId?: string, url?: string, deferPersistence = false): BrowserTabState {
    const copy = structuredClone(this.tasks), task = this.require(copy, taskId), tab = this.requireTab(task, tabId)
    if (url !== undefined) { tab.url = browserPageUrl(url); tab.title = this.safeTitle(tab.title) }
    tab.navigationEpoch++
    if (deferPersistence) this.tasks = copy
    else this.commit(copy)
    // A new explicit destination is live state, not a saved destination to restore.
    if (url !== undefined) this.restored.delete(tab.id)
    return structuredClone(tab)
  }
  update(taskId: string, tabId: string, value: { url?: string; title?: string }, expectedEpoch?: number): boolean {
    this.ready()
    const copy = structuredClone(this.tasks), task = copy.find(item => item.taskId === taskId), tab = task?.tabs.find(item => item.id === tabId)
    if (!task || !tab || !this.deps.validTask(taskId) || (expectedEpoch !== undefined && tab.navigationEpoch !== expectedEpoch)) return false
    if (value.url !== undefined) {
      const url = value.url ? browserPageUrl(value.url) : ''
      if (tab.url !== url) { tab.url = url; tab.navigationEpoch++ }
    }
    if (value.title !== undefined) tab.title = this.safeTitle(value.title)
    this.tasks = copy; return true
  }
  captureTicket(taskId: string, tabId?: string): BrowserCaptureTicket {
    const task = this.require(this.tasks, taskId), tab = this.requireTab(task, tabId)
    if (task.selectedTabId !== tab.id) throw new Error('현재 선택한 브라우저 탭에서만 자료를 가져올 수 있습니다.')
    return { taskId, tabId: tab.id, navigationEpoch: tab.navigationEpoch, selectionEpoch: task.selectionEpoch }
  }
  validCapture(ticket: BrowserCaptureTicket): boolean {
    const task = this.view(ticket.taskId), tab = task?.tabs.find(item => item.id === ticket.tabId)
    return !!task && !!tab && task.selectedTabId === ticket.tabId && task.selectionEpoch === ticket.selectionEpoch && tab.navigationEpoch === ticket.navigationEpoch
  }
  invalidateCaptures(taskId: string) {
    this.ready()
    const task = this.tasks.find(item => item.taskId === taskId)
    if (task) task.selectionEpoch++
  }
  forgetTask(taskId: string) {
    this.ready()
    if (this.deps.validTask(taskId)) throw new Error('사용 중인 일감의 브라우저 기록은 지울 수 없습니다.')
    const task = this.tasks.find(item => item.taskId === taskId)
    this.commit(this.tasks.filter(item => item.taskId !== taskId))
    task?.tabs.forEach(tab => { this.retired.add(tab.id); this.restored.delete(tab.id) })
  }
  /** Call only after authoritative app state is loaded; valid archived tasks should remain valid here. */
  reconcile(): string[] {
    this.ready()
    const removed = this.tasks.filter(task => !this.deps.validTask(task.taskId))
    if (!removed.length) return []
    this.commit(this.tasks.filter(task => this.deps.validTask(task.taskId)))
    for (const task of removed) for (const tab of task.tabs) { this.retired.add(tab.id); this.restored.delete(tab.id) }
    return removed.map(task => task.taskId)
  }
}
