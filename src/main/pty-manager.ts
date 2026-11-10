import type { WebContents } from 'electron'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { IPC, type PtyAttachResult, type PtyExit, type PtySpawnOptions } from '../shared/ipc'
import { expandHome } from '../shared/cwd'
import type { SessionInfo } from '../shared/ptyhost'
import { integrationEnv, OutputBatcher, pickShell, shellEnv } from '../shared/pty'
import type { HostClient } from './ptyhost/client'

/** 화면을 처음부터 다시 그리기 전에 지운다 (ESC c — 화면 · 스크롤 · 모드 초기화) */
const RESET = '\x1bc'

/**
 * 셸의 주인(창)을 아는 쪽. 셸 프로세스는 셸 지킴이(앱 밖 프로세스, 16단계)가 갖고, 여기는 paneId 를 창에 이어 준다.
 * renderer 는 paneId 로만 가리킨다. 창이 닫히거나 새로 고쳐져도 셸은 지킴이에 남는다(detach).
 */
export class PtyManager {
  /**
   * @param zshIntegrationDir 셸 통합 시작 파일 폴더(resources/shell/zsh). null 이면 통합 없이 띄운다.
   * @param allowedShells 설정에서 고를 수 있는 셸(/etc/shells) — 그 밖의 경로는 $SHELL 로 띄운다.
   */
  constructor(
    private readonly host: HostClient,
    private readonly zshIntegrationDir: string | null = null,
    private readonly allowedShells: readonly string[] = [],
  ) {}

  private readonly owners = new Map<string, WebContents>()
  private readonly pidOf = new Map<string, number>()
  private readonly batcher = new OutputBatcher(
    (paneId, data) => {
      const owner = this.owners.get(paneId)
      if (owner && !owner.isDestroyed()) owner.send(IPC.ptyData, paneId, data)
    },
    (fn, ms) => {
      const t = setTimeout(fn, ms)
      return () => clearTimeout(t)
    },
  )

  /** 지킴이가 보낸 출력 — 주인이 있는 pane 만 (주인 없는 셸의 출력은 지킴이 화면에만 남는다) */
  onHostData(paneId: string, data: string): void {
    if (this.owners.has(paneId)) this.batcher.push(paneId, data)
  }

  onHostExit(paneId: string, exit: PtyExit): void {
    const owner = this.owners.get(paneId)
    if (!owner) return
    this.batcher.flush(paneId)
    this.owners.delete(paneId)
    this.pidOf.delete(paneId)
    if (!owner.isDestroyed()) owner.send(IPC.ptyExit, paneId, exit)
  }

  /**
   * 지킴이에 이 pane 의 셸이 있으면 붙는다: 화면(serialize) · 명령 상태를 출력 길로 먼저 보내고 답한다.
   * 없으면 attached:false — renderer 가 13단계 되살리기 뒤 spawn 한다.
   */
  async attach(owner: WebContents, paneId: string): Promise<PtyAttachResult> {
    const other = this.owners.get(paneId)
    if (other && other !== owner && !other.isDestroyed()) throw new Error('다른 창의 pane')
    if (!this.host.connected) return { attached: false }
    const r = await this.host.request({ op: 'attach', paneId })
    if (r['found'] !== true) return { attached: false }
    this.owners.set(paneId, owner)
    this.pidOf.set(paneId, Number(r['pid']))
    this.batcher.push(paneId, RESET + String(r['screen'] ?? '') + String(r['replay'] ?? ''))
    const exited = r['exited'] as PtyExit | undefined
    if (exited) this.onHostExit(paneId, exited)
    const detachedMs = Number(r['detachedMs']) || 0
    return { attached: true, detachedMs }
  }

  async spawn(owner: WebContents, paneId: string, opts: PtySpawnOptions): Promise<void> {
    const other = this.owners.get(paneId)
    if (other && other !== owner && !other.isDestroyed()) throw new Error('다른 창의 pane')
    const shell = pickShell(opts.shell, process.env['SHELL'], this.allowedShells)
    const env = shellEnv(process.env)
    const r = await this.host.request({
      op: 'spawn',
      paneId,
      file: shell,
      args: ['-l'],
      cwd: resolveCwd(opts.cwd),
      env: opts.integration === false ? env : integrationEnv(env, shell, this.zshIntegrationDir),
      cols: opts.cols,
      rows: opts.rows,
    })
    this.owners.set(paneId, owner)
    this.pidOf.set(paneId, Number(r['pid']))
    // 이미 있던 셸(StrictMode 이중 마운트 등)이면 크기만 맞춘다 — 그 사이 창 크기가 바뀌었을 수 있다
    if (r['existing'] === true) this.host.send({ op: 'resize', paneId, cols: opts.cols, rows: opts.rows })
  }

  write(owner: WebContents, paneId: string, data: string): void {
    if (this.owned(owner, paneId)) this.host.send({ op: 'write', paneId, data })
  }

  resize(owner: WebContents, paneId: string, cols: number, rows: number): void {
    if (this.owned(owner, paneId)) this.host.send({ op: 'resize', paneId, cols, rows })
  }

  /** 일감 · 탭 · pane 지우기 — 셸을 끝낸다 */
  kill(owner: WebContents, paneId: string): void {
    if (!this.owned(owner, paneId)) return
    this.forget(paneId)
    this.host.send({ op: 'kill', paneId })
  }

  /** 주인 없는 셸 끝내기 (설정 › 셸 지킴이) — 지금 어느 창도 쓰지 않는 pane 만 */
  killUnowned(paneIds: readonly string[]): number {
    let n = 0
    for (const paneId of paneIds) {
      const owner = this.owners.get(paneId)
      if (owner && !owner.isDestroyed()) continue
      this.forget(paneId)
      if (this.host.send({ op: 'kill', paneId })) n++
    }
    return n
  }

  /** 창 닫기 · 새로 고침 · 렌더러 충돌: 그 창의 셸을 지킴이에 남겨 두고 떼기만 한다 */
  detachOwner(owner: WebContents): void {
    for (const [paneId, o] of [...this.owners]) {
      if (o !== owner) continue
      this.forget(paneId)
      this.host.send({ op: 'detach', paneId })
    }
  }

  /** 같은 지킴이에 다시 붙었다(연결이 잠깐 끊김) — 붙어 있던 pane 의 화면을 처음부터 다시 받는다 */
  async reattachAll(): Promise<void> {
    for (const [paneId, owner] of [...this.owners]) {
      if (owner.isDestroyed()) continue
      this.batcher.drop(paneId)
      await this.attach(owner, paneId).catch(() => undefined)
    }
  }

  /** 지킴이를 잃었다(셸도 끝남) — 주인 표를 비운다. 창은 다시 읽혀 새로 띄운다 */
  clear(): void {
    for (const paneId of [...this.owners.keys()]) this.forget(paneId)
  }

  /** 그 창의 셸 pid — lsof 로 작업 폴더를 물을 때 (요청한 pane 중 그 창의 것만) */
  pids(owner: WebContents, paneIds: readonly string[]): Record<string, number> {
    const out: Record<string, number> = {}
    for (const id of paneIds) {
      const pid = this.owned(owner, id) ? this.pidOf.get(id) : undefined
      if (pid) out[id] = pid
    }
    return out
  }

  async sessions(clearUnseen = false): Promise<SessionInfo[]> {
    if (!this.host.connected) return []
    const r = await this.host.request({ op: 'list', clearUnseen })
    return Array.isArray(r['sessions']) ? (r['sessions'] as SessionInfo[]) : []
  }

  private owned(owner: WebContents, paneId: string): boolean {
    return this.owners.get(paneId) === owner
  }

  private forget(paneId: string): void {
    this.batcher.drop(paneId)
    this.owners.delete(paneId)
    this.pidOf.delete(paneId)
  }
}

function resolveCwd(cwd: string): string {
  const home = homedir()
  const path = expandHome(cwd, home)
  try {
    if (statSync(path).isDirectory()) return path
  } catch {
    // 없는 폴더
  }
  return home
}
