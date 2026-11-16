import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { clampRatio, layoutRects, setRatioAt, type Divider, type SplitPath } from '../shared/layout'
import type { ActivityEvent, PaneActivity } from '../shared/activity'
import type { Id, Pane, Tab } from '../shared/types'
import { PaneHead } from './activity-ui'
import { shortPath } from './sidebar-model'
import type { TermSettings } from './term-settings'
import type { Shortcut } from '../shared/keymap'
import { FindBar } from './FindBar'
import { TerminalPane, type CommandDone } from './TerminalPane'
import type { MaskSettings } from './secret-mask'
import { ChatPane } from './ChatPane'
import { ReviewPane, type ReviewRequest } from './ReviewPane'
import type { ToastSpec } from './Toast'
import type { ChatPermission } from '../shared/chat'
import type { RemoteState } from '../shared/remote'

interface Props {
  tab: Tab
  panes: Record<Id, Pane>
  /** 일감 · 탭이 모두 보이는 중 — 그때만 활성 pane 이 포커스를 가져간다 */
  visible: boolean
  focusSignal: number
  term: TermSettings
  /** paneId → 활동 (저장하지 않는 런타임 값) */
  activity: Readonly<Record<Id, PaneActivity>>
  onActivity(paneId: Id, event: ActivityEvent): void
  onFocusPane(paneId: Id): void
  onRatio(path: SplitPath, ratio: number): void
  /** ⌘F 찾기 막대가 열린 pane (15d) · 다시 누른 횟수 · 닫기 */
  find: { paneId: Id | null; signal: number; query?: string; onClose(): void; shortcuts: readonly Shortcut[] }
  /** 깨끗하지 않게 끝난 셸을 본 뒤 키를 눌렀다 */
  onClosePane(paneId: Id): void
  /** 템플릿 시작 명령을 보냈다 */
  onStartSent(paneId: Id): void
  /** 셸 통합이 알려 준 명령 끝 — 명령 기록 (19단계) */
  onCommandDone(paneId: Id, done: CommandDone): void
  /** 셸 안의 cd (OSC 7) */
  onCwd(paneId: Id, cwd: string): void
  /** 마우스로 끄는 것이 끝났다(놓음 · 취소) — 터미널이 포커스를 다시 가져가게 */
  onDragEnd(): void
  /** 화면에서 비밀값 가리기 (17단계) */
  mask: MaskSettings
  /** 원격 일감 (25단계) — 이 탭의 터미널 pane 은 모두 같은 host 로 ssh. signal 이 바뀌면 끊긴 pane 이 지금 다시 붙는다 */
  remote?: { host: string; tmux: boolean; signal: number; onState(paneId: Id, state: RemoteState): void } | undefined
  onAllow(paneId: Id, hit: { hash: string; kind: string }): void
  /** 대화 pane (21단계) */
  chat: {
    permission: ChatPermission
    onPermission(p: ChatPermission): void
    onSession(paneId: Id, sessionId: string): void
    onToTerminal(paneId: Id): void
    /** 26단계 ⌘J 셸 꺼내기 */
    onShell(paneId: Id): void
    onOpenLogin(paneId: Id): void
    onRewound(paneId: Id, forkAt: string | null, sessionId?: string): void
    onBranch(paneId: Id, index: number, at: number): void
    onToast(text: string, sub?: string): void
    /** 도구 줄의 'diff 열기' — 그 일감의 변경 pane 에서 그 파일 (23단계) */
    onOpenDiff(paneId: Id, path: string): void
    /** '대화에 묻기' 로 넣을 글 — pane 마다 한 번(n) */
    jump?: {paneId:Id;fingerprint:string;at:number;n:number}|null
    onJumpTaken(n:number):void
    draft: { paneId: Id; text: string; n: number; images?: import('../shared/chat').ChatImage[] } | null
    onDraftTaken(n: number): void
  }
  /** 변경 pane (23단계) */
  review: {
    request: { paneId: Id; req: ReviewRequest } | null
    toReview: { name: string; run(): void } | null
    onAskChat(text: string): void
    onInsertTerminal(command: string): void
    onToast(t: Omit<ToastSpec, 'id'>): void
    onRequestTaken(n: number): void
  }
}

const pct = (n: number) => `${n * 100}%`
const KEY_STEP = 0.05

/**
 * 탭 하나의 분할 화면. pane 은 paneId key 의 평평한 목록으로 절대 위치에 그린다(layoutRects 주석 참고).
 * 분할선을 끄는 동안의 비율은 이 화면 안에만 두고, 놓을 때 한 번 onRatio — 끄는 동안 저장을 프레임마다 보내지 않게.
 */
export function SplitView({ tab, panes, visible, focusSignal, term, activity, onActivity, onFocusPane, onRatio, onClosePane, onStartSent, onCommandDone, onCwd, onDragEnd, find, mask, onAllow, chat, review, remote }: Props) {
  const boxRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{ path: SplitPath; ratio: number } | null>(null)
  const dragging = useRef<{ divider: Divider; pointerId: number; el: HTMLElement } | null>(null)

  /** 끌기를 버리고 원래 비율로 (Esc · 브라우저가 취소 · 끄는 사이 pane 이 바뀜) */
  const cancelDrag = () => {
    const cur = dragging.current
    if (!cur) return
    dragging.current = null
    if (cur.el.hasPointerCapture(cur.pointerId)) cur.el.releasePointerCapture(cur.pointerId)
    setDrag(null)
    onDragEnd()
  }
  // 끄는 사이 셸이 끝나 pane 이 바뀌면 잡은 경로가 다른 분할을 가리킬 수 있다 → 끌기를 버린다
  useEffect(() => cancelDrag, [tab.layout]) // eslint-disable-line react-hooks/exhaustive-deps

  const layout = drag ? setRatioAt(tab.layout, drag.path, drag.ratio) : tab.layout
  const { panes: rects, dividers } = layoutRects(layout)
  const split = rects.length > 1

  const ratioAt = (d: Divider, e: PointerEvent) => {
    const box = boxRef.current!.getBoundingClientRect()
    return d.dir === 'right'
      ? ((e.clientX - box.left) / box.width - d.parent.x) / d.parent.w
      : ((e.clientY - box.top) / box.height - d.parent.y) / d.parent.h
  }

  const onPointerDown = (d: Divider) => (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    e.currentTarget.focus() // 끄는 중 Esc 로 취소할 수 있게
    dragging.current = { divider: d, pointerId: e.pointerId, el: e.currentTarget }
    setDrag({ path: d.path, ratio: d.at })
  }
  const onPointerMove = (e: PointerEvent) => {
    const cur = dragging.current
    if (!cur || cur.pointerId !== e.pointerId) return
    setDrag({ path: cur.divider.path, ratio: clampRatio(ratioAt(cur.divider, e)) })
  }
  const onPointerUp = (e: PointerEvent) => {
    const cur = dragging.current
    if (!cur || cur.pointerId !== e.pointerId) return
    dragging.current = null
    setDrag(null)
    onRatio(cur.divider.path, clampRatio(ratioAt(cur.divider, e)))
    onDragEnd()
  }
  const onPointerCancel = (e: PointerEvent) => {
    // 취소 이벤트의 좌표는 0 이거나 낡았다 — 저장하지 않고 원래 비율로
    if (dragging.current?.pointerId === e.pointerId) cancelDrag()
  }

  const onDividerKey = (d: Divider) => (e: KeyboardEvent<HTMLDivElement>) => {
    if (dragging.current) {
      // 끄는 중에는 Esc 만 받는다 — 화살표가 끄는 중의 비율로 한 번 더 저장하지 않게
      if (e.key === 'Escape') {
        e.preventDefault()
        cancelDrag()
      }
      return
    }
    const keys = d.dir === 'right' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown']
    const step = e.key === keys[0] ? -KEY_STEP : e.key === keys[1] ? KEY_STEP : 0
    if (!step) return
    e.preventDefault()
    onRatio(d.path, clampRatio(d.at + step))
  }

  return (
    <div className="split-view" ref={boxRef}>
      {rects.map((r) => {
        const pane = panes[r.paneId]
        const focused = r.paneId === tab.activePaneId
        return (
          <div
            key={r.paneId}
            // 분할일 때 포커스 아닌 pane 은 흐리게(어디에 칠지 보이게)
            className={`pane-slot${split && focused ? ' focused' : ''}${split && !focused ? ' dimmed' : ''}`}
            style={{ left: pct(r.x), top: pct(r.y), width: pct(r.w), height: pct(r.h) }}
            data-testid="pane-slot"
            data-pane-id={r.paneId}
            data-focused={focused}
            // 보이는 탭에서만 — 숨은 탭 안의 포커스가 활성 탭을 바꾸지 않게
            onFocus={() => visible && onFocusPane(r.paneId)}
          >
            {pane && !pane.kind && <PaneHead activity={activity[pane.id]} folder={shortPath(pane.cwd)} focused={split && focused} />}
            {pane?.kind === 'chat' && (
              <ChatPane
                paneId={pane.id}
                cwd={pane.cwd}
                chat={pane.chat ?? { agent: 'claude' }}
                workflowRunId={pane.workflowRunId}
                active={visible && focused}
                visible={visible}
                focusSignal={focusSignal}
                permission={pane.workflowRunId ? 'ask' : chat.permission}
                onPermission={chat.onPermission}
                onSession={(id) => chat.onSession(pane.id, id)}
                onToTerminal={() => chat.onToTerminal(pane.id)}
                onShell={() => chat.onShell(pane.id)}
                onOpenLogin={() => chat.onOpenLogin(pane.id)}
                onRewound={(forkAt, sid) => chat.onRewound(pane.id, forkAt, sid)}
                onBranch={(index, at) => chat.onBranch(pane.id, index, at)}
                onToast={chat.onToast}
                onActivity={(ev) => onActivity(pane.id, ev)}
                onOpenDiff={(path) => chat.onOpenDiff(pane.id, path)}
                onJumpTaken={chat.onJumpTaken}
                jump={chat.jump?.paneId===pane.id?chat.jump:null}
                draft={chat.draft?.paneId === pane.id ? chat.draft : null}
                onDraftTaken={chat.onDraftTaken}
              />
            )}
            {pane?.kind === 'review' && (
              <ReviewPane
                paneId={pane.id}
                dir={pane.cwd}
                active={visible && focused}
                visible={visible}
                focusSignal={focusSignal}
                request={review.request?.paneId === pane.id ? review.request.req : null}
                toReview={review.toReview}
                onAskChat={review.onAskChat}
                onInsertTerminal={review.onInsertTerminal}
                onToast={review.onToast}
                onRequestTaken={review.onRequestTaken}
              />
            )}
            {pane && !pane.kind && (
              <TerminalPane
                paneId={pane.id}
                cwd={pane.cwd}
                active={visible && focused}
                visible={visible}
                focusSignal={focusSignal}
                settings={term}
                onClosed={() => onClosePane(pane.id)}
                onActivity={(ev) => onActivity(pane.id, ev)}
                startCommand={pane.pendingCommand}
                startInsert={pane.pendingInsert}
                onStartSent={() => onStartSent(pane.id)}
                onCommandDone={(done) => onCommandDone(pane.id, done)}
                onCwd={(path) => onCwd(pane.id, path)}
                mask={mask}
                onAllow={(hit) => onAllow(pane.id, hit)}
                remote={remote ? { host: remote.host, tmux: remote.tmux } : undefined}
                onRemote={remote ? (st) => remote.onState(pane.id, st) : undefined}
                reconnectSignal={remote?.signal}
              />
            )}
            {pane && find.paneId === pane.id && <FindBar paneId={pane.id} signal={find.signal} {...(find.query !== undefined ? { initialQuery: find.query } : {})} onClose={find.onClose} shortcuts={find.shortcuts} />}
          </div>
        )
      })}
      {dividers.map((d) => {
        const vertical = d.dir === 'right'
        const pos = vertical
          ? { left: `calc(${pct(d.parent.x + d.parent.w * d.at)} - 3px)`, top: pct(d.parent.y), height: pct(d.parent.h) }
          : { top: `calc(${pct(d.parent.y + d.parent.h * d.at)} - 3px)`, left: pct(d.parent.x), width: pct(d.parent.w) }
        return (
          <div
            key={d.path.join('') || 'root'}
            role="separator"
            tabIndex={0}
            aria-orientation={vertical ? 'vertical' : 'horizontal'}
            aria-label={vertical ? '좌우 나눈 선' : '위아래 나눈 선'}
            aria-valuenow={Math.round(d.at * 100)}
            aria-valuemin={10}
            aria-valuemax={90}
            className={`divider ${vertical ? 'vertical' : 'horizontal'}`}
            style={pos}
            data-testid="divider"
            onPointerDown={onPointerDown(d)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            onKeyDown={onDividerKey(d)}
          />
        )
      })}
    </div>
  )
}
