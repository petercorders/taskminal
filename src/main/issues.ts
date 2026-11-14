import { execFile } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import type { IssueRecord, IssueProvider, IssuePage, IssueLink, IssuePrepare } from '../shared/issues'
import { redact } from '../shared/redact'
import { AtomicJournal } from './atomic-journal'
import { WorktreeManagement } from './worktree-management'
import { validWorktreeJournal, type WorktreeJournalState } from '../shared/worktree-management'

interface Receipt { input: IssuePrepare; taskId: string; root: string; issue: IssueRecord; done: boolean }
interface Journal { links: IssueLink[]; receipts: Receipt[] }
interface Deps {
  prepare(taskId: string, root: string, issue: IssueRecord): Promise<void>
  exists(taskId: string): boolean
  gh?(args: string[]): Promise<unknown>
  linear?(query: string, variables: Record<string, unknown>): Promise<any>
}
const key = (v: unknown): v is string => typeof v === 'string' && /^[\w-]{1,100}$/.test(v)
const validInput = (v: unknown): v is IssuePrepare => {
  if (!v || typeof v !== 'object') return false
  const i = v as IssuePrepare
  return key(i.requestId) && ['github', 'linear'].includes(i.provider) && typeof i.id === 'string' && i.id.length <= 100 && typeof i.source === 'string' && i.source.length <= 256 && typeof i.root === 'string' && i.root.length > 0 && i.root.length <= 4096 && !i.root.includes('\0') && typeof i.worktree === 'boolean' && typeof i.base === 'string' && i.base.length <= 256 && !i.base.includes('\0')
}
const record = (v: unknown): v is IssueRecord => !!v && typeof v === 'object' && ['github', 'linear'].includes((v as IssueRecord).provider) && ['id', 'key', 'title', 'body', 'url', 'state'].every(k => typeof (v as unknown as Record<string, unknown>)[k] === 'string')
const valid = (v: unknown): v is Journal => !!v && typeof v === 'object' && Array.isArray((v as Journal).links) && Array.isArray((v as Journal).receipts) && (v as Journal).links.length <= 1000 && (v as Journal).receipts.length <= 1000 && (v as Journal).links.every(l => l && key(l.taskId) && typeof l.root === 'string' && record(l.issue) && (l.prUrl === undefined || typeof l.prUrl === 'string')) && (v as Journal).receipts.every(r => r && key(r.taskId) && validInput(r.input) && record(r.issue) && typeof r.root === 'string' && typeof r.done === 'boolean')
const source = (v: string) => {
  if (typeof v !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(v) || v.split('/').some(p => p === '.' || p === '..')) throw new Error('GitHub 저장소를 owner/repo 형식으로 적어 주세요')
  return v.toLowerCase()
}
// Explicit fields make retry identity independent of JSON property order or extra IPC keys.
const identity = (i: IssuePrepare) => JSON.stringify([i.requestId, i.provider, i.id, i.source, i.root, i.worktree, i.base])
const closed = (issue: IssueRecord) => /^(closed|done|completed|canceled|cancelled)(?:$|\s|\()/i.test(issue.state)

export class Issues {
  private token = process.env['LINEAR_API_KEY'] ?? ''
  private readonly journal: AtomicJournal<Journal>
  private data: Journal
  private queue: Promise<unknown> = Promise.resolve()
  private readonly worktrees: WorktreeManagement
  constructor(private readonly dir: string, private readonly d: Deps) {
    this.journal = new AtomicJournal(join(dir, 'issues.json'), valid)
    this.data = this.journal.load({ links: [], receipts: [] })
    this.worktrees = new WorktreeManagement({ journal: new AtomicJournal<WorktreeJournalState>(join(dir, 'issue-worktrees.json'), validWorktreeJournal) })
  }
  configure(token: string) {
    if (typeof token !== 'string' || token.length > 4096 || /[\r\n]/.test(token)) throw new Error('Linear API 토큰을 확인해 주세요')
    this.token = token.trim() || process.env['LINEAR_API_KEY'] || ''
  }
  links() { return structuredClone(this.data.links) }
  private persist(next: Journal) { this.journal.save(next); this.data = next }
  private enqueue<T>(job: () => Promise<T> | T): Promise<T> {
    const operation = this.queue.catch(() => {}).then(job)
    this.queue = operation
    return operation
  }
  private async gh(args: string[]): Promise<any> {
    if (this.d.gh) return this.d.gh(args)
    const bin = process.env['TASKMINAL_ISSUES_GH_BIN'] || 'gh'
    const out = await new Promise<string>((done, reject) => execFile(bin, ['api', '--hostname', 'github.com', ...args], { encoding: 'utf8', timeout: 20000, maxBuffer: 4_000_000, env: { ...process.env, GH_PROMPT_DISABLED: '1' } }, (error, stdout) => error ? reject(new Error('GitHub 인증·권한과 연결을 확인해 주세요')) : done(stdout)))
    return JSON.parse(out)
  }
  private async linear(query: string, variables: Record<string, unknown>): Promise<any> {
    if (this.d.linear) return this.d.linear(query, variables)
    if (!this.token) throw new Error('Linear API 토큰을 입력하거나 LINEAR_API_KEY를 설정해 주세요')
    const response = await fetch('https://api.linear.app/graphql', { method: 'POST', headers: { Authorization: this.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(15000) })
    if (!response.ok) throw new Error('Linear 인증·권한과 연결을 확인해 주세요')
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Linear 응답을 읽지 못했어요')
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 4_000_000) { await reader.cancel(); throw new Error('Linear 응답이 너무 커요') }
        chunks.push(value)
      }
    } finally { reader.releaseLock() }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (result.errors?.length) throw new Error('Linear 요청이 거절됐어요. 권한과 팀을 확인해 주세요')
    return result.data
  }
  private githubIssue(repo: string, row: any): IssueRecord {
    if (!row || !Number.isSafeInteger(row.number) || row.number < 1 || typeof row.title !== 'string' || typeof row.html_url !== 'string' || !['open', 'closed'].includes(row.state) || row.pull_request) throw new Error('GitHub 이슈 응답을 확인하지 못했어요')
    const url = new URL(row.html_url)
    if (url.origin !== 'https://github.com' || url.username || url.password || url.search || url.hash || url.pathname.toLowerCase() !== `/${repo}/issues/${row.number}`.toLowerCase()) throw new Error('이슈 주소가 저장소와 다릅니다')
    return { provider: 'github', id: String(row.number), key: '#' + row.number, title: redact(row.title).slice(0, 256), body: redact(typeof row.body === 'string' ? row.body : '').slice(0, 60000), url: url.href, state: row.state }
  }
  private linearIssue(row: any): IssueRecord {
    if (!row || typeof row.id !== 'string' || typeof row.identifier !== 'string' || typeof row.title !== 'string' || typeof row.url !== 'string' || typeof row.state?.name !== 'string') throw new Error('Linear 이슈 응답을 확인하지 못했어요')
    const url = new URL(row.url)
    if (url.origin !== 'https://linear.app' || url.username || url.password || url.search || url.hash) throw new Error('Linear 이슈 주소를 확인해 주세요')
    const state = ['completed', 'canceled'].includes(row.state.type) ? `closed (${row.state.name})` : row.state.name
    return { provider: 'linear', id: row.id, key: row.identifier, title: redact(row.title).slice(0, 256), body: redact(typeof row.description === 'string' ? row.description : '').slice(0, 60000), url: url.href, state }
  }
  async list(provider: IssueProvider, from: string, cursor?: string): Promise<IssuePage> {
    if (provider === 'github') {
      const repo = source(from), page = cursor ?? '1'
      if (typeof page !== 'string' || !/^[1-9]\d{0,4}$/.test(page)) throw new Error('페이지 번호를 확인해 주세요')
      const rows = await this.gh([`repos/${repo}/issues?state=open&per_page=50&page=${page}`])
      if (!Array.isArray(rows) || rows.length > 100) throw new Error('이슈 목록 형식')
      return { items: rows.filter(r => !r.pull_request).map(r => this.githubIssue(repo, r)), ...(rows.length === 50 ? { cursor: String(Number(page) + 1) } : {}) }
    }
    if (provider !== 'linear' || typeof from !== 'string' || !/^[-\w]{0,50}$/.test(from) || cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 512)) throw new Error('제공자와 팀을 확인해 주세요')
    const data = await this.linear('query Issues($after:String,$filter:IssueFilter){issues(first:50,after:$after,filter:$filter){nodes{id identifier title description url state{name type}}pageInfo{hasNextPage endCursor}}}', { after: cursor ?? null, filter: from ? { team: { key: { eq: from } } } : {} })
    if (!Array.isArray(data?.issues?.nodes) || data.issues.nodes.length > 100 || typeof data.issues.pageInfo?.hasNextPage !== 'boolean') throw new Error('Linear 목록 형식')
    return { items: data.issues.nodes.map((r: any) => this.linearIssue(r)), ...(data.issues.pageInfo.hasNextPage ? { cursor: data.issues.pageInfo.endCursor } : {}) }
  }
  private async get(provider: IssueProvider, from: string, id: string): Promise<IssueRecord> {
    if (provider === 'github') {
      if (!/^[1-9]\d{0,9}$/.test(id)) throw new Error('이슈 번호를 확인해 주세요')
      const result = this.githubIssue(source(from), await this.gh([`repos/${source(from)}/issues/${id}`]))
      if (result.id !== id) throw new Error('요청한 이슈와 응답 번호가 다릅니다')
      return result
    }
    if (provider !== 'linear' || !key(id) || !/^[-\w]{0,50}$/.test(from)) throw new Error('Linear 이슈 ID와 팀을 확인해 주세요')
    const data = await this.linear('query Issue($id:String!){issue(id:$id){id identifier title description url state{name type} team{key}}}', { id })
    if (from && data.issue?.team?.key?.toLowerCase() !== from.toLowerCase()) throw new Error('이슈와 선택한 팀이 다릅니다')
    const result = this.linearIssue(data.issue)
    if (result.id !== id) throw new Error('요청한 이슈와 응답 ID가 다릅니다')
    return result
  }
  async prepare(input: IssuePrepare): Promise<IssueLink> {
    // Capture before enqueueing: a caller cannot mutate the pending target.
    if (!validInput(input)) return Promise.reject(new Error('이슈와 작업 폴더를 확인해 주세요'))
    const snapshot: IssuePrepare = { requestId: input.requestId, provider: input.provider, id: input.id, source: input.provider === 'github' ? source(input.source) : input.source, root: input.root, worktree: input.worktree, base: input.base.trim() || 'HEAD' }
    return this.enqueue(() => this.doPrepare(snapshot))
  }
  private async doPrepare(input: IssuePrepare): Promise<IssueLink> {
    const prior = this.data.receipts.find(r => r.input.requestId === input.requestId)
    if (prior && identity(prior.input) !== identity(input)) throw new Error('다른 요청에 사용한 번호입니다')
    if (prior?.done) {
      const link = this.data.links.find(l => l.taskId === prior.taskId)
      if (!link || !this.d.exists(link.taskId)) throw new Error('연결된 일감이 삭제됐어요. 새 요청으로 준비해 주세요')
      return structuredClone(link)
    }
    let receipt = prior
    if (!receipt) {
      if (this.data.receipts.length >= 1000) throw new Error('연결 기록 한도에 도달했어요')
      const root = await realpath(input.root === '~' ? homedir() : input.root.startsWith('~/') ? resolve(homedir(), input.root.slice(2)) : resolve(input.root))
      const issue = await this.get(input.provider, input.source, input.id)
      if (closed(issue)) throw new Error('이미 닫힌 이슈예요. 현재 상태를 다시 확인해 주세요')
      receipt = { input, taskId: randomUUID(), root, issue, done: false }
      this.persist({ ...this.data, receipts: [...this.data.receipts, receipt] })
    } else if (!this.d.exists(receipt.taskId)) {
      const issue = await this.get(input.provider, input.source, input.id)
      if (closed(issue)) throw new Error('이미 닫힌 이슈예요. 기존 checkout은 보존했어요')
      receipt = { ...receipt, issue }
      this.persist({ ...this.data, receipts: this.data.receipts.map(r => r.input.requestId === input.requestId ? receipt! : r) })
    }
    let root = receipt.root
    if (input.worktree) {
      const suffix = createHash('sha256').update(input.requestId).digest('hex').slice(0, 40)
      const result = await this.worktrees.create(root, { requestId: 'issue-' + suffix, branch: 'taskminal/issue-' + suffix, base: input.base, path: join(this.dir, 'issue-checkouts', receipt.taskId) })
      if (result.state !== 'created') throw new Error('worktree 결과 확인 필요: ' + result.message)
      root = result.path
    }
    if (!this.d.exists(receipt.taskId)) await this.d.prepare(receipt.taskId, root, structuredClone(receipt.issue))
    if (!this.d.exists(receipt.taskId)) throw new Error('일감 저장 결과 확인 필요. 같은 요청으로 다시 확인해 주세요')
    const link: IssueLink = { taskId: receipt.taskId, root, issue: receipt.issue }
    this.persist({ links: this.data.links.filter(l => l.taskId !== receipt!.taskId).concat(link), receipts: this.data.receipts.map(r => r.input.requestId === input.requestId ? { ...r, done: true } : r) })
    return structuredClone(link)
  }
  linkPr(taskId: string, url: string): Promise<void> {
    return this.enqueue(() => {
      const link = this.data.links.find(l => l.taskId === taskId)
      if (!link || !this.d.exists(taskId)) throw new Error('연결 일감이 사라졌어요')
      const parsed = new URL(url)
      if (parsed.origin !== 'https://github.com' || parsed.username || parsed.password || parsed.search || parsed.hash || !/^\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/i.test(parsed.pathname)) throw new Error('GitHub PR 주소를 확인해 주세요')
      if (link.issue.provider === 'github' && !parsed.pathname.toLowerCase().startsWith(new URL(link.issue.url).pathname.toLowerCase().split('/issues/')[0] + '/pull/')) throw new Error('이슈와 같은 저장소의 PR을 연결해 주세요')
      this.persist({ ...this.data, links: this.data.links.map(l => l.taskId === taskId ? { ...l, prUrl: parsed.href } : l) })
    })
  }
  close(taskId: string): Promise<void> {
    return this.enqueue(async () => {
      const link = this.data.links.find(l => l.taskId === taskId)
      if (!link || !this.d.exists(taskId)) throw new Error('연결 일감이 사라졌어요')
      let issue: IssueRecord
      if (link.issue.provider === 'github') {
        const path = new URL(link.issue.url).pathname.slice(1), repo = path.toLowerCase().split('/issues/')[0]!
        issue = this.githubIssue(repo, await this.gh(['--method', 'PATCH', 'repos/' + path, '-f', 'state=closed']))
      } else {
        const data = await this.linear('query CloseTarget($id:String!){issue(id:$id){team{states{nodes{id type}}}}}', { id: link.issue.id })
        const state = data.issue?.team?.states?.nodes?.find((s: any) => s.type === 'completed')
        if (!state || !key(state.id)) throw new Error('완료 상태를 찾지 못했어요')
        const updated = await this.linear('mutation CloseIssue($id:String!,$state:String!){issueUpdate(id:$id,input:{stateId:$state}){success issue{id identifier title description url state{name type}}}}', { id: link.issue.id, state: state.id })
        if (!updated.issueUpdate?.success) throw new Error('이슈 상태 변경 결과를 확인해 주세요')
        issue = this.linearIssue(updated.issueUpdate.issue)
      }
      if (issue.id !== link.issue.id) throw new Error('상태 변경 응답의 이슈가 다릅니다. 외부 이슈를 직접 확인해 주세요')
      if (!this.d.exists(taskId)) throw new Error('상태 변경 후 연결 일감이 사라졌어요. 외부 이슈를 직접 확인해 주세요')
      this.persist({ ...this.data, links: this.data.links.map(l => l.taskId === taskId ? { ...l, issue } : l) })
    })
  }
}
