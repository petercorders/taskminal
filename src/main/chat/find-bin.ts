import { execFile } from 'node:child_process'

export interface AgentBin {
  bin: string
  /** 로그인 셸의 PATH — Finder 로 띄운 앱은 PATH 가 비어 claude 가 쓰는 node · git 을 못 찾는다 */
  path: string
}

type Exec = (file: string, args: string[], opts: { timeout: number; env: NodeJS.ProcessEnv }) => Promise<string>
const realExec: Exec = (file, args, opts) =>
  new Promise((resolve, reject) => execFile(file, args, { ...opts, encoding: 'utf8' }, (err, out) => (err ? reject(err) : resolve(out))))

const MARK = '__TASKMINAL_PATH__'

/**
 * claude 실행 파일 찾기. `TASKMINAL_CLAUDE_BIN`(e2e 가짜)이 먼저, 아니면 로그인 셸(`$SHELL -lc`, 5초)로 `command -v claude`.
 * 찾으면 기억하고, 못 찾으면 기억하지 않는다 — 'CLI 없음' 띠의 [다시 찾기] · 다음 보내기가 다시 찾는다(설치한 뒤 저절로).
 */
export class AgentBinFinder {
  private found: AgentBin | null = null
  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly exec: Exec = realExec,
  ) {}

  async claude(): Promise<AgentBin | null> {
    const fake = this.env['TASKMINAL_CLAUDE_BIN']
    if (fake) return { bin: fake, path: this.env['PATH'] ?? '' }
    if (this.found) return this.found
    const shell = this.env['SHELL'] || '/bin/zsh'
    try {
      const out = await this.exec(shell, ['-lc', `command -v claude; printf '\\n${MARK}%s' "$PATH"`], { timeout: 5000, env: this.env })
      const [head, path = ''] = out.split(MARK)
      const bin = (head ?? '').split('\n').map((l) => l.trim()).find((l) => l.startsWith('/'))
      if (!bin) return null
      this.found = { bin, path: path.trim() || (this.env['PATH'] ?? '') }
      return this.found
    } catch {
      return null
    }
  }
}
