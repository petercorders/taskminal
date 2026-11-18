import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { IssueLink } from '../shared/issues'
import { jiraDue } from '../shared/jira'
import { JiraHead, jiraCommentIntent, jiraConfirm, jiraListError, jiraListing, jiraLocked, jiraMenu, jiraResult, jiraTransitionIntent, jiraTransitionLabel, type JiraIntent } from '../shared/jira-head'
import { JIRA_COMMENT_MAX } from '../shared/jira-write'
import { ConfirmDialog } from './ConfirmDialog'
import { PopupMenu } from './PopupMenu'
import { loadIssueLinks } from './issue-links'
import { loadJiraToken, useJiraToken } from './jira-token'
import './jira.css'

// 64단계: 일감마다 하나 — 다른 일감에 갔다 와도(머리가 다시 그려져도) 보내는 중 · 결과 · 입력 중인 댓글이 남는다. 앱을 끄거나 새로 고치면 사라진다.
const heads = new Map<string, JiraHead>()
function headOf(taskId: string): JiraHead {
  let head = heads.get(taskId)
  if (!head) {
    head = new JiraHead(window.taskminal.jira, taskId, () => loadIssueLinks(window.taskminal.issues))
    heads.set(taskId, head)
  }
  return head
}

/**
 * 55단계 일감 머리 — 연결한 Jira 키 · 상태 · 마감(지났으면 빨강, 글자로도 '마감 지남'). 제목은 가린 글자로만 넣는다.
 * 64단계: 토큰이 있으면 '상태 바꾸기 ▾' · '댓글' — 둘 다 확인 뒤에만 보낸다. 판단(단추 막기 · 결과 글 · 떠 둔 키)은 shared/jira-head.
 */
export function JiraTaskHead({ link, active }: { link: IssueLink; active: boolean }) {
  const due = jiraDue(link.issue.due, new Date())
  const key = link.issue.key
  const head = headOf(link.taskId)
  const view = useSyncExternalStore(head.subscribe, () => head.view)
  const token = useJiraToken()
  useEffect(() => { loadJiraToken(window.taskminal.jira) }, [])
  // 확인 창을 연 순간 떠 둔 이슈 키 · 전환 · 글 · 요청 번호 — 그 사이 연결이 바뀌어도 이것으로만 보낸다
  const [confirming, setConfirming] = useState<JiraIntent | null>(null)
  useEffect(() => {
    // 다른 일감에 갔다 돌아옴 — 보내는 중이던 쓰기가 그 사이 끝났는지 다시 묻는다
    if (active) void head.resume()
    // 메뉴 · 확인 창은 body 에 그려 일감 화면과 함께 숨지 않는다 — 다른 일감으로 가면 닫는다(확인 창은 취소)
    else {
      if (head.view.menu || head.view.listing) head.closeMenu()
      setConfirming(null)
    }
  }, [active, head])
  const trigger = useRef<HTMLButtonElement>(null)
  const menuAt = useRef({ x: 0, y: 0 })
  // 보내는 중 · 됐는지 모르는 쓰기가 남았으면 새 쓰기를 막는다
  const sending = jiraLocked(view, key)
  const menu = jiraMenu(view, key)
  const listError = jiraListError(view, key)
  const result = jiraResult(view, key)
  const confirm = confirming && jiraConfirm(confirming)
  return (
    <>
      <div className="jira-head" role="group" aria-label="연결한 Jira 이슈" data-testid="jira-head">
        <button type="button" className="button jira-key" title={link.issue.url} onClick={() => window.taskminal.openLink(link.issue.url)}>{link.issue.key}</button>
        <span className="jira-title" title={link.issue.title}>{link.issue.title}</span>
        <span className="jira-state">{link.issue.state}</span>
        {due && <span className={`jira-due${due.overdue ? ' overdue' : ''}`} data-testid="jira-due">{due.text}</span>}
        {token && (
          <>
            <button
              ref={trigger}
              type="button"
              className="button jira-act"
              aria-haspopup="menu"
              aria-expanded={!!menu}
              disabled={sending}
              onClick={(event) => {
                const r = event.currentTarget.getBoundingClientRect()
                menuAt.current = { x: r.left, y: r.bottom + 2 }
                void head.openMenu(key)
              }}
            >
              {jiraListing(view, key) ? '읽는 중…' : '상태 바꾸기 ▾'}
            </button>
            <button type="button" className="button jira-act" aria-expanded={view.composing} disabled={sending} onClick={() => head.compose(!view.composing)}>댓글</button>
          </>
        )}
        {listError && <span className="jira-result" role="alert" data-testid="jira-list-error">{listError}</span>}
        {result && <span className="jira-result" role={result.tone} data-testid="jira-result">{result.text}</span>}
        {result?.actions.map((action) => (
          <button key={action.kind} type="button" className="button jira-act" onClick={() => void (action.kind === 'write' ? head.retry() : action.kind === 'dismiss' ? head.dismiss() : head.rereadState())}>{action.label}</button>
        ))}
      </div>
      {token && view.composing && (
        <div className="jira-compose" role="group" aria-label={`${key} 댓글`} data-testid="jira-compose">
          <textarea aria-label={`${key} 에 남길 댓글`} rows={3} maxLength={JIRA_COMMENT_MAX} autoFocus value={view.draft} disabled={sending} onChange={(event) => head.setDraft(event.target.value)} />
          <div className="jira-compose-actions">
            <button type="button" className="button jira-act" disabled={sending || !view.draft.trim()} onClick={() => setConfirming(jiraCommentIntent(crypto.randomUUID(), key, view.draft))}>댓글 남기기…</button>
            <button type="button" className="button jira-act" onClick={() => head.compose(false)}>닫기</button>
          </div>
        </div>
      )}
      {/* 메뉴는 창 좌표로 놓인다 — .task-view 는 container(inline-size)라 그 안의 fixed 가 창 기준이 아닐 수 있어, 다른 메뉴처럼 .task-view 밖(body)에 그린다 */}
      {active && menu && createPortal(
        <PopupMenu
          label={`${key} 상태 바꾸기`}
          heading={`${key} · ${link.issue.state}`}
          testId="jira-transitions"
          x={menuAt.current.x}
          y={menuAt.current.y}
          items={menu.length
            ? menu.map((t) => ({ label: jiraTransitionLabel(t), run: () => setConfirming(jiraTransitionIntent(crypto.randomUUID(), key, link.issue.state, t)) }))
            : [{ label: '지금 바꿀 수 있는 상태가 없어요', disabled: true, run: () => {} }]}
          onClose={(picked) => { head.closeMenu(); if (!picked) trigger.current?.focus() }}
        />,
        document.body,
      )}
      {/* 확인 창도 body 에 — .task-view(container) 안의 fixed 배경은 일감 영역만 덮어 사이드바가 눌린다 */}
      {active && confirming && confirm && createPortal(
        <div className="jira-confirm">
          <ConfirmDialog title={confirm.title} message={confirm.message} confirmLabel={confirm.confirmLabel} onConfirm={() => { setConfirming(null); void head.send(confirming) }} onCancel={() => setConfirming(null)} />
        </div>,
        document.body,
      )}
    </>
  )
}

/** 사이드바 둘째 줄 글 — 좁은 줄에서도 '마감 지남' 이 잘리지 않게 짧게(날짜는 title 로) */
export function jiraSidebarText(link: IssueLink | undefined, now: Date): { text: string; overdue: boolean; title: string } | null {
  if (!link || link.issue.provider !== 'jira') return null
  const due = jiraDue(link.issue.due, now)
  const short = !due ? '' : due.overdue ? '마감 지남' : due.text.startsWith('오늘') ? '오늘 마감' : `마감 ${link.issue.due!.slice(5).replace('-', '/')}`
  return { text: short ? `${link.issue.key} · ${short}` : link.issue.key, overdue: !!due?.overdue, title: due ? `${link.issue.key} · ${due.text}` : link.issue.key }
}
