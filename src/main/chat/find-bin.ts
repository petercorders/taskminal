import { execFile } from 'node:child_process'
import type { ChatAgent } from '../../shared/chat'
import { existsSync } from 'node:fs'
import { win32 } from 'node:path'
import { defaultShell } from '../../shared/platform'

export interface AgentBin {
  bin: string
  /** 로그인 셸의 PATH — Finder 로 띄운 앱은 PATH 가 비어 claude 가 쓰는 node · git 을 못 찾는다 */
  path: string
  /** Windows npm shim은 cmd.exe 대신 명시적인 패키지 JS를 Node 모드로 실행한다. */
  args?: string[]
  runAsNode?: true
}

export function agentLaunch(found: AgentBin, args: string[], env: NodeJS.ProcessEnv) {
  return { bin: found.bin, args: [...(found.args ?? []), ...args], env: found.runAsNode ? { ...env, ELECTRON_RUN_AS_NODE: '1' } : env }
}

type Exec = (file: string, args: string[], opts: { timeout: number; env: NodeJS.ProcessEnv }) => Promise<string>
const realExec: Exec = (file, args, opts) =>
  new Promise((resolve, reject) => execFile(file, args, { ...opts, encoding: 'utf8' }, (err, out) => (err ? reject(err) : resolve(out))))

const MARK = '__TASKMINAL_PATH__'

/**
 * claude · codex 실행 파일 찾기. `TASKMINAL_CLAUDE_BIN`(e2e 가짜)이 먼저, 아니면 로그인 셸(`$SHELL -lc`, 5초)로 `command -v claude`.
 * 못 찾으면 대화형 로그인 셸(`-ilc`)로 한 번 더 — zsh 는 비대화형이면 ~/.zshrc 를 읽지 않아, 거기서 PATH 를 더한 claude(nvm · npm 전역)를 못 찾는다.
 * 대화형 셸의 시작 출력은 앞에 섞여도 '/' 로 시작하는 줄만 쓰고, alias 답은 버린다.
 * 찾으면 기억하고, 못 찾으면 기억하지 않는다 — 'CLI 없음' 띠의 [다시 찾기] · 다음 보내기가 다시 찾는다(설치한 뒤 저절로).
 */
export class AgentBinFinder {
  private found = new Map<ChatAgent, AgentBin>()
  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly exec: Exec = realExec,
    private readonly platform: string = process.platform,
    private readonly exists: (path: string) => boolean = existsSync,
  ) {}

  claude(): Promise<AgentBin | null> {
    return this.find('claude')
  }
  /** 22단계 — `TASKMINAL_CODEX_BIN`(e2e 가짜) · 로그인 셸 `command -v codex` */
  codex(): Promise<AgentBin | null> {
    return this.find('codex')
  }

  async find(agent: ChatAgent): Promise<AgentBin | null> {
    const fake = this.env[agent === 'claude' ? 'TASKMINAL_CLAUDE_BIN' : 'TASKMINAL_CODEX_BIN']
    if (fake) return { bin: fake, path: this.env['PATH'] ?? this.env['Path'] ?? '' }
    const have = this.found.get(agent)
    if (have) return have
    if (this.platform === 'win32') {
      const got = await this.windows(agent)
      if (got) this.found.set(agent, got)
      return got
    }
    const shell = defaultShell(this.platform, this.env)
    for (const flags of ['-lc', '-ilc']) {
      const got = await this.ask(shell, flags, agent)
      if (got) {
        this.found.set(agent, got)
        return got
      }
    }
    return null
  }

  private async windows(agent: ChatAgent): Promise<AgentBin | null> {
    try {
      const out = await this.exec(win32.join(this.env['SystemRoot'] || 'C:\\Windows', 'System32', 'where.exe'), [agent], { timeout: 5000, env: this.env })
      const paths = out.split(/\r?\n/).map((line) => line.trim()).filter((line) => win32.isAbsolute(line))
      const path = this.env['PATH'] ?? this.env['Path'] ?? ''
      const exe = paths.find((line) => /\.exe$/i.test(line))
      if (exe) return { bin: exe, path }
      for (const shim of paths.filter((line) => /\.cmd$/i.test(line))) {
        const entry = win32.join(win32.dirname(shim), 'node_modules', ...(agent === 'claude' ? ['@anthropic-ai', 'claude-code', 'cli.js'] : ['@openai', 'codex', 'bin', 'codex.js']))
        if (this.exists(entry)) return { bin: process.execPath, path, args: [entry], runAsNode: true }
      }
    } catch { /* CLI 미설치: 다음 조회에서 다시 찾는다 */ }
    return null
  }

  private async ask(shell: string, flags: string, name: ChatAgent): Promise<AgentBin | null> {
    try {
      const out = await this.exec(shell, [flags, `command -v ${name}; printf '\\n${MARK}%s' "$PATH"`], { timeout: 5000, env: this.env })
      const [head, path = ''] = out.split(MARK)
      const bin = (head ?? '').split('\n').map((l) => l.trim()).find((l) => l.startsWith('/'))
      return bin ? { bin, path: path.trim() || (this.env['PATH'] ?? '') } : null
    } catch {
      return null
    }
  }
}
