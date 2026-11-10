import type { WebContents } from 'electron'
import { spawn, type IPty } from 'node-pty'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { IPC, type PtyExit, type PtySpawnOptions } from '../shared/ipc'
import { OutputBatcher, shellEnv } from '../shared/pty'

const KILL_AFTER_MS = 2000 // SIGHUP 뒤 이만큼 지나도 살아 있으면 SIGKILL

interface Session {
  pty: IPty
  owner: WebContents
}

/** 셸 프로세스의 주인. renderer 는 paneId 로만 가리키고, 프로세스는 여기서만 만들고 끝낸다. */
export class PtyManager {
  private readonly sessions = new Map<string, Session>()
  /** SIGHUP 을 보냈지만 아직 끝나지 않은 셸 — trap '' HUP 등. 목록에서 빠져도 여기서 끝까지 쫓는다. */
  private readonly dying = new Map<IPty, ReturnType<typeof setTimeout>>()
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

  /**
   * 이미 같은 paneId 의 셸이 있으면 새로 만들지 않고 크기만 맞춘다
   * (StrictMode 이중 마운트 · pane 이 다시 붙을 때 — 그 사이 창 크기가 바뀌었을 수 있다).
   */
  spawn(owner: WebContents, paneId: string, opts: PtySpawnOptions): void {
    const existing = this.sessions.get(paneId)
    if (existing) {
      if (existing.owner !== owner) throw new Error('다른 창의 pane')
      existing.pty.resize(opts.cols, opts.rows)
      return
    }
    const shell = process.env['SHELL'] || '/bin/zsh'
    const pty = spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: resolveCwd(opts.cwd),
      env: shellEnv(process.env),
    })
    const session: Session = { pty, owner }
    this.sessions.set(paneId, session)
    // 새로 고침 뒤 같은 paneId 로 새 셸이 떴으면, 끝나 가는 옛 셸의 출력은 버린다.
    pty.onData((data) => {
      if (this.sessions.get(paneId) === session) this.batcher.push(paneId, data)
    })
    pty.onExit(({ exitCode, signal }) => {
      const timer = this.dying.get(pty)
      if (timer) clearTimeout(timer)
      this.dying.delete(pty)
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

  /**
   * 앱 종료. 살아 있는 셸에 SIGHUP 만 보낸다 — SIGKILL 은 보내지 않는다.
   * 종료 때는 창 닫기(① 경로)가 먼저 돌아 셸이 이미 dying 에 들어 있는데, 그것을 바로 SIGKILL 했더니 zsh 가
   * 정리 없이 죽어 다음에 뜨는 셸이 약 10초 늦게 시작했다(3단계 e2e 에서 측정 · 이분 탐색으로 이 줄을 찾음).
   * main 이 끝나면 pty 가 닫혀 HUP 을 무시하는 셸도 끝난다(e2e 로 확인). 남은 타이머는 unref 라 종료를 막지 않는다.
   */
  killAll(): void {
    for (const paneId of [...this.sessions.keys()]) this.end(paneId, false)
  }

  private owned(owner: WebContents, paneId: string): Session | undefined {
    const s = this.sessions.get(paneId)
    return s && s.owner === owner ? s : undefined
  }

  private end(paneId: string, escalate = true): void {
    const s = this.sessions.get(paneId)
    if (!s) return
    this.sessions.delete(paneId)
    this.batcher.drop(paneId)
    // SIGHUP: 터미널이 닫힐 때와 같은 신호 — 셸이 자기 작업(백그라운드 포함)에도 전한다.
    // 무시하는 셸은 KILL_AFTER_MS 뒤 SIGKILL (onExit 가 오면 타이머를 지운다).
    signal(s.pty, 'SIGHUP')
    if (!escalate) return
    const timer = setTimeout(() => {
      this.dying.delete(s.pty)
      signal(s.pty, 'SIGKILL')
    }, KILL_AFTER_MS)
    timer.unref()
    this.dying.set(s.pty, timer)
  }
}

function signal(pty: IPty, sig: string): void {
  try {
    pty.kill(sig)
  } catch {
    // 이미 끝난 프로세스
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
