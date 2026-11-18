// 64단계 일감 머리의 Jira 쓰기(상태 바꾸기 · 댓글) 화면 판단 — 단추 막기 · 결과 글 · 떠 둔 대상과 지금 연결 견주기 · 읽기 번호.
// 화면(JiraTaskHead)은 이 모델을 그리기만 한다. 한 번만 보내는 것은 main 의 쓰기 기록이 지킨다.
import { JIRA_ERROR, jiraMessage } from './jira'
import type { JiraCommentInput, JiraRefreshInput, JiraTransition, JiraTransitionInput, JiraWriteState, JiraWriteStatus } from './jira-write'

export interface JiraHeadApi {
  transitions(key: string): Promise<JiraTransition[]>
  transition(input: JiraTransitionInput): Promise<JiraWriteState>
  comment(input: JiraCommentInput): Promise<JiraWriteState>
  writeState(requestId: string): Promise<JiraWriteState | null>
  refresh(input: JiraRefreshInput): Promise<unknown>
}
/** 확인 창을 연 순간 떠 둔 것 — 그 사이 일감의 연결이 다른 이슈로 바뀌어도 이 키 · 전환 · 글 · 번호로만 보낸다 */
export type JiraIntent =
  | { kind: 'transition'; requestId: string; key: string; transitionId: string; from: string; to: string }
  | { kind: 'comment'; requestId: string; key: string; text: string }
export interface JiraHeadView {
  /** 전환 목록을 읽는 중인 이슈 키 */
  listing: string | null
  /** 읽어 온 전환 목록 — 그 이슈가 지금 연결일 때만 메뉴로 보인다 */
  menu: { key: string; items: JiraTransition[] } | null
  listError: { key: string; text: string } | null
  /** 마지막으로 보낸 쓰기 */
  write: { intent: JiraIntent; status: JiraWriteStatus; message: string } | null
  /** 전환 뒤 상태 다시 읽기 */
  reread: { key: string; state: 'reading' | 'failed' } | null
  /** 입력 중인 댓글 — 보내기에 성공할 때까지 지우지 않는다 */
  draft: string
  composing: boolean
}
export interface JiraResultLine { text: string; tone: 'status' | 'alert'; actions: Array<{ kind: 'write' | 'read'; label: string }> }

const EMPTY: JiraHeadView = { listing: null, menu: null, listError: null, write: null, reread: null, draft: '', composing: false }
const PREVIEW = 200

export const jiraTransitionIntent = (requestId: string, key: string, from: string, t: JiraTransition): JiraIntent => ({ kind: 'transition', requestId, key, transitionId: t.id, from, to: t.to.name })
export const jiraCommentIntent = (requestId: string, key: string, text: string): JiraIntent => ({ kind: 'comment', requestId, key, text })
/** 메뉴 줄 — 전환 이름이 바꿀 상태 이름과 다르면 둘 다 */
export const jiraTransitionLabel = (t: JiraTransition): string => (t.name === t.to.name ? t.name : `${t.name} → ${t.to.name}`)
/** 확인 창 글 — 이슈 키와 `현재 상태 → 바꿀 상태`, 댓글은 보낼 글의 앞부분 */
export function jiraConfirm(intent: JiraIntent): { title: string; message: string; confirmLabel: string } {
  if (intent.kind === 'transition') return { title: 'Jira 상태 바꾸기', message: `${intent.key}\n${intent.from} → ${intent.to}`, confirmLabel: '상태 바꾸기' }
  const text = intent.text.trim()
  return { title: 'Jira 댓글 남기기', message: `${intent.key}\n${text.length > PREVIEW ? `${text.slice(0, PREVIEW)}…` : text}`, confirmLabel: '댓글 남기기' }
}

// 아래 넷은 '지금 연결한 이슈 키' 와 견준다 — 다른 이슈에 보낸 것 · 읽은 것은 이 머리에 보이지 않는다.
/** 보내는 중 — 두 단추를 막는다 */
export const jiraSending = (view: JiraHeadView, key: string): boolean => view.write?.status === 'pending' && view.write.intent.key === key
export const jiraListing = (view: JiraHeadView, key: string): boolean => view.listing === key
export const jiraMenu = (view: JiraHeadView, key: string): JiraTransition[] | null => (view.menu?.key === key ? view.menu.items : null)
export const jiraListError = (view: JiraHeadView, key: string): string => (view.listError?.key === key ? view.listError.text : '')
/** 결과 한 줄 — 떠 둔 키가 지금 연결과 같을 때만 */
export function jiraResult(view: JiraHeadView, key: string): JiraResultLine | null {
  const write = view.write?.intent.key === key ? view.write : null
  if (write?.status === 'pending') return { text: '보내는 중…', tone: 'status', actions: [] }
  const parts: string[] = []
  const actions: JiraResultLine['actions'] = []
  let tone: JiraResultLine['tone'] = 'status'
  if (write?.status === 'done') parts.push(write.intent.kind === 'transition' ? '바꿨어요' : '댓글을 남겼어요')
  if (write?.status === 'failed') { parts.push(`안 됐어요: ${write.message}`); tone = 'alert' }
  if (write?.status === 'unknown') { parts.push(write.message ? `됐는지 모름 — ${write.message}` : '됐는지 모름'); tone = 'alert'; actions.push({ kind: 'write', label: '다시 확인' }) }
  if (view.reread?.key === key && view.reread.state === 'failed') { parts.push('상태를 다시 읽지 못했어요'); tone = 'alert'; actions.push({ kind: 'read', label: '상태 다시 읽기' }) }
  return parts.length ? { text: parts.join(' · '), tone, actions } : null
}

/** main 이 표시(`[jira]`)를 붙여 거절한 것 — 보내기 전에 막힌 요청이다 */
const refused = (reason: unknown) => reason instanceof Error && reason.message.includes(JIRA_ERROR)

export class JiraHead {
  view: JiraHeadView = EMPTY
  /** 읽기 · 쓰기마다 번호 — 늦게 온 옛 답이 더 새 상태를 덮지 않게 */
  private listSeq = 0
  private readSeq = 0
  private writeSeq = 0
  private asking = false
  private readonly listeners = new Set<() => void>()
  /** onState: 상태를 다시 읽어 남긴 뒤 — 화면이 연결 목록을 새로 싣는다 */
  constructor(private readonly api: JiraHeadApi, private readonly taskId: string, private readonly onState: () => void = () => {}) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private set(patch: Partial<JiraHeadView>) { this.view = { ...this.view, ...patch }; this.listeners.forEach((l) => l()) }
  /** 새로 고르기 시작 — 끝난(됨 · 안 됨) 결과 줄은 치운다. 됐는지 모름은 다시 확인할 때까지 남긴다 */
  private fresh(): Partial<JiraHeadView> {
    const status = this.view.write?.status
    return status === 'done' || status === 'failed' ? { write: null } : {}
  }
  /** '상태 바꾸기 ▾' — 누른 순간의 연결 키로 전환 목록을 읽는다. 주기로 읽지 않고 메뉴를 열 때마다 새로 읽는다 */
  openMenu(key: string): Promise<void> {
    if (jiraSending(this.view, key) || jiraListing(this.view, key)) return Promise.resolve()
    const seq = ++this.listSeq
    this.set({ ...this.fresh(), listing: key, menu: null, listError: null })
    return this.api.transitions(key).then((items) => {
      if (seq !== this.listSeq) return
      this.set({ listing: null, menu: { key, items } })
    }, (reason: unknown) => {
      if (seq !== this.listSeq) return
      this.set({ listing: null, listError: { key, text: jiraMessage(reason, '전환 목록을 읽지 못했어요. 다시 눌러 주세요.') } })
    })
  }
  /** 메뉴를 닫음 · 고름 — 읽는 중이던 답도 버린다 */
  closeMenu(): void { this.listSeq++; this.set({ listing: null, menu: null }) }
  compose(open: boolean): void { this.set({ ...(open ? this.fresh() : {}), composing: open }) }
  setDraft(text: string): void { this.set({ draft: text }) }
  /** 확인 뒤 보내기 — 떠 둔 것 그대로. 그 이슈에 보내는 중이면 받지 않는다(같은 프레임에 두 번 눌러도 한 번) */
  send(intent: JiraIntent): Promise<void> {
    if (jiraSending(this.view, intent.key)) return Promise.resolve()
    return this.run(intent, false)
  }
  /** '됐는지 모름' 의 다시 확인 — 같은 번호 · 같은 내용으로. main 이 먼저 됐는지 확인하고 안 됐을 때만 다시 보낸다 */
  retry(): Promise<void> {
    const write = this.view.write
    return write?.status === 'unknown' ? this.run(write.intent, true) : Promise.resolve()
  }
  private run(intent: JiraIntent, again: boolean): Promise<void> {
    const seq = ++this.writeSeq
    // 쓴 뒤에는 읽어 둔 전환 목록이 낡는다 — 가진 목록 · 읽는 중이던 답을 버린다(다음에 메뉴를 열 때 새로 읽는다)
    this.listSeq++
    this.set({ write: { intent, status: 'pending', message: '' }, listing: null, menu: null, listError: null })
    const call = intent.kind === 'transition'
      ? this.api.transition({ key: intent.key, transitionId: intent.transitionId, requestId: intent.requestId })
      : this.api.comment({ key: intent.key, text: intent.text, requestId: intent.requestId })
    return call.then(
      (state) => this.settle(seq, intent, state.status, state.message),
      // 처음 보낸 것을 main 이 거절했으면 안 됨. 다시 확인하던 것 · 그 밖의 오류는 여전히 됐는지 모른다
      (reason: unknown) => this.settle(seq, intent, !again && refused(reason) ? 'failed' : 'unknown', jiraMessage(reason, '결과를 확인하지 못했어요.')),
    )
  }
  private settle(seq: number, intent: JiraIntent, status: JiraWriteStatus, message: string): void {
    // 더 새 쓰기가 칸을 차지했거나 이미 정해졌다 — 늦게 온 답은 버린다
    if (seq !== this.writeSeq) return
    this.writeSeq++
    // 입력 중인 글은 보내기에 성공했을 때만, 보낸 글 그대로일 때만 지운다
    const sent = status === 'done' && intent.kind === 'comment' && this.view.draft === intent.text
    this.set({ write: { intent, status, message }, ...(sent ? { draft: '', composing: false } : {}) })
    if (status === 'done' && intent.kind === 'transition') void this.readState(intent.key)
  }
  /** 전환 뒤 상태 다시 읽기 — 앞 읽기가 도는 중이어도 건너뛰지 않고 새로 시작한다(앞 읽기는 전환 전 상태일 수 있어 답을 번호로 버린다) */
  private readState(key: string): Promise<void> {
    const seq = ++this.readSeq
    this.set({ reread: { key, state: 'reading' } })
    return this.api.refresh({ taskId: this.taskId, key }).then(() => {
      if (seq !== this.readSeq) return
      this.set({ reread: null })
      this.onState()
    }, () => {
      if (seq !== this.readSeq) return
      this.set({ reread: { key, state: 'failed' } })
    })
  }
  /** '상태 다시 읽기' — 읽기만 다시 한다. 전환은 다시 보내지 않는다 */
  rereadState(): Promise<void> {
    const reread = this.view.reread
    return reread?.state === 'failed' ? this.readState(reread.key) : Promise.resolve()
  }
  /** 다른 일감에 갔다 돌아옴 — 보내는 중이던 쓰기가 그 사이 끝났는지 main 의 기록에 묻는다. 한 번에 하나, 늦게 온 답은 더 새 상태를 덮지 않는다 */
  resume(): Promise<void> {
    const write = this.view.write
    if (write?.status !== 'pending' || this.asking) return Promise.resolve()
    const seq = this.writeSeq
    this.asking = true
    return this.api.writeState(write.intent.requestId).then((state) => {
      this.asking = false
      if (state && state.status !== 'pending') this.settle(seq, write.intent, state.status, state.message)
    }, () => { this.asking = false })
  }
}
