export interface WorkspaceEntry {
  name: string
  path: string
  directory: boolean
}
export interface WorkspaceFile {
  path: string
  signature: string
  size: number
  kind: 'text' | 'image' | 'pdf' | 'binary'
  text?: string
  dataUrl?: string
}
export interface BrowserState {
  url: string
  title: string
  loading: boolean
  back: boolean
  forward: boolean
  error?: string
}
export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}
export interface BrowserCapture {
  text: string
  dataUrl?: string
}
export interface WorkspaceApi {
  list(root: string, path: string): Promise<WorkspaceEntry[]>
  read(root: string, path: string): Promise<WorkspaceFile>
  external(root: string, path: string): Promise<void>
  browserTabs(id: string): Promise<import('./browser-tabs').BrowserTaskState>
  browserCreateTab(id: string): Promise<import('./browser-tabs').BrowserTaskState>
  browserSelectTab(id: string, tabId: string): Promise<import('./browser-tabs').BrowserTaskState>
  browserCloseTab(id: string, tabId?: string): Promise<import('./browser-tabs').BrowserTaskState>
  browserRemember(id: string, enabled: boolean): Promise<import('./browser-tabs').BrowserTaskState>
  browserShow(id: string, bounds: BrowserBounds | null, tabId?: string): Promise<void>
  browserNavigate(id: string, url: string, tabId?: string): Promise<void>
  browserAction(id: string, action: 'back' | 'forward' | 'reload' | 'stop' | 'close' | 'zoomIn' | 'zoomOut' | 'focus', tabId?: string): Promise<void>
  browserState(id: string, tabId?: string): Promise<BrowserState>
  browserCapture(id: string, element: boolean, tabId?: string): Promise<BrowserCapture>
}
