import { useEffect, useState, type ReactNode } from 'react'
import type { RedactStatus } from '../../shared/ipc'
import { customPatternError, SECRET_TOGGLES } from '../../shared/redact'
import { MAX_SECRET_CUSTOM } from '../../shared/settings'
import type { Settings } from '../../shared/types'
import type { SettingsPatch } from '../store'
import { dateClock } from './BackupSection'

type RowComp = (p: { title: string; desc?: ReactNode; keywords?: string; control?: ReactNode; children?: ReactNode }) => ReactNode
type SwitchComp = (p: { label: string; checked: boolean; onChange(v: boolean): void }) => ReactNode

interface Props {
  s: Settings
  patch(p: SettingsPatch): void
  Row: RowComp
  Switch: SwitchComp
  onClearHistory(): void
}

/** 이미 남은 스크롤 파일 정리 상태 (main 이 알려 준다) */
function useRedactStatus(): RedactStatus | null {
  const [status, setStatus] = useState<RedactStatus | null>(null)
  useEffect(() => {
    let alive = true
    void window.taskminal.redact.status().then((s) => alive && setStatus(s))
    const off = window.taskminal.redact.onStatus(setStatus)
    return () => {
      alive = false
      off()
    }
  }, [])
  return status
}

/** 설정 › 개인정보 (17단계 Secrets) — 디스크 가리기는 늘 켜져 있고, 화면 가리기와 종류별 화면 표시만 고른다 */
export function PrivacySection({ s, patch, Row, Switch, onClearHistory }: Props) {
  const [name, setName] = useState('')
  const [pattern, setPattern] = useState('')
  const status = useRedactStatus()
  const patternError = pattern ? customPatternError(pattern) : null
  const nameTaken = s.secretCustom.some((c) => c.name.trim() === name.trim())
  const canAdd = name.trim() !== '' && pattern !== '' && !patternError && !nameTaken && s.secretCustom.length < MAX_SECRET_CUSTOM

  return (
    <>
      <Row
        title="화면에서 비밀값 가리기"
        desc="터미널에 찍힌 키 · 토큰을 회색 칸으로 덮어요. 누르면 그 칸만 보거나 원문을 복사할 수 있어요. 디스크(스크롤 저장 · 내보내기)에는 늘 가려서 써요 — 끌 수 없어요."
        keywords="비밀값 가리기 토큰 키 마스킹 secret mask 개인정보"
        control={<Switch label="화면에서 비밀값 가리기" checked={s.maskScreen} onChange={(v) => patch({ maskScreen: v })} />}
      />
      <Row title="종류별 화면 표시" desc="화면에서 가릴 종류. 디스크에는 모든 종류를 가려요." keywords="종류 anthropic openai github aws slack jwt 비밀번호">
        <ul className="secret-kinds" data-testid="secret-kinds">
          {SECRET_TOGGLES.map((t) => {
            const on = !s.maskKindsOff.includes(t.id)
            return (
              <li key={t.id}>
                <span className="secret-kind-name">{t.name}</span>
                <code className="muted">{t.example}</code>
                <button
                  type="button"
                  role="switch"
                  aria-checked={on}
                  aria-label={`${t.name} 화면에서 가리기`}
                  className={`pill-toggle${on ? ' on' : ''}`}
                  disabled={!s.maskScreen}
                  onClick={() => patch({ maskKindsOff: on ? [...s.maskKindsOff, t.id] : s.maskKindsOff.filter((x) => x !== t.id) })}
                >
                  {on ? '가려요' : '안 가려요'}
                </button>
              </li>
            )
          })}
        </ul>
      </Row>
      <Row title="내 종류" desc="회사 키처럼 목록에 없는 모양을 정규식으로 더해요. 화면과 디스크 모두 가려요." keywords="내 종류 정규식 regex custom">
        {s.secretCustom.length > 0 && (
          <ul className="manage-list">
            {s.secretCustom.map((c) => (
              <li key={c.name}>
                <span>{c.name}</span> <code className="muted">{c.pattern}</code>
                <button type="button" className="button" onClick={() => patch({ secretCustom: s.secretCustom.filter((x) => x !== c) })}>
                  지우기
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="secret-add">
          <input className="setting-input" aria-label="내 종류 이름" placeholder="이름 (예: ACME 키)" value={name} spellCheck={false} onChange={(e) => setName(e.target.value)} />
          <input
            className={`setting-input${patternError ? ' invalid' : ''}`}
            aria-label="내 종류 모양 (정규식)"
            aria-invalid={patternError !== null}
            placeholder="acme_[A-Za-z0-9]{32}"
            value={pattern}
            spellCheck={false}
            onChange={(e) => setPattern(e.target.value)}
          />
          <button
            type="button"
            className="button"
            disabled={!canAdd}
            onClick={() => {
              patch({ secretCustom: [...s.secretCustom, { name: name.trim(), pattern }] })
              setName('')
              setPattern('')
            }}
          >
            더하기
          </button>
        </div>
        {patternError && (
          <p className="err" data-testid="pattern-error">
            {patternError}. 더하기 전에 고쳐 주세요.
          </p>
        )}
        {!patternError && nameTaken && <p className="err">같은 이름이 이미 있어요</p>}
      </Row>
      <Row title="가리지 않기로 한 값" desc="가린 칸 메뉴에서 ‘비밀값 아님’ 을 고른 값이에요. 이 Mac 에서는 화면 · 디스크 모두 원문으로 남아요." keywords="가리지 않기 비밀값 아님 허용 allow">
        {s.secretAllow.length === 0 ? (
          <p className="muted">없어요</p>
        ) : (
          <ul className="manage-list" data-testid="secret-allow-list">
            {s.secretAllow.map((a) => (
              <li key={a.hash}>
                <span>{a.kind || '값'}</span> <span className="muted">{[a.where, a.at ? dateClock(a.at) : ''].filter(Boolean).join(' · ')}</span>
                <button type="button" className="button" onClick={() => patch({ secretAllow: s.secretAllow.filter((x) => x.hash !== a.hash) })}>
                  다시 가리기
                </button>
              </li>
            ))}
          </ul>
        )}
      </Row>
      <Row title="이미 남은 스크롤 파일" desc="업데이트 뒤 처음 열 때, 전에 저장한 스크롤 파일의 비밀값을 한 번 가려 다시 써요." keywords="정리 스크롤 파일 scrollback">
        {!status || status.state === 'idle' ? (
          <p className="muted">기다리는 중이에요</p>
        ) : status.state === 'running' ? (
          <p className="info" data-testid="redact-status">
            ↻ 이미 남은 스크롤 파일을 정리하는 중이에요 · {status.done}/{status.total}
          </p>
        ) : (
          <p className="ok" data-testid="redact-status">
            ✓ {status.total === 0 && status.masked === 0 ? '정리할 파일이 없었어요' : `스크롤 파일 ${status.total}개를 정리했어요 · 비밀값 ${status.masked}개 가림`}
            {status.finishedAt ? ` · ${dateClock(status.finishedAt)}` : ''}
          </p>
        )}
        {status?.failed.map((f) => (
          <div key={f} className="warn-row" data-testid="redact-failed">
            <span>! 파일 1개를 못 읽었어요({f}). 원문이 남아 있을 수 있어요.</span>
            <button type="button" className="button" onClick={() => window.taskminal.redact.fix('delete', f)}>
              이 파일 지우기
            </button>
            <button type="button" className="button" onClick={() => window.taskminal.redact.fix('retry', f)}>
              다시 시도
            </button>
          </div>
        ))}
      </Row>
      <Row title="명령 기록" desc="⌘Y 기록은 일감마다 최근 5,000개 · 90일까지, 비밀값을 가려 이 Mac 에만 남아요. 셸의 history 는 건드리지 않아요." keywords="history 기록 지우기">
        <button type="button" className="button danger" data-testid="history-clear" onClick={onClearHistory}>
          명령 기록 모두 지우기…
        </button>
      </Row>
      <Row title="되돌린 줄 보관" desc="변경 pane 에서 되돌린 줄 · 파일은 다시 살릴 수 있게 원문 그대로 7일 동안 이 Mac 에만 남아요(나만 읽는 파일). 지금 비우면 되살릴 수 없어요." keywords="되돌린 것 변경 revert 7일">
        <button
          type="button"
          className="button"
          data-testid="reverted-clear"
          onClick={() => {
            void window.taskminal.review.clearReverted()
          }}
        >
          되돌린 것 비우기
        </button>
      </Row>
    </>
  )
}
