import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { githubRepo, validGitTarget, validRefPart, validWorkflowOptions, type CreatePullRequest, type GitTarget, type GitWorkflowResult, type GitWorkflowView, type MergePullRequest, type PrFeedbackRequest, type PullRequestView, type WorkflowOptions } from '../shared/git-workflow'
import { FAILED_CHECK_STATES, LOG_CHECKS, failedChecks, logTail, reviewNotes, type FailedCheck, type PrFeedbackResult } from '../shared/ci-feedback'

export interface WorkflowOutput { code: number; stdout: string; timedOut: boolean; missing: boolean }
export type WorkflowRunner = (tool: 'git' | 'gh', args: readonly string[], cwd: string, input?: string) => Promise<WorkflowOutput>
/** Neither renderer input nor subprocess stderr is ever interpreted as shell source. */
export function makeWorkflowRunner(bins: { git?: string; gh?: string } = {}): WorkflowRunner {
  return (tool, args, cwd, input) => new Promise((resolve) => {
    const child = execFile(bins[tool] ?? tool, [...args], {
      cwd, env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat' },
      timeout: args[0] === 'push' || args[1] === 'merge' || args[1] === 'create' ? 120_000 : 30_000,
      // 54단계: 실패 로그는 끝이 필요하다 — 버퍼를 넘으면 앞부분만 남으므로 run 은 넉넉히
      maxBuffer: (args[0] === 'run' ? 16 : 2) * 1024 * 1024, encoding: 'utf8',
    }, (err, stdout) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: string | number }) | null
      resolve({ code: e ? typeof e.code === 'number' ? e.code : -1 : 0, stdout: String(stdout), timedOut: !!e?.killed && e.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', missing: e?.code === 'ENOENT' })
    })
    child.stdin?.on('error', () => {})
    child.stdin?.end(input)
  })
}
const EMPTY: GitWorkflowView = { state: 'not-repo', root: null, branch: null, head: null, remotes: [], target: null, upstream: null, ahead: 0, behind: 0, gh: 'not-github', pr: null }
const fields = 'number,title,url,state,isDraft,headRefOid,headRefName,isCrossRepository,baseRefName,reviewDecision,mergeStateStatus,statusCheckRollup'
const result = (state: GitWorkflowResult['state'], message: string, url?: string): GitWorkflowResult => ({ state, message, ...(url ? { url } : {}) })
function safeUrl(url: string): string { return url.replace(/(https?:\/\/)[^/@\s]+@/g, '$1').replace(/[?#].*$/, '') }
/** 한도 안에 끝나지 않으면 fallback — 밑의 작업은 멈추지 않는다(gh 는 runner 의 30초 한도로 끝난다) */
function within<T, F>(work: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([work, new Promise<F>((resolve) => { timer = setTimeout(() => resolve(fallback), ms) })]).finally(() => clearTimeout(timer))
}
function json(raw: string): unknown { try { return JSON.parse(raw) } catch { return null } }
function obj(raw: unknown): Record<string, unknown> | null { return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null }
function parsePr(raw: unknown): PullRequestView | null {
  const p = obj(raw)
  if (!p || !Number.isSafeInteger(p.number) || (p.number as number) < 1 || typeof p.headRefOid !== 'string' || typeof p.headRefName !== 'string' || p.isCrossRepository === true || typeof p.baseRefName !== 'string' || typeof p.url !== 'string' || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(p.url)) return null
  const checks = Array.isArray(p.statusCheckRollup) ? p.statusCheckRollup.map(obj).filter((x): x is Record<string, unknown> => !!x) : []
  const failed = checks.some((c) => FAILED_CHECK_STATES.includes(String(c.conclusion ?? c.state)))
  const pending = checks.some((c) => !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(String(c.conclusion ?? c.state)))
  const checkState = failed ? 'failed' : pending ? 'pending' : checks.length ? 'passed' : 'none'
  return { number: p.number as number, title: typeof p.title === 'string' ? p.title : '', url: p.url, state: String(p.state), head: p.headRefOid, branch: p.headRefName, base: p.baseRefName, draft: p.isDraft === true, review: String(p.reviewDecision ?? ''), checks: checkState, mergeable: p.mergeStateStatus === 'CLEAN' && p.isDraft !== true && p.reviewDecision !== 'CHANGES_REQUESTED' && p.reviewDecision !== 'REVIEW_REQUIRED' && checkState !== 'failed' && checkState !== 'pending' }
}

export class GitWorkflowService {
  private readonly locks = new Set<string>()
  // PR 생성이 적용됐을 수 있으면 같은 작업을 다시 POST하지 않는다.
  private readonly uncertainCreates = new Set<string>()
  private storageError = false
  // 54단계: 같은 PR · 같은 머리의 피드백 읽기는 한 번에 하나 — 진행 중 다시 누르면 같은 읽기를 기다린다
  private readonly feedbackRuns = new Map<string, Promise<PrFeedbackResult>>()
  constructor(private readonly run: WorkflowRunner = makeWorkflowRunner(), private readonly pendingFile?: string, private readonly feedbackLimitMs = 15_000) {
    if (pendingFile) {
      try {
        if (statSync(pendingFile).size > 1024 * 1024) throw new Error('size')
        const ids: unknown = JSON.parse(readFileSync(pendingFile, 'utf8'))
        if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string' && id.length < 10_000)) throw new Error('format')
        ids.forEach((id: string) => this.uncertainCreates.add(id))
      } catch (e) { this.storageError = (e as NodeJS.ErrnoException).code !== 'ENOENT' }
    }
  }
  private pending(id: string, uncertain: boolean): boolean {
    if (uncertain) this.uncertainCreates.add(id)
    else this.uncertainCreates.delete(id)
    if (!this.pendingFile) return true
    try {
      const temp = `${this.pendingFile}.${process.pid}.tmp`
      writeFileSync(temp, JSON.stringify([...this.uncertainCreates]), { mode: 0o600 })
      renameSync(temp, this.pendingFile)
      return true
    } catch { return false }
  }
  async view(dir: string, options: WorkflowOptions = {}): Promise<GitWorkflowView> {
    if (typeof dir !== 'string' || !isAbsolute(dir) || dir.length > 4096 || dir.includes('\0') || !validWorkflowOptions(options)) return { ...EMPTY, state: 'error', message: '작업 폴더나 브랜치를 확인해 주세요.' }
    let cwd: string
    try { cwd = await realpath(dir) } catch { return { ...EMPTY, state: 'error', message: '작업 폴더를 읽지 못했어요.' } }
    const top = await this.run('git', ['rev-parse', '--show-toplevel'], cwd)
    if (top.code !== 0) return { ...EMPTY, state: top.missing ? 'no-git' : 'not-repo' }
    let root: string
    try { root = await realpath(top.stdout.trim()) } catch { return { ...EMPTY, state: 'error', message: '저장소 위치를 확인하지 못했어요.' } }
    const [br, sha, rem, up, counts] = await Promise.all([
      this.run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], root), this.run('git', ['rev-parse', '--verify', 'HEAD'], root),
      this.run('git', ['remote'], root), this.run('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], root),
      this.run('git', ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], root),
    ])
    const branch = br.code === 0 && validRefPart(br.stdout.trim()) ? br.stdout.trim() : null
    const head = sha.code === 0 && /^[a-f0-9]{40,64}$/.test(sha.stdout.trim()) ? sha.stdout.trim() : null
    const remotes = rem.code === 0 ? rem.stdout.trim().split('\n').filter(validRefPart) : []
    const remote = options.remote ? remotes.includes(options.remote) ? options.remote : null : remotes.length === 1 ? remotes[0] : null
    const [ahead, behind] = counts.code === 0 ? counts.stdout.trim().split(/\s+/).map(Number) : [0, 0]
    const view: GitWorkflowView = { ...EMPTY, state: 'ok', root, branch, head, remotes, upstream: up.code === 0 ? up.stdout.trim() : null, ahead, behind }
    if (!branch || !head || !remote) return view
    const remoteOut = await this.run('git', ['remote', 'get-url', '--push', remote], root)
    if (remoteOut.code !== 0) return view
    const remoteUrl = remoteOut.stdout.trim()
    const repo = githubRepo(remoteUrl)
    const baseRef = await this.run('git', ['symbolic-ref', '--quiet', `refs/remotes/${remote}/HEAD`], root)
    let base = options.base ?? (baseRef.code === 0 ? baseRef.stdout.trim().replace(`refs/remotes/${remote}/`, '') : null)
    if (repo) {
      const auth = await this.run('gh', ['auth', 'status', '--hostname', 'github.com'], root)
      view.gh = auth.missing ? 'missing' : auth.code !== 0 ? 'login' : 'ready'
      if (view.gh === 'ready') {
        if (!base) {
          const info = await this.run('gh', ['repo', 'view', repo, '--json', 'defaultBranchRef'], root)
          const defaultRef = obj(obj(json(info.stdout))?.defaultBranchRef)
          if (info.code === 0 && validRefPart(defaultRef?.name)) base = defaultRef.name
        }
        const found = await this.findPr(root, repo, branch, base)
        if (found.ok) view.pr = found.pr
        else view.gh = 'error'
      }
    }
    view.target = { root, branch, head, remote, base: base && validRefPart(base) ? base : null, repo, remoteUrl: safeUrl(remoteUrl) }
    return view
  }
  private async findPr(root: string, repo: string, branch: string, base: string | null): Promise<{ ok: boolean; pr: PullRequestView | null }> {
    const r = await this.run('gh', ['pr', 'list', '--repo', repo, '--head', branch, ...(base ? ['--base', base] : []), '--state', 'open', '--json', fields, '--limit', '2'], root)
    const rows = json(r.stdout)
    if (r.code !== 0 || !Array.isArray(rows) || rows.length > 1) return { ok: false, pr: null }
    const pr = rows.length ? parsePr(rows[0]) : null
    return { ok: rows.length === 0 || pr !== null && pr.branch === branch && (!base || pr.base === base), pr }
  }
  private async locked(dir: string, target: GitTarget, act: (view: GitWorkflowView) => Promise<GitWorkflowResult>): Promise<GitWorkflowResult> {
    if (!validGitTarget(target)) return result('error', '작업 대상을 확인해 주세요.')
    let root: string
    try { root = await realpath(target.root) } catch { return result('changed', '저장소가 사라졌어요. 다시 확인해 주세요.') }
    if (this.locks.has(root)) return result('busy', '이 저장소의 작업이 진행 중이에요.')
    this.locks.add(root)
    try {
      const view = await this.view(dir, { remote: target.remote, ...(target.base ? { base: target.base } : {}) })
      const now = view.target
      if (!now || now.root !== root || now.branch !== target.branch || now.head !== target.head || now.remoteUrl !== target.remoteUrl || now.repo !== target.repo) return result('changed', '저장소·브랜치·커밋이 바뀌었어요. 다시 확인해 주세요.')
      return await act(view)
    } catch { return result('unknown', '결과를 확인하지 못했어요. 상태를 새로 읽어 주세요.') }
    finally { this.locks.delete(root) }
  }
  push(dir: string, target: GitTarget): Promise<GitWorkflowResult> {
    return this.locked(dir, target, async () => {
      const check = await this.run('git', ['ls-remote', '--heads', target.remote, `refs/heads/${target.branch}`], target.root)
      if (check.code === 0 && check.stdout.split(/\s/)[0] === target.head) return result('ok', '이 커밋은 이미 remote 에 있어요.')
      const r = await this.run('git', ['push', '--set-upstream', target.remote, `${target.head}:refs/heads/${target.branch}`], target.root)
      const after = await this.run('git', ['ls-remote', '--heads', target.remote, `refs/heads/${target.branch}`], target.root)
      if (after.code === 0 && after.stdout.split(/\s/)[0] === target.head) return result('ok', 'remote 에 올렸어요.')
      return r.timedOut || r.code === 0 || after.code !== 0 ? result('unknown', 'push 반영 여부를 확인하지 못했어요. 다시 시도하면 remote 부터 확인해요.') : result('error', '올리지 못했어요. remote 권한이나 다른 커밋이 있는지 확인해 주세요.')
    })
  }
  create(dir: string, request: CreatePullRequest): Promise<GitWorkflowResult> {
    if (!request || !validGitTarget(request.target) || typeof request.title !== 'string' || request.title.trim().length === 0 || request.title.length > 256 || typeof request.body !== 'string' || request.body.length > 100_000 || /\0/.test(request.title + request.body)) return Promise.resolve(result('error', 'PR 제목과 본문을 확인해 주세요.'))
    const t = request.target
    return this.locked(dir, t, async (view) => {
      if (view.gh !== 'ready' || !t.repo || !t.base || t.base === t.branch) return result('blocked', 'GitHub 로그인과 base/head 브랜치를 확인해 주세요.')
      const operation = `${t.root}\0${t.repo}\0${t.base}\0${t.branch}`
      if (view.pr) { this.pending(operation, false); return result('ok', '이미 열린 PR이 있어요.', view.pr.url) }
      if (this.storageError) return result('blocked', '이전 GitHub 작업 기록을 읽지 못했어요. GitHub에서 PR을 먼저 확인해 주세요.')
      if (this.uncertainCreates.has(operation)) return result('unknown', '이전 PR 생성 결과를 아직 확인하지 못했어요. GitHub에서 생성 여부를 확인한 뒤 다시 읽어 주세요.')
      const pushed = await this.run('git', ['ls-remote', '--heads', t.remote, `refs/heads/${t.branch}`], t.root)
      if (pushed.code !== 0 || pushed.stdout.split(/\s/)[0] !== t.head) return result('blocked', '현재 커밋을 먼저 remote 에 올려 주세요.')
      if (!this.pending(operation, true)) return result('blocked', 'GitHub 작업 기록을 저장하지 못해 PR을 만들지 않았어요.')
      const r = await this.run('gh', ['pr', 'create', '--repo', t.repo, '--base', t.base, '--head', t.branch, '--title', request.title.trim(), '--body-file', '-'], t.root, request.body)
      const after = await this.findPr(t.root, t.repo, t.branch, t.base)
      if (after.ok && after.pr) { this.pending(operation, false); return result('ok', 'PR을 확인했어요.', after.pr.url) }
      if (r.timedOut || r.code === 0 || !after.ok) { return result('unknown', 'PR 생성 결과를 확인하지 못했어요. 다시 시도하면 기존 PR부터 확인해요.') }
      this.pending(operation, false)
      return result('error', 'PR을 만들지 못했어요. 입력은 그대로 남아 있어요.')
    })
  }
  merge(dir: string, request: MergePullRequest): Promise<GitWorkflowResult> {
    if (!request || !validGitTarget(request.target) || !Number.isSafeInteger(request.number) || request.number < 1 || typeof request.head !== 'string' || !/^[a-f0-9]{40,64}$/.test(request.head)) return Promise.resolve(result('error', '병합 대상을 확인해 주세요.'))
    const t = request.target
    return this.locked(dir, t, async (view) => {
      if (view.gh !== 'ready' || !t.repo || !t.base) return result('blocked', 'GitHub 연결을 확인해 주세요.')
      const read = await this.run('gh', ['pr', 'view', String(request.number), '--repo', t.repo, '--json', fields], t.root)
      const p = read.code === 0 ? parsePr(json(read.stdout)) : null
      if (!p) return result('unknown', 'PR 상태를 읽지 못했어요. 병합하지 않았어요.')
      if (p.head !== request.head || p.head !== t.head || p.branch !== t.branch || p.base !== t.base) return result('changed', 'PR 커밋이나 base가 바뀌었어요. 다시 확인해 주세요.')
      if (p.state === 'MERGED') return result('ok', '이미 병합된 PR이에요.', p.url)
      if (p.state !== 'OPEN' || !p.mergeable) return result('blocked', '초안·리뷰·체크·충돌 상태를 확인해 주세요. 병합할 수 없어요.')
      const r = await this.run('gh', ['pr', 'merge', String(p.number), '--repo', t.repo, '--squash', '--match-head-commit', request.head], t.root)
      const afterRead = await this.run('gh', ['pr', 'view', String(p.number), '--repo', t.repo, '--json', fields], t.root)
      const after = afterRead.code === 0 ? parsePr(json(afterRead.stdout)) : null
      return after?.state === 'MERGED' ? result('ok', 'PR을 병합했어요.', after.url) : r.timedOut || r.code === 0 || !after ? result('unknown', '병합 결과를 확인하지 못했어요. 다시 시도하면 PR부터 확인해요.') : result('error', '병합하지 못했어요. 최신 체크와 보호 규칙을 확인해 주세요.')
    })
  }
  /** 54단계: 실패 체크(로그 끝) · 리뷰 의견. 읽기만 하며 한도(15초) 안에 답이 없으면 timeout — 화면은 마지막 값을 남긴다 */
  feedback(dir: string, request: PrFeedbackRequest, redact: (text: string) => string = (text) => text): Promise<PrFeedbackResult> {
    if (typeof dir !== 'string' || !isAbsolute(dir) || dir.includes('\0') || !request || !validGitTarget(request.target) || !request.target.repo || !Number.isSafeInteger(request.number) || request.number < 1 || typeof request.head !== 'string' || !/^[a-f0-9]{40,64}$/.test(request.head))
      return Promise.resolve({ state: 'error', message: 'PR을 확인해 주세요.' })
    const repo = request.target.repo
    const key = `${repo}#${request.number}@${request.head}`
    let work = this.feedbackRuns.get(key)
    if (!work) {
      work = this.readFeedback(dir, repo, request.number, redact)
        .catch((): PrFeedbackResult => ({ state: 'error', message: 'PR 체크·리뷰를 읽지 못했어요. 다시 시도해 주세요.' }))
        .finally(() => this.feedbackRuns.delete(key))
      this.feedbackRuns.set(key, work)
    }
    return within(work, this.feedbackLimitMs, { state: 'timeout', message: '응답이 없어요. 다시 시도해 주세요.' } as const)
  }
  private async readFeedback(cwd: string, repo: string, n: number, redact: (text: string) => string): Promise<PrFeedbackResult> {
    const start = Date.now()
    const [view, lines] = await Promise.all([
      this.run('gh', ['pr', 'view', String(n), '--repo', repo, '--json', 'number,headRefOid,statusCheckRollup,reviews,comments'], cwd),
      this.run('gh', ['api', `repos/${repo}/pulls/${n}/comments?per_page=100&sort=created&direction=desc`], cwd),
    ])
    if (view.missing) return { state: 'error', message: 'GitHub CLI(gh)를 설치해 주세요.' }
    const pv = view.code === 0 ? obj(json(view.stdout)) : null
    if (!pv || pv.number !== n || typeof pv.headRefOid !== 'string' || !/^[a-f0-9]{40,64}$/.test(pv.headRefOid))
      return { state: 'error', message: view.timedOut ? '응답이 없어요. 다시 시도해 주세요.' : 'PR 체크·리뷰를 읽지 못했어요. 다시 시도해 주세요.' }
    const head = pv.headRefOid
    const lineRows = lines.code === 0 ? json(lines.stdout) : null
    const found = failedChecks(pv.statusCheckRollup, repo)
    const withLog = new Set(found.filter((c) => c.runId !== null && c.jobId !== null).slice(0, LOG_CHECKS))
    // 로그는 남은 한도 안에서만 기다린다 — 늦은 로그 때문에 체크 · 리뷰까지 timeout 이 되지 않게
    const budget = Math.max(0, this.feedbackLimitMs - (Date.now() - start) - Math.min(1000, this.feedbackLimitMs / 5))
    const checks = await Promise.all(found.map(async (c): Promise<FailedCheck> => {
      const base = { ...c, name: redact(c.name), workflow: redact(c.workflow) }
      if (c.runId === null || c.jobId === null) return { ...base, log: '', logState: 'not-actions' }
      if (!withLog.has(c)) return { ...base, log: '', logState: 'skipped' }
      const r = await within(this.run('gh', ['run', 'view', String(c.runId), '--repo', repo, '--job', String(c.jobId), '--log-failed'], cwd), budget, null)
      if (!r) return { ...base, log: '', logState: 'timeout' }
      if (r.code !== 0) return { ...base, log: '', logState: 'error' }
      const log = logTail(r.stdout, redact)
      return { ...base, log, logState: log ? 'ok' : 'empty' }
    }))
    const { notes, more } = reviewNotes(pv, lineRows, redact)
    return { state: 'ok', number: n, head, checks, notes, more, lineComments: Array.isArray(lineRows) ? 'ok' : 'error', at: Date.now() }
  }
}

/** 56단계: 폴더의 GitHub 저장소(owner/repo) — origin, 없으면 하나뿐인 remote. 로컬 git 만 읽는다(gh · 네트워크 없음) */
export async function localGithubRepo(run: WorkflowRunner, dir: string): Promise<string | null> {
  const listed = await run('git', ['remote'], dir)
  if (listed.code !== 0) return null
  const remotes = listed.stdout.trim().split('\n').filter(validRefPart)
  const name = remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0]! : null
  if (!name) return null
  const url = await run('git', ['remote', 'get-url', name], dir)
  return url.code === 0 ? githubRepo(url.stdout.trim()) : null
}
