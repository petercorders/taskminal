import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Modal } from './Modal'

// 첫 실행 안내(18단계, 보드 Release '첫 실행 안내') — 세 장. state.json 이 없을 때 한 번, 다시 보기는 설정 › 정보 · ⌘P.
export const CLAUDE_BELL_COMMAND = 'claude config set --global preferredNotifChannel terminal_bell'

interface Props {
  /** 홈 폴더 — 첫 장의 기본 폴더 */
  home: string
  /** 첫 장에서 고른 폴더로 첫 일감 만들기 */
  onCreate(cwd: string): void
  /** 끝냄 · 건너뜀 (Esc) */
  onDone(): void
  /** 다시 보기(설정 › 정보 · ⌘P) — 첫 장에서 일감을 만들지 않는다 */
  again?: boolean
}

const shortHome = (path: string, home: string) => (home && path.startsWith(home) ? `~${path.slice(home.length)}` : path)

export function FirstRun({ home, onCreate, onDone, again = false }: Props) {
  const [page, setPage] = useState(0)
  const [folder, setFolder] = useState(home || '~')
  const [copied, setCopied] = useState(false)
  const [picking, setPicking] = useState(false)
  const alive = useRef(true)
  const primaryRef = useRef<HTMLButtonElement>(null)
  useEffect(
    () => () => {
      alive.current = false
    },
    [],
  )
  useEffect(() => primaryRef.current?.focus(), [page])

  const pick = () => {
    if (picking) return
    setPicking(true)
    void window.taskminal.pickFolder().then(
      (p) => {
        // 고르는 사이 안내를 닫았으면(Esc) 결과는 버린다
        if (!alive.current) return
        setPicking(false)
        if (p) setFolder(p)
      },
      () => alive.current && setPicking(false),
    )
  }
  const copy = () => {
    void navigator.clipboard.writeText(CLAUDE_BELL_COMMAND).then(() => alive.current && setCopied(true))
    // 복사 버튼을 눌러도 ↩ 는 '다음' — 포커스를 기본 버튼으로 돌린다
    primaryRef.current?.focus()
  }
  const next = () => {
    if (page === 0 && !again) onCreate(folder)
    if (page === 2) return onDone()
    setPage((p) => p + 1)
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'c' && e.metaKey && page === 1 && !window.getSelection()?.toString()) {
      e.preventDefault()
      copy()
    }
  }

  return (
    <Modal role="dialog" labelledBy="first-run-title" className="first-run" onCancel={onDone}>
      <div onKeyDown={onKey} data-testid="first-run" data-page={page + 1}>
        <div className="first-run-steps" aria-label={`${page + 1} / 3`}>
          {[0, 1, 2].map((i) => (
            <span key={i} className={`first-run-step${i === page ? ' on' : ''}`} aria-hidden />
          ))}
          <span className="first-run-count">{page + 1} / 3</span>
        </div>
        {page === 0 && again && (
          <>
            <h2 id="first-run-title">일감 하나 = 폴더 하나 + 대화 · 셸</h2>
            <p>
              일감은 Claude 대화로 시작하고, 셸이 필요하면 ⌘J 로 대화 아래에 꺼내요. 껐다 켜도 그대로예요.
              <br />새 일감은 ⌘N · 사이드바의 + 로 만들어요.
            </p>
          </>
        )}
        {page === 0 && !again && (
          <>
            <h2 id="first-run-title">일감 하나 = 폴더 하나 + 대화 · 셸</h2>
            <p>일감은 Claude 대화로 시작하고, 셸이 필요하면 ⌘J 로 대화 아래에 꺼내요. 껐다 켜도 그대로예요.
              <br />
              어디서 시작할까요?
            </p>
            <div className="first-run-options" role="radiogroup" aria-label="첫 일감 폴더">
              <button type="button" role="radio" aria-checked className="first-run-option selected">
                <strong>{shortHome(folder, home)}</strong>
                <span>{folder === home ? '홈 폴더예요' : '고른 폴더예요'}</span>
              </button>
              <button type="button" className="first-run-option" onClick={pick} disabled={picking}>
                <strong>다른 폴더 고르기…</strong>
              </button>
            </div>
          </>
        )}
        {page === 1 && (
          <>
            <h2 id="first-run-title">Claude 가 답을 기다릴 때 알려 드려요</h2>
            <p>
              아래 명령을 터미널에 붙여 넣으면, 답을 기다릴 때 사이드바의 &quot;확인 필요&quot; 칸에 노란 점(●)이 떠요.
              <br />
              앱이 Claude 설정 파일을 직접 고치지는 않아요.
            </p>
            <div className="first-run-code">
              <code data-testid="first-run-command">{CLAUDE_BELL_COMMAND}</code>
              <button type="button" className="button" onClick={copy}>
                {copied ? '복사함' : '명령 복사 ⌘C'}
              </button>
            </div>
          </>
        )}
        {page === 2 && (
          <>
            <h2 id="first-run-title">일감과 설정은 이 Mac 에 저장돼요</h2>
            <p>
              ~/Library/Application Support/Taskminal
              <br />
              바뀐 게 있으면 자동으로 백업해요(설정 › 백업 · 되돌리기). 밖으로 보내지 않아요.
            </p>
          </>
        )}
        <div className="dialog-actions">
          <button type="button" className="button" onClick={onDone}>
            {page === 2 ? '닫기' : '건너뛰기'} <kbd>Esc</kbd>
          </button>
          <button ref={primaryRef} type="button" className="button primary" onClick={next}>
            {page === 0 && !again ? '이 폴더로 첫 일감 만들기' : page === 2 ? '시작하기' : '다음'} <kbd>↩</kbd>
          </button>
        </div>
      </div>
    </Modal>
  )
}
