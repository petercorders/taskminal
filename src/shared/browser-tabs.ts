export interface BrowserTabMetadata { id: string; url?: string; title?: string }
export interface BrowserTaskTabs { taskId: string; remember: boolean; selectedTabId: string; tabs: BrowserTabMetadata[] }
export interface BrowserTabsJournal { tasks: BrowserTaskTabs[] }
export interface BrowserTabState { id: string; url: string; title: string; navigationEpoch: number }
export interface BrowserTaskState { taskId: string; remember: boolean; selectedTabId: string; selectionEpoch: number; tabs: BrowserTabState[] }
export interface BrowserCaptureTicket { taskId: string; tabId: string; navigationEpoch: number; selectionEpoch: number }
export const browserTabId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)
export const browserTaskId = (v: unknown): v is string => typeof v === 'string' && /^[\w-]{1,100}$/.test(v)
const fields = (v: unknown, allowed: string[]) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(key => allowed.includes(key))

export function browserPageUrl(raw: string): string {
  if (typeof raw !== 'string' || raw.length > 8192) throw new Error('주소가 너무 길어요')
  const url = new URL(raw)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('로그인 정보가 없는 http 또는 https 주소를 입력해 주세요')
  return url.href
}
export function storedBrowserUrl(raw: string, redact: (value: string) => string): string | undefined {
  try {
    const url = new URL(browserPageUrl(raw)); url.search = ''; url.hash = ''
    // 민감한 주소는 저장하지 않음. Decode only to detect secrets: never navigate
    // to a decoded or redacted destination, which could change URL semantics.
    let probe = url.href
    for (let pass = 0; pass < 8; pass++) {
      if (redact(probe) !== probe) return undefined
      if (!probe.includes('%')) return url.href
      probe = decodeURIComponent(probe)
    }
    if (probe.includes('%') || redact(probe) !== probe) return undefined
    return url.href
  } catch { return undefined }
}
export function validBrowserTabsJournal(value: unknown): value is BrowserTabsJournal {
  if (!fields(value, ['tasks'])) return false
  const tasks = (value as BrowserTabsJournal).tasks
  if (!Array.isArray(tasks) || tasks.length > 200 || new Set(tasks.map(task => task?.taskId)).size !== tasks.length) return false
  const ids = new Set<string>()
  return tasks.every(task => fields(task, ['taskId', 'remember', 'selectedTabId', 'tabs']) && browserTaskId(task.taskId) && typeof task.remember === 'boolean' && Array.isArray(task.tabs) && task.tabs.length >= 1 && task.tabs.length <= 6 && task.tabs.some(tab => tab?.id === task.selectedTabId) && task.tabs.every(tab => {
    if (!fields(tab, ['id', 'url', 'title']) || !browserTabId(tab.id) || ids.has(tab.id)) return false
    ids.add(tab.id)
    if (!task.remember && (tab.url !== undefined || tab.title !== undefined)) return false
    if (tab.title !== undefined && (typeof tab.title !== 'string' || tab.title.length > 300)) return false
    if (tab.url !== undefined && (typeof tab.url !== 'string' || storedBrowserUrl(tab.url, text => text) !== tab.url)) return false
    return true
  }))
}
