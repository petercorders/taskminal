import { BrowserWindow, WebContentsView, session } from 'electron'
import { createHash } from 'node:crypto'
import { redact, type SecretOptions } from '../shared/redact'
import type { BrowserBounds, BrowserCapture, BrowserState } from '../shared/workspace'

export const safeBrowserUrl = (raw: string): string => {
  if (typeof raw !== 'string' || raw.length > 8192) throw new Error('주소가 너무 길어요')
  const url = new URL(raw)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('http 또는 https 주소를 입력해 주세요')
  return url.href
}
interface Entry {
  view: WebContentsView
  win: BrowserWindow
  state: BrowserState
  cleanup(): void
}
export class WorkspaceBrowser {
  constructor(private readonly secretOptions: () => SecretOptions = () => ({})) {}
  private entries = new Map<string, Entry>()
  private configuredPartitions = new Set<string>()
  private key(win: BrowserWindow, id: string) {
    return `${win.id}:${id}`
  }
  private entry(win: BrowserWindow, id: string): Entry {
    const key = this.key(win, id)
    const prior = this.entries.get(key)
    if (prior) return prior
    const partition = 'persist:task-browser-' + createHash('sha256').update(id).digest('hex').slice(0, 24)
    const ses = session.fromPartition(partition)
    if (!this.configuredPartitions.has(partition)) {
      this.configuredPartitions.add(partition)
      ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false))
      ses.setPermissionCheckHandler(() => false)
      ses.on('will-download', (event) => event.preventDefault())
    }
    const view = new WebContentsView({ webPreferences: { partition, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } })
    const e: Entry = { view, win, state: { url: '', title: '', loading: false, back: false, forward: false }, cleanup: () => {} }
    this.entries.set(key, e)
    const wc = view.webContents
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    wc.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'F6') {
        event.preventDefault()
        win.webContents.focus()
      }
    })
    wc.on('will-navigate', (event, url) => {
      try {
        safeBrowserUrl(url)
      } catch {
        event.preventDefault()
      }
    })
    wc.on('will-redirect', (event, url) => {
      try {
        safeBrowserUrl(url)
      } catch {
        event.preventDefault()
      }
    })
    const refresh = () => {
      if (wc.isDestroyed()) return
      e.state = {
        ...e.state,
        url: wc.getURL(),
        title: wc.getTitle(),
        loading: wc.isLoading(),
        back: wc.navigationHistory.canGoBack(),
        forward: wc.navigationHistory.canGoForward(),
      }
    }
    wc.on('did-start-loading', () => {
      delete e.state.error
      refresh()
    })
    wc.on('did-stop-loading', refresh)
    wc.on('did-navigate-in-page', refresh)
    wc.on('page-title-updated', refresh)
    wc.on('did-fail-load', (_event, code, _description, _url, main) => {
      if (main && code !== -3) e.state.error = `페이지를 열지 못했어요 (${code})`
    })
    const close = () => this.close(key)
    const parentContents = win.webContents
    win.on('closed', close)
    parentContents.on('render-process-gone', close)
    // Reload detaches native content until the trusted renderer explicitly lays it out again.
    const navigation = (_event: unknown, _url: string, inPlace: boolean, main: boolean) => {
      if (main && !inPlace) view.setVisible(false)
    }
    parentContents.on('did-start-navigation', navigation)
    e.cleanup = () => {
      win.removeListener('closed', close)
      parentContents.removeListener('render-process-gone', close)
      parentContents.removeListener('did-start-navigation', navigation)
    }
    return e
  }
  show(win: BrowserWindow, id: string, bounds: BrowserBounds | null) {
    if (bounds === null) {
      this.entries.get(this.key(win, id))?.view.setVisible(false)
      return
    }
    const e = this.entries.get(this.key(win, id))
    if (!e) return
    for (const other of this.entries.values()) if (other.win === win && other !== e) other.view.setVisible(false)
    const size = win.getContentBounds()
    const zoom = win.webContents.getZoomFactor()
    const x = Math.max(0, Math.min(size.width, Math.round(bounds.x * zoom))),
      y = Math.max(0, Math.min(size.height, Math.round(bounds.y * zoom)))
    e.view.setBounds({
      x,
      y,
      width: Math.max(0, Math.min(size.width - x, Math.round(bounds.width * zoom))),
      height: Math.max(0, Math.min(size.height - y, Math.round(bounds.height * zoom))),
    })
    if (!win.contentView.children.includes(e.view)) win.contentView.addChildView(e.view)
    e.view.setVisible(true)
  }
  async navigate(win: BrowserWindow, id: string, url: string) {
    const e = this.entry(win, id)
    await e.view.webContents.loadURL(safeBrowserUrl(url)).catch(() => {
      e.state.error = '페이지를 열지 못했어요. 주소와 서버를 확인해 주세요.'
    })
  }
  state(win: BrowserWindow, id: string): BrowserState {
    return this.entries.get(this.key(win, id))?.state ?? { url: '', title: '', loading: false, back: false, forward: false }
  }
  action(win: BrowserWindow, id: string, action: string) {
    if (action === 'close') return this.close(this.key(win, id))
    const wc = this.entries.get(this.key(win, id))?.view.webContents
    if (!wc) return
    if (action === 'focus') {
      win.focus()
      wc.focus()
    }
    if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
    if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
    if (action === 'reload') wc.reload()
    if (action === 'stop') wc.stop()
    if (action === 'zoomIn' || action === 'zoomOut') wc.setZoomFactor(Math.max(0.5, Math.min(2, wc.getZoomFactor() + (action === 'zoomIn' ? 0.1 : -0.1))))
  }
  async capture(win: BrowserWindow, id: string, element: boolean): Promise<BrowserCapture> {
    const wc = this.entries.get(this.key(win, id))?.view.webContents
    if (!wc) throw new Error('먼저 페이지를 열어 주세요')
    if (element) {
      const result: unknown = await wc.executeJavaScript(
        `new Promise(resolve => {
        let timer;
        const stop = value => { clearTimeout(timer); document.removeEventListener('click', pick, true); document.removeEventListener('keydown', key, true); resolve(value) };
        const key = e => { if (e.key === 'Escape') stop('선택을 취소했어요') };
        const pick = e => { e.preventDefault(); e.stopImmediatePropagation();
          const el = e.target; if (!(el instanceof Element)) return stop('요소를 고르지 못했어요');
          if (el.closest('input,textarea,select,[contenteditable]')) return stop('입력칸 내용은 수집하지 않아요');
          const clone = el.cloneNode(true); clone.querySelectorAll('script,style,input,textarea,select,[contenteditable]').forEach(n => n.remove());
          [clone,...clone.querySelectorAll('*')].forEach(n => [...n.attributes].forEach(a => { if (!['class','role','aria-label'].includes(a.name)) n.removeAttribute(a.name) }));
          const style = getComputedStyle(el);
          stop(JSON.stringify({selector: el.tagName.toLowerCase() + [...el.classList].filter(c=>/^[a-zA-Z_-][a-zA-Z0-9_-]*$/.test(c)).slice(0,4).map(c=>'.'+c).join(''), html: clone.outerHTML.slice(0,8000), style:{color:style.color,background:style.backgroundColor,font:style.font,padding:style.padding,display:style.display}}));
        };
        document.addEventListener('click',pick,true); document.addEventListener('keydown',key,true); timer=setTimeout(()=>stop('선택 시간이 지났어요. 다시 골라 주세요.'),20000);
      })`,
        true,
      )
      return { text: redact(String(result).slice(0, 12000), this.secretOptions()) }
    }
    const picture = await wc.capturePage()
    return { text: `웹 화면: ${redact(wc.getURL().replace(/[?#].*$/, ''), this.secretOptions())}`, dataUrl: picture.toDataURL() }
  }
  private close(key: string) {
    const e = this.entries.get(key)
    if (!e) return
    this.entries.delete(key)
    e.cleanup()
    if (!e.win.isDestroyed()) e.win.contentView.removeChildView(e.view)
    if (!e.view.webContents.isDestroyed()) e.view.webContents.close()
  }
  dispose() {
    for (const key of this.entries.keys()) this.close(key)
  }
}
