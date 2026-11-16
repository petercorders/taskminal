import type { IssueLink } from '../shared/issues'
import { jiraDue } from '../shared/jira'
import './jira.css'

/** 55단계 일감 머리 — 연결한 Jira 키 · 상태 · 마감(지났으면 빨강, 글자로도 '마감 지남'). 제목은 가린 글자로만 넣는다 */
export function JiraTaskHead({ link }: { link: IssueLink }) {
  const due = jiraDue(link.issue.due, new Date())
  return (
    <div className="jira-head" role="group" aria-label="연결한 Jira 이슈" data-testid="jira-head">
      <button type="button" className="button jira-key" title={link.issue.url} onClick={() => window.taskminal.openLink(link.issue.url)}>{link.issue.key}</button>
      <span className="jira-title" title={link.issue.title}>{link.issue.title}</span>
      <span className="jira-state">{link.issue.state}</span>
      {due && <span className={`jira-due${due.overdue ? ' overdue' : ''}`} data-testid="jira-due">{due.text}</span>}
    </div>
  )
}

/** 사이드바 둘째 줄 글 — 좁은 줄에서도 '마감 지남' 이 잘리지 않게 짧게(날짜는 title 로) */
export function jiraSidebarText(link: IssueLink | undefined, now: Date): { text: string; overdue: boolean; title: string } | null {
  if (!link || link.issue.provider !== 'jira') return null
  const due = jiraDue(link.issue.due, now)
  const short = !due ? '' : due.overdue ? '마감 지남' : due.text.startsWith('오늘') ? '오늘 마감' : `마감 ${link.issue.due!.slice(5).replace('-', '/')}`
  return { text: short ? `${link.issue.key} · ${short}` : link.issue.key, overdue: !!due?.overdue, title: due ? `${link.issue.key} · ${due.text}` : link.issue.key }
}
