import type { RemoteState } from '../shared/remote'

interface Props {
  host: string
  state: RemoteState
  /** 처음 보는 서버 — 맞아요(yes) · 취소(no) 를 그 pane 의 ssh 에 */
  onAnswer(yes: boolean): void
  /** 지금 다시 붙기 (⌘R) */
  onRetry(): void
  /** 키가 바뀜 — known_hosts 에서 옛 키를 지우는 명령을 복사 (앱은 known_hosts 를 쓰지 않는다) */
  onCopyFix(): void
}

/** 원격 일감 머리 띠 (25단계) — 처음 보는 서버 · 끊김 · 다시 붙지 못함 · 키 바뀜 · 인증 거절. 붙어 있으면 그리지 않는다 */
export function RemoteBand({ host, state, onAnswer, onRetry, onCopyFix }: Props) {
  if (state.kind === 'up' || (state.kind === 'connecting' && state.attempt === 0)) return null
  if (state.kind === 'connecting') {
    return (
      <div className="remote-band warn" role="status" data-testid="remote-band" data-kind="connecting">
        <span className="remote-band-text">
          ‹{host}› 에 다시 붙는 중… ({state.attempt}/5) · 끊긴 동안 친 키는 버려요
        </span>
      </div>
    )
  }
  const retry = (label: string) => (
    <button type="button" className="button small" onClick={onRetry} data-testid="remote-retry">
      {label} <kbd>⌘R</kbd>
    </button>
  )
  if (state.kind === 'new-host') {
    return (
      <div className="remote-band warn" role="alert" data-testid="remote-band" data-kind="new-host">
        <span className="remote-band-text">
          처음 보는 서버예요 · <b>{host}</b> {state.fingerprint && <code>{state.fingerprint}</code>} — 서버 관리자에게 받은 지문과 같을 때만 연결하세요
        </span>
        <button type="button" className="button primary small" onClick={() => onAnswer(true)} data-testid="remote-yes">
          맞아요, 연결
        </button>
        <button type="button" className="button small" onClick={() => onAnswer(false)} data-testid="remote-no">
          취소
        </button>
      </div>
    )
  }
  if (state.kind === 'retry') {
    return (
      <div className="remote-band warn" role="status" data-testid="remote-band" data-kind="retry">
        <span className="remote-band-text">
          ‹{host}› 와 연결이 끊겼어요 · {Math.ceil(state.inMs / 1000)}초 뒤 다시 붙어요 ({state.attempt}/5) · 끊긴 동안 친 키는 버려요
        </span>
        {retry('지금 다시')}
      </div>
    )
  }
  if (state.why === 'key-changed') {
    return (
      <div className="remote-band bad" role="alert" data-testid="remote-band" data-kind="key-changed">
        <span className="remote-band-text">
          서버 키가 바뀌었어요 · 연결하지 않았어요 — 서버를 다시 설치한 게 아니라면 누군가 가로채는 중일 수 있어요. 확인했으면 <code>ssh-keygen -R {host}</code> 뒤 다시
        </span>
        <button type="button" className="button small" onClick={onCopyFix} data-testid="remote-copy-fix">
          명령 복사
        </button>
        {retry('다시 시도')}
      </div>
    )
  }
  const text =
    state.why === 'auth'
      ? '연결하지 못했어요 · 키 인증이 거절됐어요 — ssh-agent 에 키가 있는지(ssh-add -l) 확인하세요'
      : state.why === 'refused'
        ? '서버를 확인하지 않아 연결하지 않았어요'
        : `‹${host}› 에 다시 붙지 못했어요 — 서버 · 네트워크를 확인하세요`
  return (
    <div className="remote-band bad" role="alert" data-testid="remote-band" data-kind={state.why}>
      <span className="remote-band-text">{text}</span>
      {retry('다시 시도')}
    </div>
  )
}
