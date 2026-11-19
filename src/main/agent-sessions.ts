// 53단계: 밖에서(터미널 · 다른 앱) 시작한 Claude · Codex 세션 기록을 읽기 전용으로 모은다.
// 쓰지 않는다 · 경로는 renderer 에서 받지 않는다(이어 하기는 id 로 다시 찾는다) · 파일마다 앞 256KB 만.
import { open, readdir, stat, lstat } from 'node:fs/promises'
import { constants, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { ChatAgent } from '../shared/chat'
import { redact, type SecretOptions } from '../shared/redact'
import { isPaneId } from '../shared/pty'
import {
  HEAD_BYTES,
  PER_AGENT,
  isResumeHow,
  isSessionId,
  parseClaudeHead,
  parseCodexHead,
  summarize,
  type AgentSession,
  type AgentSessionList,
  type AgentSessionRequest,
  type AgentSessionTarget,
  type HeadResult,
} from '../shared/agent-sessions'

export interface SessionRoot {
  agent: ChatAgent
  /** Claude: <설정 폴더>/projects · Codex: <CODEX_HOME>/sessions */
  dir: string
  account: string
  accountName?: string
}

/**
 * 읽을 폴더 — 기본 계정 ~/.claude · ~/.codex 와 추가 계정(<userData>/accounts/<agent>/<id>, accounts.ts 의 CLAUDE_CONFIG_DIR · CODEX_HOME).
 * 시험용 루트(TASKMINAL_AGENT_SESSIONS_HOME)는 TASKMINAL_USER_DATA 가 있을 때만 — e2e 가 실제 기록을 읽지 않게.
 * 부를 때마다 계정 목록을 다시 본다(처음 한 번만 읽지 않는다).
 */
export function sessionRoots(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
  accounts: ReadonlyArray<{ id: string; agent: ChatAgent; name: string }>,
  accountsDir: string,
): SessionRoot[] {
  const override = env['TASKMINAL_USER_DATA'] ? env['TASKMINAL_AGENT_SESSIONS_HOME'] : undefined
  // 기본 계정 폴더는 앱 셸 · 대화와 같게 CLAUDE_CONFIG_DIR · CODEX_HOME 을 따른다
  const claudeDir = override ? join(override, '.claude') : env['CLAUDE_CONFIG_DIR'] || join(home, '.claude')
  const codexDir = override ? join(override, '.codex') : env['CODEX_HOME'] || join(home, '.codex')
  return [
    { agent: 'claude', dir: join(claudeDir, 'projects'), account: 'default-claude' },
    { agent: 'codex', dir: join(codexDir, 'sessions'), account: 'default-codex' },
    ...accounts
      .filter((a) => !a.id.startsWith('default-'))
      .map((a) => ({ agent: a.agent, dir: join(accountsDir, a.agent, a.id, a.agent === 'claude' ? 'projects' : 'sessions'), account: a.id, accountName: a.name })),
  ]
}

interface Candidate {
  path: string
  name: string
  root: SessionRoot
  mtimeMs: number
  size: number
}

/** 폴더 하나에서 볼 파일 수 상한 — 기록이 아주 많아도 stat 이 끝없이 늘지 않게 */
const MAX_FILES = 20_000
/** 공급자마다 앞부분을 읽어 볼 파일 수 — 하위 에이전트 · 손상 파일이 많아도 여기서 멈춘다 */
const MAX_PARSE = PER_AGENT * 3
/** 기록 파일 이름 끝의 세션 id */
const NAME_ID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

async function entries(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** O_NOFOLLOW 로 열어 일반 파일의 앞 HEAD_BYTES 만 */
async function readHead(path: string): Promise<{ text: string; truncated: boolean }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error('일반 파일이 아님')
    const buf = Buffer.alloc(Math.min(HEAD_BYTES, Math.max(0, info.size)))
    let size = 0
    while (size < buf.length) {
      const r = await handle.read(buf, size, buf.length - size, size)
      if (!r.bytesRead) break
      size += r.bytesRead
    }
    return { text: buf.subarray(0, size).toString('utf8'), truncated: info.size > size }
  } finally {
    await handle.close()
  }
}

export class AgentSessions {
  /** 앞부분을 실제로 읽은 횟수 (시험 · 캐시 확인) */
  reads = 0
  private cache = new Map<string, { mtimeMs: number; size: number; result: HeadResult }>()
  private index = new Map<string, Candidate>()
  /** 70단계: 목록(에이전트마다 최근 300개) 밖의 기록 — 파일 이름의 세션 id → 파일. 가져온 일감에 저장한 이어 하기 후보가 오래돼도 찾게 */
  private byName = new Map<string, Candidate>()
  private running: Promise<AgentSessionList> | null = null
  private pending = new Map<string, Promise<AgentSessionTarget>>()

  constructor(
    private readonly roots: () => SessionRoot[],
    private readonly secrets: () => SecretOptions = () => ({}),
  ) {}

  /** 읽기는 한 번에 하나 — 도는 중에 부르면 같은 결과를 기다린다 */
  list(): Promise<AgentSessionList> {
    if (this.running) return this.running
    const run = this.scan().finally(() => {
      if (this.running === run) this.running = null
    })
    this.running = run
    return run
  }

  private async candidates(root: SessionRoot): Promise<{ files: Candidate[]; links: number }> {
    const files: Array<{ path: string; name: string }> = []
    let links = 0
    const take = (dir: string, e: Dirent, ok: (name: string) => boolean) => {
      if (!ok(e.name) || files.length >= MAX_FILES) return
      if (e.isSymbolicLink()) links++
      else if (e.isFile()) files.push({ path: join(dir, e.name), name: e.name })
    }
    if (root.agent === 'claude') {
      for (const project of await entries(root.dir)) {
        if (!project.isDirectory() || files.length >= MAX_FILES) continue
        const dir = join(root.dir, project.name)
        for (const e of await entries(dir)) take(dir, e, (n) => n.endsWith('.jsonl'))
      }
    } else {
      // sessions/YYYY/MM/DD/rollout-*.jsonl — 링크 폴더는 따라가지 않는다
      const walk = async (dir: string, depth: number): Promise<void> => {
        for (const e of await entries(dir)) {
          if (files.length >= MAX_FILES) return
          if (e.isDirectory() && depth < 4) await walk(join(dir, e.name), depth + 1)
          else take(dir, e, (n) => /^rollout-.*\.jsonl$/.test(n))
        }
      }
      await walk(root.dir, 0)
    }
    const out: Candidate[] = []
    for (let i = 0; i < files.length; i += 64) {
      const infos = await Promise.all(files.slice(i, i + 64).map((f) => lstat(f.path).then((s) => (s.isFile() ? s : null), () => null)))
      infos.forEach((info, j) => {
        const f = files[i + j]!
        if (info) out.push({ ...f, root, mtimeMs: info.mtimeMs, size: info.size })
      })
    }
    return { files: out, links }
  }

  /** (경로 · mtime · 크기) 가 같으면 다시 읽지 않는다 */
  private async head(c: Candidate): Promise<HeadResult> {
    const hit = this.cache.get(c.path)
    if (hit && hit.mtimeMs === c.mtimeMs && hit.size === c.size) return hit.result
    this.reads++
    let result: HeadResult
    try {
      const { text, truncated } = await readHead(c.path)
      result = c.root.agent === 'claude' ? parseClaudeHead(text, c.name, truncated) : parseCodexHead(text, c.name, truncated)
    } catch {
      result = { kind: 'skip', badLines: 0 }
    }
    this.cache.set(c.path, { mtimeMs: c.mtimeMs, size: c.size, result })
    return result
  }

  private async scan(): Promise<AgentSessionList> {
    const roots = this.roots()
    const options = this.secrets()
    const seen = new Set<string>()
    const index = new Map<string, Candidate>()
    const byName = new Map<string, Candidate>()
    const sessions: AgentSession[] = []
    let skipped = 0
    let badLines = 0
    let subagents = 0
    for (const agent of ['claude', 'codex'] as const) {
      const all: Candidate[] = []
      for (const root of roots.filter((r) => r.agent === agent)) {
        const c = await this.candidates(root)
        all.push(...c.files)
        skipped += c.links
      }
      all.sort((a, b) => b.mtimeMs - a.mtimeMs)
      for (const c of all) {
        // Claude `<id>.jsonl` · Codex `rollout-…-<id>.jsonl` — 같은 id 면 더 최근 것. 앞부분을 다시 읽어 id 를 확인한 뒤에만 쓴다(resolve)
        const id = NAME_ID.exec(c.name)?.[1]?.toLowerCase()
        if (id && !byName.has(`${agent}:${id}`)) byName.set(`${agent}:${id}`, c)
      }
      let count = 0
      let parsed = 0
      for (const c of all) {
        if (count >= PER_AGENT || parsed >= MAX_PARSE) break
        parsed++
        seen.add(c.path)
        const head = await this.head(c)
        badLines += head.badLines
        if (head.kind === 'subagent') {
          subagents++
          continue
        }
        if (head.kind === 'skip') {
          skipped++
          continue
        }
        const key = `${agent}:${head.session.id.toLowerCase()}`
        if (index.has(key)) continue // 같은 세션이 두 곳에 — 더 최근 것만
        index.set(key, c)
        sessions.push({
          agent,
          id: head.session.id,
          cwd: head.session.cwd,
          // 가리기는 목록마다 지금 설정으로 — 캐시에는 원문 조각만 둔다
          summary: summarize(head.session.text, (t) => redact(t, options)),
          startedAt: head.session.startedAt,
          updatedAt: c.mtimeMs,
          account: c.root.account,
          ...(c.root.accountName ? { accountName: c.root.accountName } : {}),
        })
        count++
      }
    }
    for (const path of this.cache.keys()) if (!seen.has(path)) this.cache.delete(path)
    this.index = index
    this.byName = byName
    sessions.sort((a, b) => b.updatedAt - a.updatedAt)
    return { sessions, skipped, badLines, subagents, home: homedir(), at: Date.now() }
  }

  /**
   * 이어 하기 대상 — renderer 는 id 만 준다. main 이 목록 색인에서 파일을 찾아(없으면 한 번 다시 읽어) 앞부분을 다시 확인하고,
   * 세션 폴더가 있는지 본다. 같은 세션을 동시에 두 번 부르면 첫 요청의 결과(첫 pane id)를 함께 돌려준다.
   */
  target(req: AgentSessionRequest): Promise<AgentSessionTarget> {
    if (!req || typeof req !== 'object' || (req.agent !== 'claude' && req.agent !== 'codex') || !isSessionId(req.id) || !isPaneId(req.paneId) || !isResumeHow(req.how))
      return Promise.reject(new Error('잘못된 세션이에요'))
    const key = `${req.agent}:${req.id.toLowerCase()}`
    const running = this.pending.get(key)
    if (running) return running
    const run = this.resolve(key, req).finally(() => this.pending.delete(key))
    this.pending.set(key, run)
    return run
  }

  private async resolve(key: string, req: AgentSessionRequest): Promise<AgentSessionTarget> {
    const missing = () => new Error('세션 기록을 찾지 못했어요. 목록을 새로 고쳐 주세요.')
    let c = this.index.get(key) ?? this.byName.get(key)
    if (!c) {
      await this.list()
      c = this.index.get(key) ?? this.byName.get(key)
    }
    if (!c) throw missing()
    const info = await lstat(c.path).catch(() => null)
    if (!info?.isFile()) throw missing()
    const head = await this.head({ ...c, mtimeMs: info.mtimeMs, size: info.size })
    if (head.kind !== 'session' || head.session.id.toLowerCase() !== req.id.toLowerCase()) throw missing()
    const cwd = head.session.cwd
    const dir = await stat(cwd).catch(() => null)
    if (!dir?.isDirectory()) throw new Error(`세션 폴더가 없어요: ${cwd} — 폴더를 되살리거나 다른 세션을 골라 주세요.`)
    return { agent: req.agent, sessionId: head.session.id, cwd, account: c.root.account, paneId: req.paneId, how: req.how }
  }
}
