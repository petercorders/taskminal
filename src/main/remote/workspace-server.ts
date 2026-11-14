import { execFile, spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import * as pty from 'node-pty'
import { AtomicJournal } from '../atomic-journal'
import { WorkspaceFiles } from '../workspace-files'
import { WorkspaceEditor } from '../workspace-editor'
import { ChatManager, type ChatRef, type Sink } from '../chat/chat-manager'
import { ChatStore } from '../chat/chat-store'
import { AgentBinFinder } from '../chat/find-bin'
import { defaultShell, shellArgs } from '../../shared/platform'
import { shellEnv } from '../../shared/pty'
import { isChatDecision } from '../../shared/chat'
import { redact } from '../../shared/redact'
import type { RemoteWorkspace, RemoteTerminal, RemoteChat } from '../../shared/remote-workspace'

interface Workspace extends RemoteWorkspace { chats: Array<RemoteChat & ChatRef> }
interface Receipt { id: string; hash: string; done: boolean; result?: unknown }
interface Journal { root: string; workspaces: Workspace[]; receipts: Receipt[] }
const id = (v: unknown): v is string => typeof v === 'string' && /^[\w-]{1,100}$/.test(v)
const text = (v: unknown, max = 4096): string => { if (typeof v !== 'string' || v.length > max || v.includes('\0')) throw Error('요청 내용을 확인해 주세요'); return v }
const key = (v: unknown): string => { if (!id(v)) throw Error('대상 번호를 확인해 주세요'); return v }
const valid = (v: unknown): v is Journal => {
  if (!v || typeof v !== 'object') return false
  const j = v as Journal
  return typeof j.root === 'string' && Array.isArray(j.workspaces) && j.workspaces.length <= 50 && j.workspaces.every(w => id(w.id) && typeof w.path === 'string' && typeof w.name === 'string' && Array.isArray(w.sessions) && w.sessions.length <= 200 && w.sessions.every(s => id(s.id) && typeof s.title === 'string') && Array.isArray(w.chats) && w.chats.length <= 200 && w.chats.every(c => id(c.id) && ['claude','codex'].includes(c.agent))) && Array.isArray(j.receipts) && j.receipts.length <= 10000 && j.receipts.every(r => id(r.id) && /^[a-f0-9]{64}$/.test(r.hash) && typeof r.done === 'boolean')
}
const inside = (root: string, target: string) => { const r = relative(root, target); return r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r) }
/** Owns processes independently of HTTP clients. A client disconnect never kills them. */
export class RemoteWorkspaceServer {
  private readonly journal: AtomicJournal<Journal>
  private readonly data: Journal
  private readonly files = new WorkspaceFiles()
  private readonly editor = new WorkspaceEditor()
  private readonly terminals = new Map<string, { process?: pty.IPty; data: string }>()
  private readonly manager: ChatManager
  private readonly sink: Sink = { send() {}, isDestroyed: () => false }
  private queue: Promise<unknown> = Promise.resolve()
  private closed = false
  constructor(private readonly root: string, dir: string) {
    this.journal = new AtomicJournal(join(dir, 'workspaces.json'), valid)
    this.data = this.journal.load({ root, workspaces: [], receipts: [] })
    if (this.data.root !== root) throw Error('서버 허용 폴더가 이전 기록과 다릅니다')
    for (const w of this.data.workspaces) for (const s of w.sessions) if (s.exited === undefined) s.exited = -1
    this.persist()
    const finder = new AgentBinFinder()
    this.manager = new ChatManager({ store: new ChatStore(join(dir, 'chat')), redactOptions: () => ({}), spawn: (bin,args,options) => {
      // Agent discovery awaits a login shell. Recheck after that wait, immediately before spawn.
      const current = realpathSync(options.cwd)
      if (this.closed || current !== options.cwd || !inside(this.root,current)) throw Error('서버가 종료됐거나 대화 작업 폴더 경계가 바뀌었어요')
      return spawn(bin,args,options)
    }, findBin: agent => finder.find(agent), permission: () => 'ask', channel: 'remote:chat' })
    this.manager.onEvent((pane, event) => {
      if (event.t !== 'session') return
      for (const w of this.data.workspaces) { const c = w.chats.find(c => c.id === pane); if (c) { c.sessionId = event.id; this.persist(); break } }
    })
  }
  private persist() { this.journal.save(this.data) }
  private workspace(value: unknown) {
    const w = this.data.workspaces.find(w => w.id === key(value)); if (!w || !inside(this.root, w.path)) throw Error('원격 작업 공간을 찾지 못했어요'); return w
  }
  private async cwd(w: Workspace) { const path = await realpath(w.path); if (this.closed || path !== w.path || !inside(this.root, path)) throw Error('서버가 종료됐거나 작업 폴더 경계가 바뀌었어요'); return path }
  private session(w: Workspace, value: unknown) { const s = w.sessions.find(s => s.id === key(value)); if (!s) throw Error('터미널을 찾지 못했어요'); return s }
  private chatRef(w: Workspace, value: unknown) { const c = w.chats.find(c => c.id === key(value)); if (!c) throw Error('대화를 찾지 못했어요'); return c }
  private once(request: unknown, method: string, args: unknown[], job: () => Promise<unknown>) {
    const requestId = key(request), hash = createHash('sha256').update(JSON.stringify([method, args])).digest('hex')
    const operation = this.queue.catch(() => {}).then(async () => {
      if (this.closed) throw Error('서버가 종료됐어요')
      const existing = this.data.receipts.find(r => r.id === requestId)
      if (existing) {
        if (existing.hash !== hash) throw Error('다른 요청에 사용한 번호입니다')
        if (!existing.done) throw Error('이전 요청 결과 확인 필요. 파일·출력·기록을 확인한 뒤 새 요청으로 진행해 주세요')
        return structuredClone(existing.result)
      }
      if (this.data.receipts.length >= 10000) throw Error('요청 기록 한도에 도달했어요. 새 서버 데이터 폴더가 필요합니다')
      const r: Receipt = { id: requestId, hash, done: false }; this.data.receipts.push(r); this.persist()
      // Persist a fence before side effects. Interrupted requests are never blindly replayed.
      const result = await job(); r.done = true; r.result = result; this.persist(); return result
    }); this.queue = operation; return operation
  }
  private async git(cwd: string, args: string[]) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith('GIT_')))
    return new Promise<string>((resolve, reject) => execFile('git', args, { cwd, env, encoding: 'utf8', timeout: 15000, maxBuffer: 2_000_000 }, (e, out) => e ? reject(Error('Git 상태를 읽지 못했어요')) : resolve(redact(out))))
  }
  async call(method: unknown, input: unknown): Promise<unknown> {
    if (this.closed) throw Error('서버가 종료됐어요')
    if (typeof method !== 'string' || !Array.isArray(input) || input.length > 5) throw Error('요청 형식')
    const a = input
    if (method === 'workspaces' && a.length === 0) return structuredClone(this.data.workspaces)
    if (method === 'open' && a.length === 2) {
      const path = text(a[0])
      return this.once(a[1], method, [path], async () => {
        const target = await this.files.path(this.root, path)
        if (!(await stat(target)).isDirectory()) throw Error('작업 폴더를 골라 주세요')
        const found = this.data.workspaces.find(w => w.path === target); if (found) return structuredClone(found)
        if (this.data.workspaces.length >= 50) throw Error('작업 공간 한도')
        const w: Workspace = { id: randomUUID(), name: target.split(/[\\/]/).pop() || target, path: target, sessions: [], chats: [] }
        this.data.workspaces.push(w); return structuredClone(w)
      })
    }
    const w = this.workspace(a[0]), cwd = await this.cwd(w)
    if (method === 'files' && a.length === 2) return this.files.list(cwd, text(a[1]))
    if (method === 'read' && a.length === 2) return this.editor.read(cwd, text(a[1]))
    if (method === 'save' && a.length === 4) {
      const path = text(a[1]), v = a[2] as {signature: string; text: string}
      if (!v || typeof v.signature !== 'string' || !/^[a-f0-9]{64}$/.test(v.signature) || typeof v.text !== 'string' || Buffer.byteLength(v.text) > 2_000_000 || v.text.includes('\0')) throw Error('저장할 내용을 확인해 주세요')
      // Receipt stores only signatures, never raw file drafts.
      const r = await this.once(a[3], method, [w.id, path, v], async () => {
        const result = await this.editor.save(await this.cwd(w), path, v)
        return { ok: result.ok, signature: result.ok ? result.file.signature : result.current.signature }
      }) as {ok: boolean; signature: string}
      const file = await this.editor.read(cwd, path)
      if (file.signature !== r.signature) throw Error('저장 응답 이후 파일이 바뀌었어요. 다시 읽어 주세요')
      return r.ok ? {ok: true, file} : {ok: false, reason: 'conflict', current: file}
    }
    if (method === 'git' && a.length === 1) {
      // Separate diffs also support unborn HEAD and files changed again after staging.
      const staged = await this.git(cwd, ['diff','--cached','--no-ext-diff','--no-textconv'])
      const working = await this.git(cwd, ['diff','--no-ext-diff','--no-textconv'])
      const diff = [staged && '스테이징한 변경\n' + staged, working && '작업 폴더 변경\n' + working].filter(Boolean).join('\n')
      return {status: await this.git(cwd, ['status','--porcelain=v1']), diff, branch: (await this.git(cwd, ['branch','--show-current'])).trim()}
    }
    if (method === 'terminal' && a.length === 2) return this.once(a[1], method, [w.id], async () => {
      const current = await this.cwd(w)
      if (w.sessions.length >= 200) throw Error('터미널 한도')
      const s: RemoteTerminal = {id: randomUUID(), title: 'Shell ' + (w.sessions.length + 1)}
      // Register metadata before spawning; restart marks an unfinished session as exited.
      w.sessions.push(s); this.persist()
      const proc = pty.spawn(defaultShell(process.platform, process.env), shellArgs(process.platform), {cwd: current, env: shellEnv(process.env), cols: 100, rows: 30, name: 'xterm-256color'})
      const entry: {process?: pty.IPty; data: string} = {process: proc, data: ''}; this.terminals.set(s.id, entry)
      proc.onData(data => { entry.data = (entry.data + data).slice(-1_000_000) })
      proc.onExit(({exitCode}) => { s.exited = exitCode; entry.process = undefined; this.persist() })
      return structuredClone(s)
    })
    if (method === 'tail' && a.length === 2) { const s = this.session(w, a[1]); return {data: redact(this.terminals.get(s.id)?.data || ''), ...(s.exited === undefined ? {} : {exited: s.exited})} }
    if (method === 'write' && a.length === 3) {
      const s = this.session(w, a[1]), v = a[2] as {requestId: string; data: string}; if (!v) throw Error('입력 형식')
      const data = text(v.data, 100000)
      return this.once(v.requestId, method, [w.id, s.id, data], async () => { const e = this.terminals.get(s.id); if (!e?.process || s.exited !== undefined) throw Error('터미널이 종료됐어요'); e.process.write(data); return null })
    }
    if (method === 'stop' && a.length === 2) { const s = this.session(w, a[1]); if(s.exited === undefined) this.terminals.get(s.id)?.process?.kill(); return null }
    if (method === 'chat' && a.length === 3) {
      const agent = a[1]; if (agent !== 'claude' && agent !== 'codex') throw Error('에이전트 형식')
      return this.once(a[2], method, [w.id, agent], async () => { if(w.chats.length >= 200) throw Error('대화 한도'); const c = {id: randomUUID(), agent}; w.chats.push(c); return c })
    }
    if (method === 'history' && a.length === 2) return this.manager.history(this.chatRef(w, a[1]).id)
    if (method === 'send' && a.length === 4) {
      const c = this.chatRef(w, a[1]), message = text(a[2], 100000)
      if (!message.trim()) throw Error('메시지를 입력해 주세요')
      return this.once(a[3], method, [w.id, c.id, message], async () => { const result = await this.manager.send(this.sink, c.id, message, await this.cwd(w), c); if (result !== 'ok') throw Error(result === 'busy' ? '앞선 대화가 진행 중이에요' : '서버에서 에이전트 CLI를 찾지 못했어요'); return null })
    }
    if (method === 'answer' && a.length === 4) { const c = this.chatRef(w, a[1]); if (!isChatDecision(a[3])) throw Error('허락 응답 형식'); return this.manager.answer(c.id, key(a[2]), a[3]) }
    if (method === 'interrupt' && a.length === 2) { this.manager.interrupt(this.chatRef(w, a[1]).id); return null }
    throw Error('지원하지 않는 원격 요청입니다')
  }
  dispose() { if(this.closed) return; this.closed=true; for (const t of this.terminals.values()) { try { t.process?.kill() } catch {} } for (const w of this.data.workspaces) for (const c of w.chats) this.manager.close(c.id) }
}
