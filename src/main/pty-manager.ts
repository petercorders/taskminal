import type { WebContents } from 'electron'
import { spawn, type IPty } from 'node-pty'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { IPC, type PtyExit, type PtySpawnOptions } from '../shared/ipc'
import { OutputBatcher } from '../shared/pty'

interface Session {
  pty: IPty
  owner: WebContents
}

/** 셸 프로세스의 주인. renderer 는 paneId 로만 가리키고, 프로세스는 여기서만 만들고 끝낸다. */
export class PtyManager {
  private readonly sessions = new Map<string, Session>()
  private readonly batcher = new OutputBatcher(
    (paneId, data) => {
      const s = this.sessions.get(paneId)
      if (s && !s.owner.isDestroyed()) s.owner.send(IPC.ptyData, paneId, data)
    },
    (fn, ms) => {
      const t = setTimeout(fn, ms)
      return () => clearTimeout(t)
    },
  )

  /** 이미 같은 paneId 의 셸이 있으면 그대로 둔다 (StrictMode 이중 마운트 · 재호출에 셸 두 개 방지). */
  spawn(owner: WebContents, paneId: string, opts: PtySpawnOptions): void {
    const existing = this.sessions.get(paneId)
    if (existing) {
      if (existing.owner !== owner) throw new Error('다른 창의 pane')
      return
    }
    const shell = process.env['SHELL'] || '/bin/zsh'
    const pty = spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: resolveCwd(opts.cwd),
      env: shellEnv(),
    })
    const session: Session = { pty, owner }
    this.sessions.set(paneId, session)
    pty.onData((data) => this.batcher.push(paneId, data))
    pty.onExit(({ exitCode, signal }) => {
      // 같은 paneId 로 새 셸이 이미 떴으면(새로 고침 직후) 옛 셸의 끝을 알리지 않는다.
      if (this.sessions.get(paneId) !== session) return
      this.batcher.flush(paneId)
      this.sessions.delete(paneId)
      const exit: PtyExit = { exitCode, signal: signal ?? null }
      if (!owner.isDestroyed()) owner.send(IPC.ptyExit, paneId, exit)
    })
  }

  write(owner: WebContents, paneId: string, data: string): void {
    this.owned(owner, paneId)?.pty.write(data)
  }

  resize(owner: WebContents, paneId: string, cols: number, rows: number): void {
    this.owned(owner, paneId)?.pty.resize(cols, rows)
  }

  kill(owner: WebContents, paneId: string): void {
    if (this.owned(owner, paneId)) this.end(paneId)
  }

  /** 창 닫기 · 새로 고침 · 렌더러 충돌: 그 창의 셸을 모두 끝낸다. */
  killOwner(owner: WebContents): void {
    for (const [paneId, s] of this.sessions) if (s.owner === owner) this.end(paneId)
  }

  /** 앱 종료. */
  killAll(): void {
    for (const paneId of [...this.sessions.keys()]) this.end(paneId)
  }

  private owned(owner: WebContents, paneId: string): Session | undefined {
    const s = this.sessions.get(paneId)
    return s && s.owner === owner ? s : undefined
  }

  private end(paneId: string): void {
    const s = this.sessions.get(paneId)
    if (!s) return
    this.sessions.delete(paneId)
    this.batcher.drop(paneId)
    // SIGHUP: 터미널이 닫힐 때와 같은 신호 — 셸이 자기 작업(백그라운드 포함)에도 전한다.
    try {
      s.pty.kill('SIGHUP')
    } catch {
      // 이미 끝난 프로세스
    }
  }
}

function resolveCwd(cwd: string): string {
  const home = homedir()
  const path = cwd === '~' ? home : cwd.startsWith('~/') ? join(home, cwd.slice(2)) : cwd
  try {
    if (statSync(path).isDirectory()) return path
  } catch {
    // 없는 폴더
  }
  return home
}

function shellEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  // Electron · 개발 도구가 넣은 값은 셸에 넘기지 않는다.
  for (const k of Object.keys(env)) if (k.startsWith('ELECTRON_') || k === 'NODE_OPTIONS') delete env[k]
  env['TERM'] = 'xterm-256color'
  env['COLORTERM'] = 'truecolor'
  env['TERM_PROGRAM'] = 'Taskminal'
  // Finder 로 실행하면 LANG 이 없다 — UTF-8 이 아니면 한글이 깨진다.
  if (!env['LANG']) env['LANG'] = 'en_US.UTF-8'
  return env
}
