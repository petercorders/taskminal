// 출시 기본기(18단계)의 화면 조각 — 업데이트 상태 구독 · 창 위 줄(받기 끝 · 설치 실패 · 디스크 이미지 · 지난번 꺼짐).
// 모양은 셸 지킴이 줄(host-banner)을 같이 쓴다.
import { useEffect, useState } from 'react'
import { releasePage, type UpdateView } from '../shared/update'

/** 업데이트 상태 — 처음 한 번 읽고, 바뀔 때마다 main 이 알린다. 처음 읽은 값이 이벤트보다 늦게 와도 덮지 않는다 */
export function useUpdateView(): UpdateView | null {
  const [view, setView] = useState<UpdateView | null>(null)
  useEffect(() => {
    let alive = true
    const off = window.taskminal.update.onView((v) => alive && setView(v))
    window.taskminal.update.view().then(
      (v) => alive && setView((cur) => cur ?? v),
      () => {},
    )
    return () => {
      alive = false
      off()
    }
  }, [])
  return view
}

export const mbOf = (bytes: number | undefined): string => `${Math.round((bytes ?? 0) / 1024 ** 2)}MB`

/** 옮기면 풀리는 자리 — 창 위 줄 · 설정 줄 제목 */
const BLOCKED_TITLE = {
  dmg: '디스크 이미지 안에서 실행 중이라 업데이트를 받을 수 없어요',
  translocated: '내려받은 자리에서 바로 열려 업데이트를 받을 수 없어요',
} as const

/** 설정 › 정보의 상태 줄 글 */
export function updateStatusText(v: UpdateView | null): { text: string; tone: 'ok' | 'run' | 'err' | 'dim' } {
  if (!v) return { text: '확인 중…', tone: 'dim' }
  switch (v.state) {
    case 'disabled':
      return { text: '이 빌드는 업데이트를 확인하지 않아요 (개발 실행 · 로컬 패키징)', tone: 'dim' }
    case 'blocked':
      return { text: v.blocked === 'readonly' ? '쓸 수 없는 폴더에 있어 업데이트를 받을 수 없어요' : BLOCKED_TITLE[v.blocked ?? 'dmg'], tone: 'err' }
    case 'idle':
      return { text: '아직 확인하지 않았어요', tone: 'dim' }
    case 'checking':
      return { text: '● 확인 중…', tone: 'run' }
    case 'latest':
      return { text: v.skipped ? `● 최신이에요 · ${v.skipped} 건너뜀` : '● 최신이에요', tone: 'ok' }
    case 'available':
      return { text: `● ${v.version} 이 나왔어요`, tone: 'run' }
    case 'downloading':
      return { text: `● 내려받는 중 ${v.percent ?? 0}%${v.total ? ` · ${mbOf(v.total)} 중 ${mbOf(v.transferred)}` : ''}`, tone: 'run' }
    case 'downloaded':
      return { text: `● ${v.version} 설치 가능`, tone: 'run' }
    case 'installing':
      return { text: '● 다시 시작하는 중…', tone: 'run' }
    case 'failed':
      return {
        text: `✕ ${v.during === 'check' ? '확인하지 못했어요' : v.during === 'download' ? '내려받지 못했어요' : '설치하지 못했어요'} · ${v.error ?? ''} · 6시간 뒤 다시 해요`,
        tone: 'err',
      }
  }
}

interface Banner {
  key: string
  tone: 'ok' | 'warn' | 'err' | 'info' | 'acc'
  title: string
  detail?: string
  actions: Array<{ label: string; run(): void; primary?: boolean }>
}

interface Props {
  view: UpdateView | null
  /** 지난번에 갑자기 꺼졌다 (appInfo.crashedLast) */
  crashed: boolean
  /** 받아 둔 버전 줄을 '다음에' 로 닫았다 — 사이드바 칩으로 남는다 */
  later: string | null
  onLater(version: string): void
  onSkip(version: string): void
  /** 설정 › 정보 › 오류 기록 */
  onOpenLog(): void
}

/** 창 맨 위의 업데이트 · 꺼짐 줄들. 닫은 줄은 이번 실행에서 다시 보이지 않는다 */
export function UpdateBanners({ view, crashed, later, onLater, onSkip, onOpenLog }: Props) {
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set())
  const close = (key: string) => setClosed((s) => new Set(s).add(key))
  const act = window.taskminal.update.action
  const banners: Banner[] = []

  if (crashed) {
    banners.push({
      key: 'crashed',
      tone: 'info',
      title: '지난번에 Taskminal 이 갑자기 꺼졌어요',
      detail: '셸은 지킴이 덕에 그대로예요. 무슨 일이 있었는지 오류 기록에서 볼 수 있어요.',
      actions: [
        {
          label: '오류 기록 보기',
          primary: true,
          run: () => {
            close('crashed')
            onOpenLog()
          },
        },
        { label: '닫기', run: () => close('crashed') },
      ],
    })
  }
  const v = view
  if (v && (v.state === 'downloaded' || v.state === 'installing') && v.version && later !== v.version) {
    const notes = [...(v.notes ?? []), ...(v.more ? [`외 ${v.more}개`] : [])]
    const version = v.version
    banners.push({
      key: `downloaded-${version}`,
      tone: 'acc',
      title: `Taskminal ${version} 을 내려받았어요`,
      detail: [notes.join(' · '), '다시 시작해도 셸은 그대로 이어져요(셸 지킴이).'].filter(Boolean).join(' — '),
      actions: [
        { label: v.state === 'installing' ? '다시 시작하는 중…' : '다시 시작해서 설치', primary: true, run: () => act('install') },
        { label: '바뀐 것 보기', run: () => window.taskminal.openLink(releasePage(version)) },
        { label: '이 버전 건너뛰기', run: () => onSkip(version) },
        { label: '다음에', run: () => onLater(version) },
      ],
    })
  }
  if (v?.state === 'failed' && v.during === 'install' && v.version) {
    banners.push({
      key: `install-failed-${v.version}`,
      tone: 'err',
      title: `${v.version} 을 설치하지 못했어요`,
      detail: `${v.error ? `${v.error} · ` : ''}지금 버전(${v.current})은 그대로예요.`,
      actions: [
        { label: '다시 시도', primary: true, run: () => act('install') },
        { label: '오류 기록 보기', run: onOpenLog },
      ],
    })
  }
  if (v?.state === 'blocked' && (v.blocked === 'dmg' || v.blocked === 'translocated')) {
    banners.push({
      key: 'blocked',
      tone: 'warn',
      title: BLOCKED_TITLE[v.blocked],
      detail: 'Taskminal 을 응용 프로그램 폴더로 옮기면 업데이트를 받을 수 있어요.',
      actions: [
        { label: '응용 프로그램 폴더로 옮기고 다시 열기', primary: true, run: () => act('move') },
        { label: '다음에', run: () => close('blocked') },
      ],
    })
  }

  const shown = banners.filter((b) => !closed.has(b.key))
  if (shown.length === 0) return null
  return (
    <div className="host-banners">
      {shown.map((b) => (
        <div key={b.key} className={`host-banner ${b.tone}`} role={b.tone === 'err' ? 'alert' : 'status'} data-testid={`update-banner-${b.key.replace(/-[\d.]+.*$/, '')}`}>
          <div className="host-banner-text">
            <strong>{b.title}</strong>
            {b.detail && <span>{b.detail}</span>}
          </div>
          <div className="host-banner-actions">
            {b.actions.map((a) => (
              <button key={a.label} type="button" className={`button${a.primary ? ' primary' : ''}`} onClick={a.run} disabled={a.label === '다시 시작하는 중…'}>
                {a.label}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
