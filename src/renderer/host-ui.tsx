// 셸 지킴이(16단계)의 화면 조각 — 상태 구독 훅과 창 위 줄(배너).
import { useEffect, useState } from 'react'
import type { HostAction, HostView } from '../shared/ipc'
import { formatDuration } from '../shared/activity'

/** 지킴이 상태 — 처음 한 번 읽고, 바뀔 때마다 main 이 알린다 */
export function useHostView(): HostView | null {
  const [view, setView] = useState<HostView | null>(null)
  useEffect(() => {
    let alive = true
    const off = window.taskminal.host.onView((v) => alive && setView(v))
    window.taskminal.host.view().then(
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

export const mb = (bytes: number): string => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)}GB` : `${Math.round(bytes / 1024 ** 2)}MB`)

/** 앱이 처음 읽힐 때 한 번 정하는 줄 — 이어진 셸 · 꺼져 있던 동안의 기다림 · 새로 띄움 */
export interface StartupNotes {
  resumed: number
  awayMs: number
  waiting: Array<{ label: string; message?: string }>
  fresh: boolean
}

interface Banner {
  key: string
  tone: 'ok' | 'warn' | 'err' | 'info'
  title: string
  detail?: string
  actions: Array<{ label: string; run(): void; primary?: boolean }>
}

interface Props {
  view: HostView | null
  startup: StartupNotes | null
  /** 설정 › 셸 지킴이 열기 */
  onOpenSettings(): void
  /** 다음 확인 필요로 (⇧⌘A) */
  onNextAttention(): void
  /** 확인이 필요한 일 — 지킴이 다시 시작 · 옛 지킴이 바꾸기 */
  onConfirm(action: 'restart' | 'replace-old'): void
}

/** 창 맨 위의 셸 지킴이 줄들. 닫은 줄은 이번 실행에서 다시 보이지 않는다(연결 상태 줄은 상태가 바뀌면 다시) */
export function HostBanners({ view, startup, onOpenSettings, onNextAttention, onConfirm }: Props) {
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set())
  const close = (key: string) => setClosed((s) => new Set(s).add(key))
  const act = (a: HostAction) => window.taskminal.host.action(a)
  const banners: Banner[] = []

  if (view?.state === 'reconnecting') {
    banners.push({
      key: `reconnecting`,
      tone: 'err',
      title: `셸 지킴이와 연결이 끊겼어요 · 다시 연결 중 ${view.attempt ?? 1}/${view.of ?? 5}`,
      detail: '입력은 연결될 때까지 막아 둬요.',
      actions: [],
    })
  }
  if (view?.state === 'down') {
    banners.push({
      key: 'down',
      tone: 'err',
      title: '셸 지킴이에 연결하지 못했어요',
      detail: '셸은 아직 돌고 있을 수 있어요. 다시 연결해 보고, 안 되면 지킴이를 다시 시작해요(셸이 끝나요).',
      actions: [
        { label: '다시 연결', run: () => act('reconnect'), primary: true },
        { label: '지킴이 다시 시작…', run: () => onConfirm('restart') },
        { label: '오류 기록 보기', run: () => act('open-log') },
      ],
    })
  }
  if (startup && startup.waiting.length > 0) {
    const first = startup.waiting[0]!
    banners.push({
      key: 'waiting',
      tone: 'warn',
      title: `꺼져 있던 동안 ${startup.waiting.length}개가 입력을 기다려요`,
      detail: [first.label, first.message ? `“${first.message}”` : ''].filter(Boolean).join(' — '),
      actions: [
        {
          label: '보러 가기 ⇧⌘A',
          run: () => {
            close('waiting')
            onNextAttention()
          },
          primary: true,
        },
        { label: '다음에', run: () => close('waiting') },
      ],
    })
  }
  if (startup && startup.resumed > 0) {
    banners.push({
      key: 'resumed',
      tone: 'ok',
      title: `셸 ${startup.resumed}개가 그대로 이어졌어요`,
      ...(startup.awayMs >= 1000 ? { detail: `꺼져 있던 ${formatDuration(startup.awayMs)} 동안의 출력도 받아 왔어요.` } : {}),
      actions: [
        { label: '닫기', run: () => close('resumed') },
        { label: '셸 지킴이 보기', run: onOpenSettings },
      ],
    })
  }
  if (startup?.fresh) {
    banners.push({
      key: 'fresh',
      tone: 'info',
      title: '셸을 새로 띄웠어요',
      detail: '폴더와 이전 출력은 되살렸지만 돌던 명령은 끝났어요. 시작 명령은 다시 돌리지 않았어요.',
      actions: [{ label: '닫기', run: () => close('fresh') }],
    })
  }
  if (view?.oldHost) {
    banners.push({
      key: 'old-host',
      tone: 'warn',
      title: '새 버전과 맞지 않는 지킴이예요',
      detail: `셸 ${view.oldHost.sessions}개가 끝나면 저절로 사라져요. 지금 바꾸면 그 셸들이 끝나요.`,
      actions: [
        { label: '나중에', run: () => close('old-host') },
        { label: '지금 바꾸기…', run: () => onConfirm('replace-old') },
      ],
    })
  }
  if (view?.memoryWarning) {
    banners.push({
      key: 'memory',
      tone: 'warn',
      title: `셸 지킴이가 메모리 ${mb(view.rss ?? 0)} 를 쓰고 있어요`,
      detail: `셸 ${view.sessions ?? 0}개가 돌고 있어요. 주인 없는 셸이나 오래 조용한 셸을 끄면 줄어요.`,
      actions: [
        {
          label: '목록 보고 끄기',
          run: () => {
            close('memory')
            onOpenSettings()
          },
          primary: true,
        },
        { label: '다음에', run: () => close('memory') },
      ],
    })
  }

  const shown = banners.filter((b) => !closed.has(b.key))
  if (shown.length === 0) return null
  return (
    <div className="host-banners">
      {shown.map((b) => (
        <div key={b.key} className={`host-banner ${b.tone}`} role={b.tone === 'err' ? 'alert' : 'status'} data-testid={`host-banner-${b.key}`}>
          <div className="host-banner-text">
            <strong>{b.title}</strong>
            {b.detail && <span>{b.detail}</span>}
          </div>
          <div className="host-banner-actions">
            {b.actions.map((a) => (
              <button key={a.label} type="button" className={`button${a.primary ? ' primary' : ''}`} onClick={a.run}>
                {a.label}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
