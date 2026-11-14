import { BrowserWindow, WebContentsView, session } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { redact, type SecretOptions } from '../shared/redact'
import type { BrowserBounds, BrowserCapture, BrowserState } from '../shared/workspace'
import { browserPageUrl, type BrowserTaskState } from '../shared/browser-tabs'
import type { BrowserTabsStore } from './browser-tabs-store'
import type { BrowserCommand } from '../shared/browser-automation'
import { snapshotScript, interactionScript, maskNodeFunction, restoreNodeFunction } from './browser-automation-scripts'
import { mkdir, writeFile, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export const safeBrowserUrl = browserPageUrl
interface Entry {
  automation?: { nonce: string; epoch: number; url: string }
  view: WebContentsView
  win: BrowserWindow
  state: BrowserState
  taskId: string
  tabId: string
  navigationEpoch: number
  visibilityEpoch: number
  visible: boolean
  fresh: boolean
  pickKey: string | null
  capturePending: boolean
  cleanup(): void
}
export class WorkspaceBrowser {
  constructor(private readonly secretOptions: () => SecretOptions, private readonly metadata: BrowserTabsStore, private readonly activeTask: (taskId: string) => boolean = () => true, private readonly captureDir?: string) {}
  private entries = new Map<string, Entry>()
  private errors = new Map<string, string>()
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private failure = ''
  private disposed = false
  private ready() { if (this.disposed || this.failure || this.metadata.failureReason) throw new Error(this.failure || this.metadata.failureReason || '브라우저가 종료되었습니다.') }
  private freeze(reason: unknown) {
    this.failure ||= reason instanceof Error ? reason.message : '브라우저 기록을 저장하지 못해 웹 화면을 닫았습니다.'
    clearTimeout(this.flushTimer); this.flushTimer = undefined
    for (const key of [...this.entries.keys()]) this.close(key)
  }
  private mutate<T>(operation: () => T): T {
    this.ready()
    try { return operation() }
    catch (reason) { if (this.metadata.failureReason) this.freeze(reason); throw reason }
  }
  private flush() {
    clearTimeout(this.flushTimer); this.flushTimer = undefined
    this.mutate(() => this.metadata.flush())
  }
  private scheduleFlush() {
    if (this.flushTimer !== undefined || this.failure || this.disposed) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      try { this.flush() } catch (reason) { this.freeze(reason) }
    }, 250)
  }
  private configuredPartitions = new Set<string>()
  private key(win: BrowserWindow, id: string, tabId: string) {
    return `${win.id}:${id}:${tabId}`
  }
  private tab(id: string, tabId?: string) {
    const task = this.metadata.view(id)
    const tab = task?.tabs.find(tab => tab.id === (tabId ?? task.selectedTabId))
    if (!task || !tab) throw new Error('브라우저 일감이나 탭이 닫혔습니다.')
    return { task, tab }
  }
  private entry(win: BrowserWindow, id: string, tabId: string): Entry {
    this.ready()
    if (!this.activeTask(id)) throw new Error('브라우저를 열 일감이 보관되었거나 사라졌습니다.')
    this.tab(id, tabId)
    if (win.isDestroyed()) throw new Error('앱 창이 닫혔습니다.')
    const key = this.key(win, id, tabId)
    const prior = this.entries.get(key)
    if (prior) return prior
    if (this.entries.size >= 24) throw new Error('열린 웹 화면이 24개입니다. 사용하지 않는 브라우저 탭을 먼저 닫아 주세요.')
    const partition = 'persist:task-browser-' + createHash('sha256').update(id).digest('hex').slice(0, 24)
    const ses = session.fromPartition(partition)
    if (!this.configuredPartitions.has(partition)) {
      this.configuredPartitions.add(partition)
      ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false))
      ses.setPermissionCheckHandler(() => false)
      ses.on('will-download', (event) => event.preventDefault())
    }
    const view = new WebContentsView({ webPreferences: { partition, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } })
    const e: Entry = { view, win, taskId: id, tabId, navigationEpoch: 0, visibilityEpoch: 0, visible: false, fresh: true, pickKey: null, capturePending: false, state: { url: '', title: '', loading: false, back: false, forward: false }, cleanup: () => {} }
    view.setVisible(false)
    this.entries.set(key, e)
    this.errors.delete(key)
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
    wc.on('did-start-navigation', (_event, _url, _inPlace, main) => {
      if (!main || this.entries.get(key) !== e || this.disposed) return
      e.navigationEpoch++
      try { this.mutate(() => this.metadata.beginNavigation(id, tabId, undefined, true)); this.scheduleFlush() } catch { this.close(key) }
    })
    const refresh = () => {
      if (wc.isDestroyed() || this.entries.get(key) !== e || this.disposed) return
      e.state = {
        ...e.state,
        url: /^https?:/.test(wc.getURL()) ? wc.getURL() : '',
        title: wc.getTitle(),
        loading: wc.isLoading(),
        back: wc.navigationHistory.canGoBack(),
        forward: wc.navigationHistory.canGoForward(),
      }
      try {
        if (!this.metadata.update(id, tabId, { ...(e.state.url ? { url: e.state.url } : {}), title: e.state.title })) this.close(key)
        else this.scheduleFlush()
      } catch { this.close(key) }
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
      if (main && !inPlace) this.hide(e)
    }
    parentContents.on('did-start-navigation', navigation)
    e.cleanup = () => {
      win.removeListener('closed', close)
      parentContents.removeListener('render-process-gone', close)
      parentContents.removeListener('did-start-navigation', navigation)
    }
    return e
  }
  private hide(entry: Entry) {
    this.cancelPick(entry)
    if (entry.visible) entry.visibilityEpoch++
    entry.visible = false
    entry.view.setVisible(false)
    if (!entry.win.isDestroyed() && entry.win.contentView.children.includes(entry.view)) entry.win.contentView.removeChildView(entry.view)
  }
  tabs(_win: BrowserWindow, id: string): BrowserTaskState { return this.mutate(() => this.metadata.openTask(id)) }
  create(win: BrowserWindow, id: string): BrowserTaskState {
    const state = this.mutate(() => this.metadata.view(id) ? this.metadata.createTab(id) : this.metadata.openTask(id))
    for (const entry of this.entries.values()) if (entry.win === win || entry.taskId === id) this.hide(entry)
    return state
  }
  select(win: BrowserWindow, id: string, tabId: string): BrowserTaskState {
    const state = this.mutate(() => this.metadata.selectTab(id, tabId))
    for (const entry of this.entries.values()) if ((entry.win === win || entry.taskId === id) && (entry.taskId !== id || entry.tabId !== tabId)) this.hide(entry)
    return state
  }
  closeTab(_win: BrowserWindow, id: string, tabId?: string): BrowserTaskState {
    const target = this.tab(id, tabId).tab.id
    const state = this.mutate(() => this.metadata.closeTab(id, target))
    for (const [key, entry] of this.entries) if (entry.taskId === id && entry.tabId === target) this.close(key)
    return state
  }
  remember(_win: BrowserWindow, id: string, enabled: boolean): BrowserTaskState { return this.mutate(() => this.metadata.setRemember(id, enabled)) }
  forgetTask(id: string) {
    this.mutate(() => this.metadata.forgetTask(id))
    for (const [key, entry] of this.entries) if (entry.taskId === id) this.close(key)
  }
  reconcileLive() {
    // Archived tasks retain metadata, but their live native pages must stop.
    // This cleanup must also work when metadata/state storage is read-only or failed.
    for (const [key, entry] of this.entries) if (!this.activeTask(entry.taskId)) this.close(key)
  }
  reconcile() {
    this.reconcileLive()
    const removed = this.mutate(() => this.metadata.reconcile())
    for (const [key, entry] of this.entries) if (removed.includes(entry.taskId)) this.close(key)
  }
  show(win: BrowserWindow, id: string, bounds: BrowserBounds | null, tabId?: string) {
    if (bounds === null) {
      for (const entry of this.entries.values()) if (entry.win === win && entry.taskId === id && (!tabId || entry.tabId === tabId)) this.hide(entry)
      return
    }
    const task = this.metadata.view(id)
    if (!task) return
    const selected = tabId ?? task.selectedTabId
    if (task.selectedTabId !== selected || !task.tabs.some(tab => tab.id === selected)) return
    if (!task.tabs.find(tab=>tab.id===selected)!.url && !this.entries.has(this.key(win,id,selected))) { for(const other of this.entries.values())if(other.win===win)this.hide(other);return }
    let e: Entry
    try { e = this.entry(win, id, selected) }
    catch (reason) { this.errors.set(this.key(win, id, selected), reason instanceof Error ? reason.message : '웹 화면을 만들지 못했습니다.'); throw reason }
    for (const other of this.entries.values()) if (other.win === win && other !== e) this.hide(other)
    if (e.fresh) {
      e.fresh = false
      const url = task.tabs.find(tab => tab.id === selected)!.url
      if (url) void this.navigate(win, id, url, selected).catch(() => {})
    }
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
    e.visible = true
  }
  async navigate(win: BrowserWindow, id: string, url: string, tabId?: string) {
    const safe = safeBrowserUrl(url)
    if (!this.metadata.view(id) && tabId === undefined) this.mutate(() => this.metadata.openTask(id))
    const target = this.tab(id, tabId).tab.id
    const e = this.entry(win, id, target)
    this.mutate(() => this.metadata.beginNavigation(id, target, safe))
    e.navigationEpoch++; e.fresh = false
    await e.view.webContents.loadURL(safe).catch((error:unknown) => {
      if(error instanceof Error&&error.message.includes('ERR_ABORTED'))return
      e.state.error = '페이지를 열지 못했어요. 주소와 서버를 확인해 주세요.'
    })
    if (this.entries.get(this.key(win, id, target)) !== e || !this.metadata.view(id)?.tabs.some(tab => tab.id === target)) throw new Error('주소를 여는 동안 탭이 닫혔습니다.')
  }
  state(win: BrowserWindow, id: string, tabId?: string): BrowserState {
    if (this.failure || this.metadata.failureReason) return { url: '', title: '', loading: false, back: false, forward: false, error: this.failure || this.metadata.failureReason }
    const task = this.metadata.view(id), tab = task?.tabs.find(tab => tab.id === (tabId ?? task.selectedTabId))
    if (!tab) return { url: '', title: '', loading: false, back: false, forward: false }
    const key = this.key(win, id, tab.id), entry = this.entries.get(key), error = this.errors.get(key)
    return { ...(entry?.state ?? { url: tab.url, title: tab.title, loading: false, back: false, forward: false }), ...(error ? { error } : {}) }
  }
  action(win: BrowserWindow, id: string, action: string, tabId?: string) {
    if (action === 'close') { this.closeTab(win, id, tabId); return }
    const target = this.tab(id, tabId)
    const e = this.entries.get(this.key(win, id, target.tab.id))
    const wc = e?.view.webContents
    if (!e || !wc) return
    if (action === 'focus') {
      if (!e.visible || target.task.selectedTabId !== target.tab.id) return
      win.focus()
      wc.focus()
    }
    if (['back', 'forward', 'reload', 'stop'].includes(action)) { e.navigationEpoch++; this.mutate(() => this.metadata.beginNavigation(id, target.tab.id)) }
    if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
    if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
    if (action === 'reload') wc.reload()
    if (action === 'stop') wc.stop()
    if (action === 'zoomIn' || action === 'zoomOut') wc.setZoomFactor(Math.max(0.5, Math.min(2, wc.getZoomFactor() + (action === 'zoomIn' ? 0.1 : -0.1))))
  }
  private async limited<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('자료 수집 응답을 확인하지 못했어요. 페이지를 확인한 뒤 다시 시도해 주세요.')),21000)})]) }
    finally { if(timer)clearTimeout(timer) }
  }
  async capture(win: BrowserWindow, id: string, element: boolean, tabId?: string): Promise<BrowserCapture> {
    const ticket = this.metadata.captureTicket(id, tabId)
    const key = this.key(win, id, ticket.tabId), entry = this.entries.get(key)
    const wc = entry?.view.webContents
    if (!entry || !wc || wc.isDestroyed() || !entry.visible) throw new Error('먼저 선택한 페이지를 열어 주세요')
    if (entry.capturePending || wc.isLoading()) throw new Error('앞선 자료 수집이나 페이지 이동이 끝난 뒤 다시 시도해 주세요.')
    const epoch = entry.navigationEpoch, visibility = entry.visibilityEpoch, url = wc.getURL()
    const check = () => {
      if (this.entries.get(key) !== entry || wc.isDestroyed() || !entry.visible || entry.navigationEpoch !== epoch || entry.visibilityEpoch !== visibility || wc.getURL() !== url || !this.metadata.validCapture(ticket)) throw new Error('자료를 가져오는 동안 페이지나 선택한 탭이 바뀌었습니다. 다시 시도해 주세요.')
    }
    entry.capturePending = true
    try {
    if (element) {
      const pickKey = 'taskminal-element-pick-' + randomUUID()
      entry.pickKey = pickKey
      const result: unknown = await this.limited(wc.executeJavaScript(
        `new Promise(resolve => {
        const cleanupKey = Symbol.for(${JSON.stringify(pickKey)});
        let timer;
        const stop = value => { clearTimeout(timer); document.removeEventListener('click', pick, true); document.removeEventListener('keydown', key, true); if (globalThis[cleanupKey] === stop) delete globalThis[cleanupKey]; resolve(value) };
        const key = e => { if (e.key === 'Escape') stop('선택을 취소했어요') };
        const pick = e => { e.preventDefault(); e.stopImmediatePropagation();
          const el = e.target; if (!(el instanceof Element)) return stop('요소를 고르지 못했어요');
          if (el.closest('input,textarea,select,[contenteditable]')) return stop('입력칸 내용은 수집하지 않아요');
          const clone = el.cloneNode(true); clone.querySelectorAll('script,style,input,textarea,select,[contenteditable]').forEach(n => n.remove());
          [clone,...clone.querySelectorAll('*')].forEach(n => [...n.attributes].forEach(a => { if (!['class','role','aria-label'].includes(a.name)) n.removeAttribute(a.name) }));
          const html = clone.outerHTML; if(html.length>8000)return stop('선택한 요소가 너무 커요. 더 작은 요소를 골라 주세요.');
          const style = getComputedStyle(el);
          stop(JSON.stringify({selector: el.tagName.toLowerCase() + [...el.classList].filter(c=>/^[a-zA-Z_-][a-zA-Z0-9_-]*$/.test(c)).slice(0,4).map(c=>'.'+c).join(''), html, style:{color:style.color,background:style.backgroundColor,font:style.font,padding:style.padding,display:style.display}}));
        };
        Object.defineProperty(globalThis, cleanupKey, {value:stop,configurable:true});
        document.addEventListener('click',pick,true); document.addEventListener('keydown',key,true); timer=setTimeout(()=>stop('선택 시간이 지났어요. 다시 골라 주세요.'),20000);
      })`,
        true,
      ))
      check()
      if(typeof result!=='string'||result.length>32000)throw new Error('선택한 자료가 너무 커요. 더 작은 요소를 골라 주세요.')
      try { const value:unknown=JSON.parse(result);if(!value||typeof value!=='object'||typeof(value as {html?:unknown}).html!=='string')throw new Error('형식') }
      catch { throw new Error(result.startsWith('{')?'선택한 자료를 확인하지 못했어요.':redact(result,this.secretOptions()).slice(0,200)) }
      return { text: redact(result, this.secretOptions()).slice(0,12000) }
    }
    const picture = await this.limited(wc.capturePage())
    check()
    return { text: `웹 화면: ${redact(wc.getURL().replace(/[?#].*$/, ''), this.secretOptions())}`, dataUrl: picture.toDataURL() }
    } finally { entry.capturePending = false; this.cancelPick(entry) }
  }
  private cancelPick(entry: Entry) {
    const key = entry.pickKey
    entry.pickKey = null
    if (!key || entry.view.webContents.isDestroyed()) return
    void entry.view.webContents.executeJavaScript(`(() => {const stop=globalThis[Symbol.for(${JSON.stringify(key)})];if(typeof stop==='function')stop('선택을 취소했어요');})()`, true).catch(() => {})
  }
  /** Hide form surfaces in every author shadow tree, including closed roots.
   * Embedded documents are hidden as a whole. Page scripts stay disabled until the
   * capture and restoration finish, so a page cannot insert an unmasked field.
   */
  private async maskedPicture(entry: Entry, check: () => void) {
    const wc = entry.view.webContents, debug = wc.debugger
    if (debug.isAttached()) throw new Error('다른 검사 도구가 연결되어 입력값을 안전하게 가릴 수 없어요. 검사 도구를 닫고 다시 해 주세요.')
    let owned = false, scriptsDisabled = false
    const restores: Array<{ objectId: string; style: string | null }> = []
    const group = 'taskminal-mask-' + randomUUID()
    const detached = () => { owned = false }
    const verify = () => { check(); if (!owned || !debug.isAttached()) throw new Error('입력값 가리기를 확인하지 못해 캡처를 취소했어요.') }
    const send = async (method: string, params?: Record<string, unknown>) => {
      verify()
      return this.limited(debug.sendCommand(method, params))
    }
    try {
      debug.attach('1.3'); owned = true
      debug.on('detach', detached)
      await send('DOM.enable')
      const { frameTree } = await send('Page.getFrameTree') as { frameTree: { frame: { id: string } } }
      const { executionContextId } = await send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: group }) as { executionContextId: number }
      // Emulation blocks page scripts while still allowing explicit inspector
      // evaluations and compositor captures. Pausing V8 alone can hang on an
      // idle document waiting for its next JavaScript statement.
      scriptsDisabled = true
      await send('Emulation.setScriptExecutionDisabled', { value: true })
      type Node = { nodeId: number; parentId?: number; localName: string; attributes?: string[]; shadowRootType?: string; contentDocument?: Node; shadowRoots?: Node[] }
      const { nodes } = await send('DOM.getFlattenedDocument', { depth: -1, pierce: true }) as { nodes: Node[] }
      if (!Array.isArray(nodes) || nodes.length > 100000) throw new Error('입력값을 모두 확인할 수 없어 캡처하지 않았어요.')
      const byId = new Map(nodes.map(node => [node.nodeId, node]))
      for (const node of nodes) {
        for (const child of [...(node.shadowRoots ?? []), ...(node.contentDocument ? [node.contentDocument] : [])]) {
          const flattened = byId.get(child.nodeId) ?? child
          byId.set(child.nodeId, { ...flattened, parentId: node.nodeId })
        }
      }
      const targets = new Set<number>()
      for (const node of nodes) {
        if (node.shadowRootType) {
          const host = byId.get(node.nodeId)?.parentId
          if (!host || !byId.has(host)) throw new Error('shadow 입력 영역의 경계를 확인하지 못했어요.')
          targets.add(host)
        }
        if (['input', 'textarea', 'select', 'iframe', 'frame', 'object', 'embed'].includes(node.localName) || node.attributes?.some((value, index) => index % 2 === 0 && value.toLowerCase() === 'contenteditable')) targets.add(node.nodeId)
      }
      if (targets.size > 1000) throw new Error('입력 영역이 너무 많아 안전하게 캡처하지 않았어요.')
      // Embedded documents are fully covered by their outer frame. Shadow
      // descendants still get individual masks: a top-layer dialog can escape
      // the host's opacity and visibility inheritance.
      const covered = (nodeId: number) => {
        const visited = new Set<number>()
        let parent = byId.get(nodeId)?.parentId
        while (parent) {
          if (visited.has(parent)) throw new Error('문서 경계를 확인하지 못했어요.')
          visited.add(parent)
          if (['iframe', 'frame', 'object', 'embed'].includes(byId.get(parent)?.localName ?? '')) return true
          parent = byId.get(parent)?.parentId
        }
        return false
      }
      for (const nodeId of targets) {
        if (covered(nodeId)) continue
        const { object } = await send('DOM.resolveNode', { nodeId, executionContextId, objectGroup: group }) as { object: { objectId?: string } }
        if (!object.objectId) throw new Error('입력값을 가릴 요소가 사라졌어요.')
        const result = await send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: maskNodeFunction, returnByValue: true }) as { exceptionDetails?: unknown; result: { value?: { style: string | null } } }
        if (result.exceptionDetails || !result.result.value || !('style' in result.result.value)) throw new Error('입력값을 안전하게 가리지 못해 캡처를 취소했어요.')
        restores.push({ objectId: object.objectId, style: result.result.value.style })
      }
      verify()
      // Electron capturePage can return a cached compositor frame from before
      // the masks. CDP captureScreenshot requests a fresh rendered surface.
      const picture = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }) as { data: string }
      verify()
      if (typeof picture.data !== 'string' || picture.data.length > 7000000) throw new Error('캡처가 5 MB를 넘어요')
      return Buffer.from(picture.data, 'base64')
    } finally {
      if (owned && debug.isAttached()) {
        try {
          for (const restore of restores.reverse()) await debug.sendCommand('Runtime.callFunctionOn', { objectId: restore.objectId, functionDeclaration: restoreNodeFunction, arguments: [{ value: restore.style }] }).catch(() => {})
          await debug.sendCommand('Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => {})
          if (scriptsDisabled) await debug.sendCommand('Emulation.setScriptExecutionDisabled', { value: false }).catch(() => {})
        } finally { if (owned && debug.isAttached()) debug.detach() }
      }
      debug.removeListener('detach', detached)
    }
  }
  async automate(win: BrowserWindow, command: BrowserCommand): Promise<unknown> {
    const id=command.task,tabId=command.tabId
    if(!this.activeTask(id))throw new Error('일감이 닫혔어요')
    if(command.action==='tabs')return this.tabs(win,id)
    const target=this.tab(id,tabId)
    if(target.task.selectedTabId!==tabId)throw new Error('선택한 브라우저 탭이 달라졌어요')
    if(command.action==='navigate'){
      const prior=this.state(win,id,tabId).url
      if(command.expectUrl!==undefined&&prior!==command.expectUrl)throw new Error('현재 페이지 주소가 예상과 달라 동작하지 않았어요')
      await this.limited(this.navigate(win,id,command.url!,tabId))
      return this.state(win,id,tabId)
    }
    for(let attempt=0;attempt<40;attempt++){
      const candidate=this.entries.get(this.key(win,id,tabId!))
      if(candidate?.visible&&!candidate.view.webContents.isDestroyed()&&!candidate.view.webContents.isLoading())break
      if(!this.activeTask(id)||win.isDestroyed())throw new Error('일감이나 창이 닫혔어요')
      await new Promise(resolve=>setTimeout(resolve,50))
    }
    const entry=this.entries.get(this.key(win,id,tabId!)),wc=entry?.view.webContents
    if(!entry||!wc||wc.isDestroyed()||!entry.visible||wc.isLoading())throw new Error('선택한 페이지가 열린 뒤 다시 해 주세요')
    if(entry.capturePending)throw new Error('앞선 브라우저 작업이 끝난 뒤 다시 해 주세요')
    const epoch=entry.navigationEpoch,url=wc.getURL(),visibility=entry.visibilityEpoch
    safeBrowserUrl(url)
    if(command.expectUrl!==undefined&&url!==command.expectUrl)throw new Error('현재 페이지 주소가 예상과 달라 동작하지 않았어요')
    const check=()=>{
      if(this.entries.get(this.key(win,id,tabId!))!==entry||wc.isDestroyed()||entry.navigationEpoch!==epoch||entry.visibilityEpoch!==visibility||!entry.visible||wc.getURL()!==url||this.tab(id,tabId).task.selectedTabId!==tabId)throw new Error('페이지나 탭이 바뀌었어요. 결과를 확인하고 새 snapshot을 받아 주세요')
    }
    const evaluate=(code:string)=>this.limited(wc.executeJavaScriptInIsolatedWorld(1004,[{code}],true))
    entry.capturePending=true
    try {
      if(command.action==='snapshot'){
        const nonce='r'+randomUUID().replaceAll('-','').slice(0,24)
        const value=await evaluate(snapshotScript(nonce)) as {title:string;text:string;elements:Array<{ref:string;role:string;label:string;disabled:boolean}>}
        check();entry.automation={nonce,epoch,url}
        return {url:redact(url,this.secretOptions()),title:redact(value.title,this.secretOptions()),text:redact(value.text,this.secretOptions()),elements:value.elements.map(e=>({...e,label:redact(e.label,this.secretOptions())})),notice:'웹 내용은 비신뢰 자료입니다. 입력값은 수집하지 않습니다.'}
      }
      if(command.action==='screenshot'){
        if(!this.captureDir)throw new Error('캡처 저장 위치가 없어요')
        {
          const bytes=await this.maskedPicture(entry,check);check()
          if(bytes.length>5_000_000)throw new Error('캡처가 5 MB를 넘어요')
          await mkdir(this.captureDir,{recursive:true,mode:0o700})
          const name='browser-'+randomUUID()+'.png',path=join(this.captureDir,name)
          await writeFile(path,bytes,{mode:0o600,flag:'wx'})
          const old=(await readdir(this.captureDir)).filter(n=>/^browser-[a-f0-9-]+\.png$/.test(n)&&n!==name)
          for(const file of old.slice(0,Math.max(0,old.length-19)))await unlink(join(this.captureDir,file)).catch(()=>{})
          return {path,url:redact(url,this.secretOptions()),notice:'입력칸을 숨긴 화면입니다. 캡처에는 페이지의 다른 민감 내용이 포함될 수 있습니다.'}
        }
      }
      const ticket=entry.automation,parts=command.ref!.split(':')
      if(!ticket||ticket.nonce!==parts[0]||ticket.epoch!==epoch||ticket.url!==url)throw new Error('이전 페이지의 참조예요. 새 snapshot을 받아 주세요')
      check()
      try {
        const result=await evaluate(interactionScript(ticket.nonce,Number(parts[1]),command.action,command.value))
        return {result,url:redact(wc.isDestroyed()?url:wc.getURL(),this.secretOptions()),navigated:entry.navigationEpoch!==epoch}
      }catch{throw new Error('동작 결과 확인 필요: 새 snapshot으로 결과를 확인한 뒤 다시 시도해 주세요')}
    }finally{entry.capturePending=false}
  }
  private close(key: string) {
    this.errors.delete(key)
    const e = this.entries.get(key)
    if (!e) return
    this.cancelPick(e)
    this.entries.delete(key)
    e.cleanup()
    if (!e.win.isDestroyed()) e.win.contentView.removeChildView(e.view)
    if (!e.view.webContents.isDestroyed()) e.view.webContents.close()
  }
  dispose() {
    try { this.flush() } catch (reason) { this.freeze(reason) }
    this.disposed = true
    clearTimeout(this.flushTimer); this.flushTimer = undefined
    for (const key of this.entries.keys()) this.close(key)
  }
}
