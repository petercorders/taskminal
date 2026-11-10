// 설정 › 셸 지킴이 (16단계) — 앱 밖에서 셸을 갖고 있는 프로세스의 상태 · 주인 없는 셸 · 다시 시작.
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { formatDuration } from '../../shared/activity'
import { PTYHOST_PROTOCOL, orphanSessions, type SessionInfo } from '../../shared/ptyhost'
import type { AppState } from '../../shared/types'
import { mb, useHostView } from '../host-ui'

type RowLike = (p: { title: string; desc?: ReactNode; keywords?: string; control?: ReactNode; children?: ReactNode }) => ReactNode

interface Props {
  state: AppState
  /** 실행 중인 명령 수 — 다시 시작 확인에 */
  busy: number
  Row: RowLike
}

export function HostSection({ state, busy, Row }: Props) {
  const view = useHostView()
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null)
  const [tails, setTails] = useState<Record<string, string>>({})
  // 끝내기 확인: 셸 하나(paneId) · 모두('all') · 지킴이 다시 시작('restart')
  const [asking, setAsking] = useState<string | null>(null)

  const refresh = useCallback(() => {
    void window.taskminal.host.sessions().then(setSessions, () => setSessions([]))
  }, [])
  useEffect(refresh, [refresh, view?.pid])

  const statePanes = state.tasks.flatMap((t) => Object.keys(t.panes))
  const live = sessions?.filter((s) => !s.exited) ?? []
  const orphans = sessions ? orphanSessions(sessions, statePanes) : []

  const kill = (paneIds: string[]) => {
    window.taskminal.host.kill(paneIds)
    setAsking(null)
    setTimeout(refresh, 300)
  }
  const showTail = (paneId: string) => {
    if (tails[paneId] !== undefined) return setTails(({ [paneId]: _, ...rest }) => rest)
    void window.taskminal.host.tail(paneId).then((text) => setTails((t) => ({ ...t, [paneId]: text })))
  }

  const connected = view?.state === 'connected'
  const status = !view
    ? '확인 중…'
    : connected
      ? `● 실행 중${view.startedAt ? ` · ${formatDuration(Date.now() - view.startedAt)}` : ''}`
      : view.state === 'reconnecting'
        ? `다시 연결 중 ${view.attempt ?? 1}/${view.of ?? 5}`
        : view.state === 'down'
          ? '✕ 연결 안 됨'
          : '시작하는 중…'

  return (
    <>
      <Row
        title="셸 지킴이"
        desc="앱을 꺼도 셸이 계속 돌게 하는, 앱 밖의 작은 프로세스예요. 다시 열면 그대로 이어져요."
        keywords="지킴이 상태 실행 연결 ptyhost"
        control={
          <span className={`host-status ${connected ? 'ok' : 'err'}`} data-testid="host-status">
            {status}
          </span>
        }
      />
      <Row
        title="셸"
        desc={`${live.length}개${view?.rss ? ` · 메모리 ${mb(view.rss)}` : ''} — 1GB 를 넘거나 100개가 넘으면 알려 드려요`}
        keywords="셸 메모리 개수"
      />
      <Row title="앱을 끝낼 때" desc="⌘Q 는 앱만 꺼요(셸은 계속 돌아요) · ⌥⌘Q 는 셸까지 모두 끝내요" keywords="끝내기 종료 quit" />
      <Row
        title="버전"
        desc={view?.version !== undefined && view.version !== PTYHOST_PROTOCOL ? `지킴이 v${view.version} · 앱은 v${PTYHOST_PROTOCOL} — 셸이 모두 끝나면 새 버전으로 바뀌어요` : `v${PTYHOST_PROTOCOL}`}
        keywords="버전"
      />
      <Row title="자세히" desc={`소켓 ${view?.sockPath ?? '-'} · 프로세스 ${view?.pid ?? '-'}`} keywords="소켓 프로세스 pid" />
      <Row
        title={`주인 없는 셸 ${orphans.length}`}
        desc="저장된 일감에 없는 셸이에요. 자동으로 끄지 않아요."
        keywords="주인 없는 고아 orphan 정리"
        control={
          orphans.length > 0 && (
            <button type="button" className="button danger" onClick={() => setAsking('all')}>
              모두 끝내기 ({orphans.length})
            </button>
          )
        }
      >
        {asking === 'all' && (
          <Confirm text={`주인 없는 셸 ${orphans.length}개를 끝낼까요?`} yes="모두 끝내기" onYes={() => kill(orphans.map((o) => o.paneId))} onNo={() => setAsking(null)} />
        )}
        <ul className="host-orphans" data-testid="host-orphans">
          {orphans.map((o) => (
            <li key={o.paneId} className="host-orphan" data-testid={`orphan-${o.paneId}`}>
              <div className="host-orphan-row">
                <span className="host-orphan-name">{o.paneId}</span>
                <span className="host-orphan-cmd">{o.command ?? '셸'}</span>
                <span className="host-orphan-age">{o.exited ? `끝남 (exit ${o.exited.exitCode})` : `주인 없음 · ${formatDuration(o.detachedMs)}째`}</span>
                <button type="button" className="button" onClick={() => showTail(o.paneId)} aria-expanded={tails[o.paneId] !== undefined}>
                  마지막 출력 보기
                </button>
                <button type="button" className="button" onClick={() => setAsking(o.paneId)}>
                  끝내기
                </button>
              </div>
              {asking === o.paneId && <Confirm text="이 셸을 끝낼까요?" yes="끝내기" onYes={() => kill([o.paneId])} onNo={() => setAsking(null)} />}
              {tails[o.paneId] !== undefined && (
                <pre className="host-tail" data-testid={`tail-${o.paneId}`}>
                  {tails[o.paneId] || '(출력 없음)'}
                </pre>
              )}
            </li>
          ))}
        </ul>
      </Row>
      <Row
        title="지킴이 다시 시작"
        desc="셸이 모두 끝나요. 폴더와 출력만 되살아나요."
        keywords="다시 시작 재시작 restart 오류 기록"
        control={
          <span className="setting-controls">
            <button type="button" className="button" onClick={() => window.taskminal.host.action('open-log')}>
              오류 기록 보기
            </button>
            <button type="button" className="button danger" onClick={() => setAsking('restart')}>
              다시 시작…
            </button>
          </span>
        }
      >
        {asking === 'restart' && (
          <Confirm
            text={`셸 ${live.length}개가 모두 끝나요${busy > 0 ? ` — 지금 실행 중인 명령 ${busy}개도` : ''}. 폴더와 출력만 되살아나요.`}
            yes="다시 시작"
            onYes={() => {
              setAsking(null)
              window.taskminal.host.action('restart')
            }}
            onNo={() => setAsking(null)}
          />
        )}
      </Row>
    </>
  )
}

/** 줄 안의 확인 — 기본 포커스는 '닫기'(안전한 쪽) */
function Confirm({ text, yes, onYes, onNo }: { text: string; yes: string; onYes(): void; onNo(): void }) {
  return (
    <div className="host-confirm" role="alertdialog" aria-label={text}>
      <span>{text}</span>
      <button type="button" className="button" autoFocus onClick={onNo}>
        닫기
      </button>
      <button type="button" className="button danger" onClick={onYes}>
        {yes}
      </button>
    </div>
  )
}
