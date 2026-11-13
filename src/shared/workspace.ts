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
  browserShow(id: string, bounds: BrowserBounds | null): Promise<void>
  browserNavigate(id: string, url: string): Promise<void>
  browserAction(id: string, action: 'back' | 'forward' | 'reload' | 'stop' | 'close' | 'zoomIn' | 'zoomOut' | 'focus'): Promise<void>
  browserState(id: string): Promise<BrowserState>
  browserCapture(id: string, element: boolean): Promise<BrowserCapture>
}
