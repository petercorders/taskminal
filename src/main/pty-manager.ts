import type { WebContents } from 'electron'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { IPC, type PtyAttachResult, type PtyExit, type PtySpawnOptions } from '../shared/ipc'
import { expandHome } from '../shared/cwd'
import type { HostRequest, SessionInfo } from '../shared/ptyhost'
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
    /** pane 마다 더할 환경 변수 (24단계 — TASKMINAL_PANE_ID · 소켓 · PATH 의 taskminal). PATH 는 끝에 덧붙인다 */
    private readonly extraEnv: (paneId: string) => Record<string, string> = () => ({}),
  ) {}

  private readonly owners = new Map<string, WebContents>()
  private readonly pidOf = new Map<string, number>()
  /**
   * attach · spawn 답을 기다리는 pane — 지킴이는 답 바로 뒤에 출력 · exit 를 보내므로 한 덩어리로 와서
   * await 뒤 코드보다 먼저 처리된다. 그 사이 온 것을 모았다가 화면 다음에 넣는다.
   */
  private readonly early = new Map<string, { data: string[]; exit?: PtyExit }>()
  /** 창이 떼어진 횟수(닫기 · 새로 고침) — 요청을 기다리는 사이 떼어졌으면 주인으로 잡지 않는다 */
  private readonly detaches = new WeakMap<WebContents, number>()
  /** 지킴이와 끊긴 동안 attach · spawn 이 왔다(그 pane 은 셸 없이 오류) — 다시 붙으면 창을 다시 읽어야 한다 */
  private missed = false
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
    const early = this.early.get(paneId)
    if (early) return void early.data.push(data)
    if (this.owners.has(paneId)) this.batcher.push(paneId, data)
  }

  onHostExit(paneId: string, exit: PtyExit): void {
    const early = this.early.get(paneId)
    if (early) return void (early.exit = exit)
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
    if (!this.host.connected) {
      this.missed = true
      return { attached: false }
    }
    const { r, early } = await this.request(owner, paneId, { op: 'attach', paneId })
    if (r['found'] !== true) return { attached: false }
    this.owners.set(paneId, owner)
    this.pidOf.set(paneId, Number(r['pid']))
    this.batcher.push(paneId, RESET + String(r['screen'] ?? '') + String(r['replay'] ?? '') + early.data.join(''))
    const exited = (r['exited'] as PtyExit | undefined) ?? early.exit
    if (exited) this.onHostExit(paneId, exited)
    const detachedMs = Number(r['detachedMs']) || 0
    return { attached: true, detachedMs }
  }

  async spawn(owner: WebContents, paneId: string, opts: PtySpawnOptions): Promise<void> {
    const other = this.owners.get(paneId)
    if (other && other !== owner && !other.isDestroyed()) throw new Error('다른 창의 pane')
    const shell = pickShell(opts.shell, process.env['SHELL'], this.allowedShells)
    const env = withExtra(shellEnv(process.env), this.extraEnv(paneId))
    if (!this.host.connected) this.missed = true
    const { r, early } = await this.request(owner, paneId, {
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
    if (early.data.length > 0) this.batcher.push(paneId, early.data.join(''))
    // 이미 있던 셸(StrictMode 이중 마운트 등)이면 크기만 맞춘다 — 그 사이 창 크기가 바뀌었을 수 있다
    if (r['existing'] === true) this.host.send({ op: 'resize', paneId, cols: opts.cols, rows: opts.rows })
    if (early.exit) this.onHostExit(paneId, early.exit)
  }

  /**
   * 주인을 정하는 요청(attach · spawn). 답 전후로 온 출력 · exit 를 모으고, 기다리는 사이 창이 사라지거나
   * 떼어졌으면 지킴이에서도 떼고 실패로 — 아니면 지킴이는 그 셸에 손님이 있다고 여겨 '못 본 알림' 을 남기지 않는다.
   */
  private async request(owner: WebContents, paneId: string, req: HostRequest): Promise<{ r: Record<string, unknown>; early: { data: string[]; exit?: PtyExit } }> {
    const before = this.detaches.get(owner) ?? 0
    const early: { data: string[]; exit?: PtyExit } = { data: [] }
    this.early.set(paneId, early)
    let r: Record<string, unknown>
    try {
      r = await this.host.request(req)
    } finally {
      if (this.early.get(paneId) === early) this.early.delete(paneId)
    }
    const gone = owner.isDestroyed() || (this.detaches.get(owner) ?? 0) !== before
    if (gone && (req.op === 'spawn' || r['found'] === true)) {
      this.host.send({ op: 'detach', paneId })
      throw new Error('요청하는 사이 창이 닫히거나 새로 고쳐짐')
    }
    return { r, early }
  }

  /** 끊긴 동안 놓친 attach · spawn 이 있었는지 — 읽으면 지운다 */
  takeMissed(): boolean {
    const m = this.missed
    this.missed = false
    return m
  }

  write(owner: WebContents, paneId: string, data: string): void {
    if (this.owned(owner, paneId)) this.host.send({ op: 'write', paneId, data })
  }

  /** CLI(24단계) 의 pane send — 창이 아닌 main 이 보낸다. 지킴이에 그 셸이 없으면 지킴이가 버린다 */
  writeAny(paneId: string, data: string): boolean {
    return this.host.send({ op: 'write', paneId, data })
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
    this.detaches.set(owner, (this.detaches.get(owner) ?? 0) + 1)
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

/** 더할 변수를 넣되 PATH 는 끝에 덧붙인다 (사용자의 PATH 를 앞에 둔다) */
export function withExtra(env: Record<string, string>, extra: Record<string, string>): Record<string, string> {
  const out = { ...env }
  for (const [k, v] of Object.entries(extra)) {
    if (k === 'PATH') out['PATH'] = out['PATH'] ? `${out['PATH']}:${v}` : v
    else out[k] = v
  }
  return out
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
