// taskminal 명령의 화면 쪽 (24단계) — main 이 물은 요청을 '사람이 누를 때와 같은 reducer 동작' 과 답으로 바꾼다.
// 순수: 상태 · 활동 · 시계 · id 를 받아 할 일(dispatch 목록 · 띄울 탭 · 지우기 · 알림)과 답을 돌려준다. App 이 실행한다.
import type { PaneActivity } from '../shared/activity'
import { formatRows, listRows, resolvePane, resolveTask, runningCount, type PaneTarget, type UiReply, type UiRequest } from '../shared/cli'
import { hasPane } from '../shared/layout'
import { createTask, defaultTaskCwd, tabShownLabel, templateIdCount } from '../shared/model'
import type { AppState, Id, Task } from '../shared/types'
import { reducer, type Action } from './store'

export interface CliCtx {
  state: AppState
  activity: Readonly<Record<string, PaneActivity>>
  now: number
  newId: () => Id
  /** 명령 글 가리기 — CLI 출력은 에이전트로 가는 길이라 늘 가린다 */
  mask: (s: string) => string
}

export interface CliEffect {
  reply: UiReply
  /** 차례로 dispatch */
  actions: Action[]
  /** 숨긴 채 띄울 탭 (셸 · 대화가 떠야 보내기 · 읽기가 된다) */
  seeTabs: Id[]
  /** 화면의 지우기와 같은 길(되돌리기 알림) — 답을 보낸 뒤 */
  remove?: Id
  /** 그 pane 을 '확인 필요' 로 · macOS 알림 */
  notify?: { paneId: Id; text: string }
}

const done = (reply: UiReply, actions: Action[] = [], seeTabs: Id[] = []): CliEffect => ({ reply, actions, seeTabs })
const failed = (error: string, candidates?: string[]): CliEffect => done(candidates ? { ok: false, error, candidates, exit: 2 } : { ok: false, error, exit: 2 })

/** 상태 · 묶음 · 템플릿: id → 이름(대소문자 무시) */
function byName<T extends { id: Id; name: string }>(list: readonly T[], ref: string): T | null {
  return list.find((x) => x.id === ref) ?? list.find((x) => x.name === ref) ?? list.find((x) => x.name.toLowerCase() === ref.trim().toLowerCase()) ?? null
}

function tabOfPane(task: Task, paneId: Id) {
  return task.tabs.find((t) => hasPane(t.layout, paneId))
}

/** 명령이 만든 탭 · pane 이 사용자가 치던 곳을 빼앗지 않게 — 그 일감의 보던 탭 · pane 으로 되돌리는 동작 (24 리뷰) */
function keepFocus(task: Task): Action[] {
  const tab = task.tabs.find((x) => x.id === task.activeTabId)
  return tab ? [{ type: 'pane/focus', taskId: task.id, paneId: tab.activePaneId }] : []
}

export function paneTarget(task: Task, paneId: Id): PaneTarget | null {
  const pane = task.panes[paneId]
  const tab = tabOfPane(task, paneId)
  if (!pane || !tab) return null
  const t: PaneTarget = { paneId, label: `${task.name} › ${tabShownLabel(task, tab)}`, kind: pane.kind === 'chat' ? 'chat' : pane.kind === 'review' ? 'review' : 'terminal', cwd: pane.cwd, pending: pane.pendingCommand !== undefined }
  if (pane.kind === 'chat') t.chat = { agent: pane.chat?.agent ?? 'claude', ...(pane.chat?.sessionId ? { sessionId: pane.chat.sessionId } : {}), ...(pane.chat?.forkAt ? { forkAt: pane.chat.forkAt } : {}) }
  return t
}

/** 이 동작들을 지금 상태에 돌린 결과 — 새 id 가 어디에 들어갔는지 보려고 */
const run = (state: AppState, actions: readonly Action[]) => actions.reduce(reducer, state)

export function handleCliUi(req: UiRequest, ctx: CliCtx): CliEffect {
  const { state } = ctx
  const self = req.self
  switch (req.op) {
    case 'list': {
      const rows = listRows(state, ctx.activity, self, ctx.now, ctx.mask)
      return done({ ok: true, text: formatRows(rows), data: rows })
    }
    case 'task.new': {
      const s = state.settings
      const tpl = req.template !== undefined ? byName(s.templates, req.template) : null
      if (req.template !== undefined && !tpl) return failed(`'${req.template}' 템플릿이 없어요`, s.templates.map((t) => t.name))
      const status = req.status !== undefined ? byName(s.statuses, req.status) : s.statuses[0]!
      if (!status) return failed(`'${req.status}' 상태가 없어요`, s.statuses.map((x) => x.name))
      const group = req.group !== undefined ? byName(s.groups, req.group) : null
      if (req.group !== undefined && !group) return failed(`'${req.group}' 묶음이 없어요`, s.groups.map((g) => g.name))
      const selfTask = self ? state.tasks.find((t) => Object.hasOwn(t.panes, self)) : undefined
      const cwd = req.cwd ?? (self && selfTask ? selfTask.panes[self]!.cwd : defaultTaskCwd(state))
      const task = createTask({ name: req.name.trim(), cwd, templateId: tpl?.id ?? s.defaultTemplateId, statusId: status.id, groupId: group?.id ?? null, color: null }, s, ctx.newId, ctx.now)
      // 만들기는 그 일감을 연다(reducer) — 사람이 보던 화면은 그대로 둔다. 시작 명령이 돌게 첫 탭은 띄운다
      const back: Action[] = state.activeTaskId ? [{ type: 'task/select', id: state.activeTaskId }] : []
      return done({ ok: true, text: `일감 '${task.name}' 을 만들었어요 (${task.id})`, data: { task: task.id } }, [{ type: 'task/create', task }, ...back], task.activeTabId ? [task.activeTabId] : [])
    }
    case 'task.move': {
      const r = resolveTask(state, req.task, self)
      if (!r.ok) return failed(r.error, r.candidates)
      const t = r.value
      const status = req.status !== undefined ? byName(state.settings.statuses, req.status) : null
      if (req.status !== undefined && !status) return failed(`'${req.status}' 상태가 없어요`, state.settings.statuses.map((x) => x.name))
      const none = req.group === '' || req.group === 'none'
      const group = req.group !== undefined && !none ? byName(state.settings.groups, req.group) : null
      if (req.group !== undefined && !none && !group) return failed(`'${req.group}' 묶음이 없어요`, state.settings.groups.map((g) => g.name))
      const patch = { ...(status ? { statusId: status.id } : {}), ...(req.group !== undefined ? { groupId: none ? null : group!.id } : {}) }
      const from = state.settings.statuses.find((x) => x.id === t.statusId)?.name ?? ''
      const parts = [status ? `${from} → ${status.name}` : null, req.group !== undefined ? `묶음 ${group?.name ?? '없음'}` : null].filter(Boolean)
      return done({ ok: true, text: `${t.name}: ${parts.join(' · ')}` }, [{ type: 'task/edit', id: t.id, patch }])
    }
    case 'task.open': {
      const r = resolveTask(state, req.task, self)
      if (!r.ok) return failed(r.error, r.candidates)
      return done({ ok: true, text: `${r.value.name} 을 열었어요` }, [{ type: 'task/select', id: r.value.id }])
    }
    case 'task.rename': {
      const r = resolveTask(state, req.task, self)
      if (!r.ok) return failed(r.error, r.candidates)
      return done({ ok: true, text: `${r.value.name} → ${req.name.trim()}` }, [{ type: 'task/edit', id: r.value.id, patch: { name: req.name } }])
    }
    case 'task.color': {
      const r = resolveTask(state, req.task, self)
      if (!r.ok) return failed(r.error, r.candidates)
      return done({ ok: true, text: `${r.value.name}: 색 ${req.color}` }, [{ type: 'task/edit', id: r.value.id, patch: { color: req.color === 'none' ? null : req.color } }])
    }
    case 'task.remove': {
      const r = resolveTask(state, req.task, self)
      if (!r.ok) return failed(r.error, r.candidates)
      const busy = runningCount(r.value, ctx.activity)
      if (busy > 0 && !req.force) return done({ ok: false, error: `${r.value.name} 에 실행 중인 명령이 ${busy}개 있어요 — 끝내려면 --force`, exit: 1 })
      return { ...done({ ok: true, text: `${r.value.name} 을 지웠어요 (앱에서 ⌘Z 로 되돌릴 수 있어요)` }), remove: r.value.id }
    }
    case 'task.note': {
      const r = resolveTask(state, req.task, self)
      if (!r.ok) return failed(r.error, r.candidates)
      const note = { id: ctx.newId(), text: req.text, by: 'agent' as const, at: ctx.now }
      return done({ ok: true, text: `${r.value.name} 메모에 남겼어요` }, [{ type: 'note/add', taskId: r.value.id, note }])
    }
    case 'tab.new': {
      const r = resolveTask(state, req.task, self)
      if (!r.ok) return failed(r.error, r.candidates)
      const t = r.value
      let actions: Action[]
      if (req.template !== undefined) {
        const tpl = byName(state.settings.templates, req.template)
        if (!tpl) return failed(`'${req.template}' 템플릿이 없어요`, state.settings.templates.map((x) => x.name))
        actions = [{ type: 'tab/add-template', taskId: t.id, template: tpl, ids: Array.from({ length: templateIdCount(tpl) }, ctx.newId) }]
      } else {
        const tabId = ctx.newId()
        const paneId = ctx.newId()
        const cwd = (self && t.panes[self]?.cwd) || t.cwd
        actions = [{ type: 'tab/add', taskId: t.id, tabId, paneId, ...(req.cmd ? { spec: { cwd, command: req.cmd } } : {}) }]
      }
      const after = run(state, actions).tasks.find((x) => x.id === t.id)!
      const newTabs = after.tabs.filter((x) => !t.tabs.some((y) => y.id === x.id))
      const first = newTabs[0]
      if (!first) return failed('탭을 만들지 못했어요')
      if (req.title !== undefined) actions.push({ type: 'tab/rename', taskId: t.id, tabId: first.id, title: req.title })
      actions.push(...keepFocus(t))
      const label = req.title?.trim() || tabShownLabel(after, first)
      return done({ ok: true, text: `탭 '${label}' 을 만들었어요 · pane ${first.activePaneId}`, data: { tab: first.id, pane: first.activePaneId } }, actions, newTabs.map((x) => x.id))
    }
    case 'pane.split': {
      const r = resolvePane(state, req.pane, self)
      if (!r.ok) return failed(r.error, r.candidates)
      const { taskId, paneId, tabId } = r.value
      const task = state.tasks.find((x) => x.id === taskId)!
      const id = ctx.newId()
      const cwd = task.panes[paneId]?.cwd ?? task.cwd
      const actions: Action[] = [
        { type: 'pane/focus', taskId, paneId },
        { type: 'pane/split', taskId, dir: req.dir, paneId: id, ...(req.cmd ? { spec: { cwd, command: req.cmd } } : {}) },
        ...keepFocus(task),
      ]
      const after = run(state, actions).tasks.find((x) => x.id === taskId)!
      if (!after.panes[id]) return failed('나누지 못했어요')
      return done({ ok: true, text: `pane ${id} 를 만들었어요 (${task.name} › ${tabShownLabel(after, after.tabs.find((x) => x.id === tabId)!)})`, data: { pane: id } }, actions, [tabId])
    }
    case 'notify': {
      const r = resolveTask(state, req.task, self)
      if (!r.ok) return failed(r.error, r.candidates)
      const t = r.value
      const active = t.tabs.find((x) => x.id === t.activeTabId)?.activePaneId
      const paneId = self && Object.hasOwn(t.panes, self) ? self : active
      if (!paneId) return failed(`${t.name} 에 터미널이 없어요`)
      return { ...done({ ok: true, text: `${t.name} 을 확인 필요로 올렸어요` }), notify: { paneId, text: req.text } }
    }
    case 'pane.resolve': {
      const r = resolvePane(state, req.pane, self)
      if (!r.ok) return failed(r.error, r.candidates)
      const task = state.tasks.find((x) => x.id === r.value.taskId)!
      const target = paneTarget(task, r.value.paneId)
      return target ? done({ ok: true, target }, [], [r.value.tabId]) : failed('그 pane 을 찾지 못했어요')
    }
    case 'chat.panes': {
      if (req.all) {
        const r = resolveTask(state, req.task, self)
        if (!r.ok) return failed(r.error, r.candidates)
        const targets = Object.values(r.value.panes)
          .filter((p) => p.kind === 'chat' && p.id !== self)
          .map((p) => paneTarget(r.value, p.id))
          .filter((x): x is PaneTarget => x !== null)
        return done({ ok: true, targets })
      }
      const targets: PaneTarget[] = []
      for (const ref of req.panes) {
        const r = resolvePane(state, ref, self)
        if (!r.ok) return failed(r.error, r.candidates)
        const t = paneTarget(state.tasks.find((x) => x.id === r.value.taskId)!, r.value.paneId)
        if (!t || t.kind !== 'chat') return failed(`${t?.label ?? ref} 은 대화 pane 이 아니에요`)
        targets.push(t)
      }
      return done({ ok: true, targets })
    }
    case 'workflow.prepare': {
      const t=state.tasks.find(t=>t.id===req.taskId&&!t.host&&t.archivedAt===undefined)
      if(!t)return failed('일감이 닫혔어요')
      const existing=t.panes[req.paneId]
      if(existing)return existing.workflowRunId===req.runId&&existing.chat?.agent===req.agent?done({ok:true}):failed('다른 대화와 겹쳐요')
      if(state.tasks.some(t=>t.panes[req.paneId]||t.tabs.some(tab=>tab.id===req.tabId)))return failed('이미 쓰는 대화 번호예요')
      return done({ok:true},[{type:'chat/add-tab',taskId:t.id,paneId:req.paneId,tabId:req.tabId,agent:req.agent,workflowRunId:req.runId,label:req.label},...keepFocus(t)],[req.tabId])
    }
    case 'chat.new': {
      const r = resolveTask(state, req.task, self)
      if (!r.ok) return failed(r.error, r.candidates)
      const t = r.value
      const paneId = ctx.newId()
      const tab = t.tabs.find((x) => x.id === t.activeTabId)
      // 부른 터미널 옆에 — 그 일감 안이면 그 pane 을 활성으로 한 뒤 나눈다. 끝나면 사용자가 보던 pane 으로 되돌린다
      const focus: Action[] = self && Object.hasOwn(t.panes, self) ? [{ type: 'pane/focus', taskId: t.id, paneId: self }] : []
      const actions: Action[] =
        req.where === 'tab' || !tab
          ? [{ type: 'chat/add-tab', taskId: t.id, tabId: ctx.newId(), paneId, agent: req.agent }]
          : [...focus, { type: 'chat/split', taskId: t.id, paneId, agent: req.agent, dir: req.where }]
      actions.push(...keepFocus(t))
      const after = run(state, actions).tasks.find((x) => x.id === t.id)!
      const target = paneTarget(after, paneId)
      if (!target) return failed('대화 pane 을 만들지 못했어요')
      return done({ ok: true, target }, actions, [tabOfPane(after, paneId)!.id])
    }
  }
}
