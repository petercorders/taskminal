// 69단계: 에이전트가 일을 맡기기 — `taskminal task new <이름> --worktree <브랜치>` 의 앱 쪽.
// 부른 pane 의 저장소에 39 의 worktree 만들기(요청 번호 · 기록 · 같은 요청은 결과 조회)를 그대로 쓰고, 만든 폴더로 부모를 기록한 일감을 창에 만든다.
// 45 의 작업 흐름(worker)과는 기록 파일 · 요청 번호 · 브랜치 이름이 따로다(docs/stages/69-agent-delegation.md 0절).
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { expandHome } from '../shared/cwd'
import { EXIT, type CliReply, type CliRequest, type UiReply, type UiRequest } from '../shared/cli'
import { isObj } from '../shared/guards'
import { makeWorktreeGit, type WorktreeGit, type WorktreeManagement } from './worktree-management'

type TaskNew = Extract<CliRequest, { op: 'task.new' }>

export interface DelegateDeps {
  askUi(req: UiRequest): Promise<UiReply>
  /** 39 화면과 같은 인스턴스 — 생성 기록 파일에 주인은 하나 */
  worktrees: Pick<WorktreeManagement, 'create' | 'targets'>
  git?: WorktreeGit
}

/** 요청 번호 → 일감 id — 같은 요청을 다시 보내면 창이 같은 일감을 찾는다(응답이 끊겨도 두 번 만들지 않게) */
export function delegatedTaskId(requestId: string): string {
  const h = createHash('sha256').update('taskminal-delegate:' + requestId).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

/** 새 worktree 경로 — `<기본 worktree 의 부모>/<이름>-worktrees/<브랜치 slug>`. 같은 브랜치면 늘 같은 경로(다시 시도가 39 의 '경로가 다르면 거절' 에 걸리지 않게) */
export function delegatePath(primary: string, branch: string): string {
  const slug = branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 80) || 'worktree'
  return join(dirname(primary), `${basename(primary)}-worktrees`, slug)
}

const fail = (error: string, exit: number = EXIT.error): CliReply => ({ ok: false, error, exit })
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

interface Source { taskId: string; paneId: string; cwd: string }
const isSource = (v: unknown): v is Source =>
  isObj(v) && typeof v['taskId'] === 'string' && typeof v['paneId'] === 'string' && typeof v['cwd'] === 'string' && v['cwd'].length > 0

export async function delegateTask(req: TaskNew, d: DelegateDeps): Promise<CliReply> {
  const branch = req.worktree
  const request = req.request
  if (branch === undefined || request === undefined) return fail('worktree 브랜치와 요청 번호를 확인해 주세요', EXIT.usage)
  if (!req.self) return fail('이 터미널은 Taskminal 의 일감 안이 아니에요 — 일감 안의 터미널 · 대화에서 불러 주세요', EXIT.usage)
  const again = `같은 요청으로 다시: 같은 명령에 --request ${request}`
  const names = { ...(req.template !== undefined ? { template: req.template } : {}), ...(req.group !== undefined ? { group: req.group } : {}), ...(req.status !== undefined ? { status: req.status } : {}) }

  // 1. 부른 pane 의 일감 · 폴더 (원격 · 틀린 템플릿 이름은 창이 쓰기 전에 거절)
  const src = await d.askUi({ op: 'delegate.source', ...names, self: req.self })
  if (!src.ok) return src
  if (!isSource(src.data)) return fail('부른 일감을 확인하지 못했어요')
  const source = src.data
  // pane 폴더는 ~ 로 저장될 수 있다 — git -C 는 ~ 를 펼치지 않는다(39 create 는 스스로 펼친다)
  const cwd = resolve(expandHome(source.cwd, homedir()))

  // 2. 저장소인가 — 아니면 사용법 오류(2), 조회 자체가 실패하면 1
  const probe = await (d.git ?? makeWorktreeGit())(cwd, ['rev-parse', '--is-inside-work-tree'])
  if (probe.timedOut || probe.truncated || (probe.code !== 0 && probe.code !== 128)) return fail('Git 조회에 실패했어요 — 잠시 뒤 다시 해 주세요')
  if (probe.code === 128 || probe.stdout.trim() !== 'true') return fail(`이 일감의 폴더는 Git 저장소가 아니에요: ${source.cwd}`, EXIT.usage)

  // 3. 39 의 만들기 — 기록 → worktree add → 등록을 다시 읽어 확인. 던지면 아무것도 쓰지 않은 것
  let result: Awaited<ReturnType<DelegateDeps['worktrees']['create']>>
  try {
    const targets = await d.worktrees.targets(cwd)
    const primary = targets.entries.find((e) => e.primary)?.path ?? targets.root
    result = await d.worktrees.create(cwd, { requestId: request, branch, base: req.base ?? 'HEAD', path: delegatePath(primary, branch) })
  } catch (e) {
    return fail(`worktree 를 만들지 않았어요: ${message(e)}`)
  }
  if (result.state !== 'created') return fail(`worktree 만들기 결과를 확인하지 못했어요 (${result.path}) — 폴더 · 브랜치를 확인한 뒤 ${again}`)

  // 4. 일감 — id 는 요청 번호에서. 창이 이미 그 일감을 가졌으면 그대로(existing)
  const taskId = delegatedTaskId(request)
  const made = await d.askUi({ op: 'delegate.prepare', taskId, name: req.name, cwd: result.path, parent: { taskId: source.taskId, paneId: source.paneId }, ...names, self: req.self })
  if (!made.ok) return fail(`worktree 는 만들었어요(${result.path}) — 일감을 만들지 못했어요: ${made.error} · ${again}`)
  const existing = isObj(made.data) && made.data['existing'] === true
  return {
    ok: true,
    text: `일감 '${req.name.trim()}' 을 ${existing ? '이미 만들어 두었어요' : '만들었어요'} (${taskId}) · worktree ${result.path} · 브랜치 ${branch}`,
    data: { task: taskId, path: result.path, branch, request, existing },
  }
}
