import { useEffect, useState, type ReactNode } from 'react'
import { copyText, type LogLevel, type LogRow } from '../../shared/errlog'
import type { Settings } from '../../shared/types'
import type { UpdateView } from '../../shared/update'
import type { SettingsPatch } from '../store'
import { updateStatusText } from '../update-ui'
import { dateClock } from './BackupSection'

type RowComp = (p: { title: string; desc?: ReactNode; keywords?: string; control?: ReactNode; children?: ReactNode }) => ReactNode
type SwitchComp = (p: { label: string; checked: boolean; onChange(v: boolean): void }) => ReactNode

interface Props {
  s: Settings
  patch(p: SettingsPatch): void
  Row: RowComp
  Switch: SwitchComp
  update: UpdateView | null
  /** 첫 실행 안내 다시 보기 */
  onFirstRun(): void
}

const FILTERS: Array<{ id: LogLevel | 'all'; label: string }> = [
  { id: 'error', label: '오류' },
  { id: 'warn', label: '경고' },
  { id: 'all', label: '모두' },
]

/** 설정 › 정보 (18단계): 버전 · 업데이트 · 첫 실행 안내 · 오류 기록 */
export function AboutSection({ s, patch, Row, Switch, update, onFirstRun }: Props) {
  const status = updateStatusText(update)
  const act = window.taskminal.update.action
  const busy = update?.state === 'checking' || update?.state === 'downloading' || update?.state === 'installing'
  const canCheck = update !== null && update.state !== 'disabled' && update.state !== 'blocked'
  const button =
    update?.state === 'failed' ? (
      <button type="button" className="button" onClick={() => act(update.during === 'install' ? 'install' : update.during === 'download' ? 'download' : 'check')}>
        다시 시도
      </button>
    ) : update?.state === 'available' ? (
      <button type="button" className="button primary" onClick={() => act('download')}>
        받기
      </button>
    ) : update?.state === 'downloaded' ? (
      <button type="button" className="button primary" onClick={() => act('install')}>
        다시 시작해서 설치
      </button>
    ) : canCheck ? (
      <button type="button" className="button" onClick={() => act('check')} disabled={busy}>
        지금 확인
      </button>
    ) : null

  return (
    <>
      <Row
        title="버전"
        keywords="업데이트 최신 확인"
        desc={
          <>
            <span data-testid="update-current">Taskminal {update?.current ?? ''}</span> ·{' '}
            <span className={`update-status ${status.tone}`} data-testid="update-status">
              {status.text}
            </span>
            {update?.checkedAt && update.state === 'latest' ? ` · ${dateClock(update.checkedAt)} 에 확인했어요` : ''}
          </>
        }
        control={button}
      />
      <Row title="업데이트 받기" desc="앱을 열 때 · 6시간마다 확인해요. 켜 두면 뒤에서 내려받아 두고 설치할지 물어요 (끄면 확인만)." keywords="업데이트 자동 내려받기" control={<Switch label="업데이트 받기" checked={s.updateDownload} onChange={(v) => patch({ updateDownload: v })} />} />
      {s.updateSkip && (
        <Row
          title="건너뛴 버전"
          desc={`${s.updateSkip} 은 다시 알리지 않아요. 다음 버전이 나오면 알려요.`}
          keywords="업데이트 건너뛰기"
          control={
            <button type="button" className="button" onClick={() => patch({ updateSkip: '' })}>
              다시 알리기
            </button>
          }
        />
      )}
      <Row
        title="첫 실행 안내"
        desc="일감 · Claude 알림 · 저장 위치를 세 장으로 다시 볼 수 있어요."
        keywords="처음 안내 도움말"
        control={
          <button type="button" className="button" onClick={onFirstRun}>
            다시 보기
          </button>
        }
      />
      <Row title="오류 기록" desc="최근 7일 · 이 Mac 에만 있어요. 밖으로 보내지 않고, 복사해서 붙일 때만 나가요." keywords="오류 로그 충돌 기록">
        <ErrorLogList />
      </Row>
    </>
  )
}

function ErrorLogList() {
  const [filter, setFilter] = useState<LogLevel | 'all'>('error')
  const [rows, setRows] = useState<LogRow[] | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    setRows(null)
    window.taskminal.errlog.list(filter === 'all' ? undefined : filter).then(
      (r) => alive && setRows(r),
      () => alive && setRows([]),
    )
    return () => {
      alive = false
    }
  }, [filter])

  const copy = (r: LogRow) => {
    const text = copyText(r) // 누르는 순간의 그 줄로
    void navigator.clipboard.writeText(text).then(() => setCopied(`${r.key}${r.t}`))
  }

  return (
    <div className="errlog" data-testid="errlog">
      <div className="errlog-filters" role="radiogroup" aria-label="오류 기록 거르기">
        {FILTERS.map((f) => (
          <button key={f.id} type="button" role="radio" aria-checked={filter === f.id} className={`chip${filter === f.id ? ' on' : ''}`} onClick={() => setFilter(f.id)}>
            {f.label}
          </button>
        ))}
      </div>
      {rows !== null && rows.length === 0 && (
        <div className="errlog-empty" data-testid="errlog-empty">
          <strong>{filter === 'warn' ? '최근 7일 동안 경고가 없어요' : '최근 7일 동안 오류가 없어요'}</strong>
          <span>앱이 갑자기 꺼지거나 셸을 띄우지 못하면 여기에 남아요. 터미널 출력은 남기지 않아요.</span>
          <button type="button" className="button" onClick={() => window.taskminal.errlog.openFolder()}>
            로그 폴더 열기
          </button>
        </div>
      )}
      {rows !== null && rows.length > 0 && (
        <ul className="errlog-list" aria-label="오류 기록">
          {rows.map((r) => (
            <li key={`${r.level}${r.key}${r.msg}`} className={`errlog-row ${r.level}`} data-testid="errlog-row">
              <span className="errlog-dot" aria-hidden />
              <span className="errlog-msg">
                <strong>
                  {r.msg}
                  {r.count > 1 ? ` ×${r.count}` : ''}
                </strong>
                {r.detail && <code>{r.detail}</code>}
              </span>
              <span className="errlog-when">{dateClock(r.t)}</span>
              <button type="button" className="button" onClick={() => copy(r)}>
                {copied === `${r.key}${r.t}` ? '복사함' : '복사'}
              </button>
            </li>
          ))}
        </ul>
      )}
      {rows !== null && rows.length > 0 && (
        <button type="button" className="link" onClick={() => window.taskminal.errlog.openFolder()}>
          로그 폴더 열기
        </button>
      )}
    </div>
  )
}
