import { useEffect, useRef, useState, type Dispatch, type KeyboardEvent, type ReactNode } from 'react'
import { accelFromEvent, accelLabel, FONT_MAX, FONT_MIN, keyConflicts, type AppCommand, type Shortcut } from '../../shared/keymap'
import { ACCENTS, DIM, FONT_FAMILIES, LINE_HEIGHT, LONG_AFTER_CHOICES, NOTIFY_KINDS, RESUME_AFTER_CHOICES, SCROLLBACK } from '../../shared/settings'
import type { AppState, NotifyKind } from '../../shared/types'
import type { Action, SettingsPatch } from '../store'
import { fontStack } from '../term-settings'
import { TemplateEditor } from './TemplateEditor'
import { HostSection } from './HostSection'
import { BackupSection } from './BackupSection'
import { PrivacySection } from './PrivacySection'
import { AboutSection } from './AboutSection'
import { Choices, Group, QueryContext, Row, RowCountProvider, Section, Switch, TextField, useRowCount } from './parts'
import { Icon, type IconName } from '../icons'
import type { UpdateView } from '../../shared/update'
import type { Restored } from '../../shared/backup'
import type { BackupMark } from '../../shared/ipc'

type SectionId = 'general' | 'look' | 'term' | 'host' | 'notify' | 'privacy' | 'backup' | 'keys' | 'tasks' | 'about'
/** ⌘P 로 바로 여는 칸 */
export type SettingsJump = 'host' | 'backup' | 'privacy' | 'about'
// 28단계(Orca 설정 왼쪽): 칸을 묶음 제목 아래 두고, 칸마다 아이콘 · 한 줄 설명(칸 머리)을 둔다
const SECTIONS: Array<{ id: SectionId; title: string; icon: IconName; desc: string }> = [
  { id: 'general', title: '일반', icon: 'sliders', desc: '앱을 열 때와 새 일감의 기본값' },
  { id: 'tasks', title: '일감 관리', icon: 'list', desc: '상태 · 묶음 · 템플릿' },
  { id: 'look', title: '모양', icon: 'palette', desc: '테마 · 강조색 · 터미널 글자' },
  { id: 'term', title: '터미널', icon: 'terminal', desc: '셸 · 스크롤 · 커서 · 입력' },
  { id: 'keys', title: '단축키', icon: 'keyboard', desc: '⌘ 와 함께 누르는 키' },
  { id: 'notify', title: '알림 · 활동', icon: 'bell', desc: '언제 macOS 알림 · 소리로 알릴지' },
  { id: 'host', title: '셸 지킴이', icon: 'shield', desc: '앱을 꺼도 셸이 계속 돌게 하는 프로세스' },
  { id: 'privacy', title: '개인정보', icon: 'lock', desc: '비밀값 가리기 · 이 Mac 에 남는 기록' },
  { id: 'backup', title: '백업 · 되돌리기', icon: 'restore', desc: '상태 백업 · 되돌리기 · 옮기기' },
  { id: 'about', title: '정보', icon: 'info', desc: '버전 · 업데이트 · 오류 기록' },
]
const NAV_GROUPS: Array<{ title: string; ids: SectionId[] }> = [
  { title: '기본', ids: ['general', 'tasks'] },
  { title: '화면', ids: ['look', 'term', 'keys'] },
  { title: '알림 · 실행', ids: ['notify', 'host'] },
  { title: '데이터', ids: ['privacy', 'backup'] },
  { title: '앱', ids: ['about'] },
]

interface Props {
  state: AppState
  /** 바꾼 단축키가 반영된 표 */
  shortcuts: readonly Shortcut[]
  dispatch: Dispatch<Action>
  newId(): string
  /** 열 때 보일 칸 (⌘P '셸 지킴이 보기' · '백업에서 되돌리기…') */
  initialSection?: SettingsJump | undefined
  /** 백업 · 가져오기로 상태를 바꾼다 (17단계) — 실패 글 · 성공이면 null */
  onRestore(make: (cur: AppState) => Restored | null, mark: BackupMark): Promise<string | null>
  /** 실행 중인 명령 수 — 셸 지킴이 다시 시작 확인 */
  busy?: number
  /** 업데이트 상태 (18단계 — 설정 › 정보) */
  update?: UpdateView | null
  /** 첫 실행 안내 다시 보기 */
  onFirstRun?(): void
  /** 명령 기록 모두 지우기 (19단계) — App 이 확인을 묻는다 */
  onClearHistory?(): void
  onClose(): void
}

// 단축키 칸에서 바꿀 수 있는 명령 (탭 번호 ⌘1~9 는 고정)
const KEY_GROUPS: Array<{ title: string; commands: AppCommand[] }> = [
  { title: '일감', commands: ['new-task', 'palette', 'next-task', 'prev-task', 'status-next', 'status-prev', 'next-attention', 'settings'] },
  { title: '탭 · 분할', commands: ['new-tab', 'split-right', 'split-down', 'close-pane', 'next-tab', 'prev-tab', 'next-pane', 'prev-pane'] },
  { title: '터미널', commands: ['clear', 'font-bigger', 'font-smaller', 'font-reset'] },
]

const NOTIFY_ROWS: Record<NotifyKind, { title: string; desc: string }> = {
  wait: { title: '입력을 기다릴 때', desc: 'Claude 가 질문 · 권한을 물을 때, 벨 · 알림 신호' },
  long: { title: '오래 걸린 명령이 끝났을 때', desc: '아래 기준 시간보다 오래 걸린 명령' },
  fail: { title: '명령이 실패했을 때', desc: 'exit 코드가 0 이 아닐 때' },
  exit: { title: '셸이 닫혔을 때', desc: 'exit · 프로세스 종료로 pane 이 닫힘' },
}

/** 설정 창(⌘,) — 앱 안의 화면. 바꾸면 바로 상태에 반영되고 4단계의 자동 저장으로 저장된다. Esc 로 돌아간다. */
/** 편집기를 새 템플릿으로 연다 — 템플릿 id 와 겹치지 않는 값 */
const NEW_TEMPLATE = '\u0000new'

export function SettingsView({ state, shortcuts, dispatch, newId, initialSection, busy = 0, update = null, onFirstRun = () => {}, onClearHistory = () => {}, onClose, onRestore }: Props) {
  const s = state.settings
  const [section, setSection] = useState<SectionId>(initialSection ?? 'general')
  // JSON 편집기: 템플릿 id · 'new'(새 템플릿)
  const [editingTemplate, setEditingTemplate] = useState<string | null>(null)
  const editedTemplate = s.templates.find((t) => t.id === editingTemplate) ?? null
  // 고치던 템플릿이 그 사이 사라졌으면 편집기를 닫는다 — '새 템플릿' 으로 바뀌어 사본을 만들지 않게
  const editorOpen = editingTemplate === NEW_TEMPLATE || editedTemplate !== null
  const [query, setQuery] = useState('')
  const [capturing, setCapturing] = useState<AppCommand | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  // 찾기 결과가 하나도 없으면 안내 — 줄이 그려지고 빠질 때마다 알려 오는 보이는 줄 수로 정한다(28c 리뷰: DOM 을 한 번 세면 늦게 바뀌는 줄에 낡는다)
  const [rowCount, reportRow] = useRowCount()
  const noMatch = query.trim() !== '' && rowCount === 0
  const conflicts = keyConflicts(shortcuts)
  // main 이 받아 주는 셸(/etc/shells) — 그 밖의 경로는 $SHELL 로 열리므로 칸 아래에 알린다
  const [shells, setShells] = useState<string[] | null>(null)
  useEffect(() => {
    let alive = true
    void window.taskminal.appInfo().then((info) => alive && setShells(info.shells))
    return () => {
      alive = false
    }
  }, [])
  const shellRejected = s.shell !== null && shells !== null && !shells.includes(s.shell)

  useEffect(() => searchRef.current?.focus(), [])

  const patch = (p: SettingsPatch) => dispatch({ type: 'settings/patch', patch: p })
  const setNotify = (kind: NotifyKind, way: 'banner' | 'sound', on: boolean) => patch({ notify: { ...s.notify, [kind]: { ...s.notify[kind], [way]: on } } })
  const setKey = (command: AppCommand, accel: string) => patch({ keys: { ...s.keys, [command]: accel } })
  const countBy = (pred: (statusOrGroup: string | null) => boolean, field: 'statusId' | 'groupId') => state.tasks.filter((t) => pred(t[field])).length

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !capturing) {
      e.preventDefault()
      onClose()
    }
  }

  const onCaptureKey = (command: AppCommand) => (e: KeyboardEvent) => {
    if (capturing !== command) return
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') return setCapturing(null) // 취소 — 원래 키
    if (e.key === 'Backspace' || e.key === 'Delete') {
      setKey(command, '') // 키 없음 — 터미널 프로그램에 넘긴다
      return setCapturing(null)
    }
    const accel = accelFromEvent(e.nativeEvent)
    if (!accel) return // ⌘ 없는 키 · 꾸밈키만 → 계속 기다린다
    setKey(command, accel)
    setCapturing(null)
  }

  const show = (id: SectionId) => (query ? true : section === id)
  const current = SECTIONS.find((x) => x.id === section)!

  const body: Record<SectionId, ReactNode> = {
    host: (
      <Group>
        <HostSection state={state} busy={busy} Row={Row} />
      </Group>
    ),
    privacy: (
      <Group>
        <PrivacySection s={s} patch={patch} Row={Row} Switch={Switch} onClearHistory={onClearHistory} />
      </Group>
    ),
    backup: (
      <Group>
        <BackupSection state={state} Row={Row} newId={newId} onRestore={onRestore} />
      </Group>
    ),
    about: (
      <Group>
        <AboutSection s={s} patch={patch} Row={Row} Switch={Switch} update={update} onFirstRun={onFirstRun} />
      </Group>
    ),
    general: (
      <>
        <Group title="시작">
        <Row title="앱을 열 때" keywords="시작 되살리기 목록 빈 창">
          <Choices
            kind="card"
            label="앱을 열 때"
            value={s.startup}
            onChange={(v) => patch({ startup: v })}
            options={[
              { value: 'restore', title: '마지막 상태 되살리기', desc: '일감 · 탭 · 분할 · 폴더' },
              { value: 'list', title: '일감 목록만', desc: '터미널은 일감을 열 때 시작' },
              { value: 'blank', title: '빈 창', desc: '새 일감으로 시작' },
            ]}
          />
        </Row>
        <Row title="새 일감 시작" desc="새 일감 대화상자에서 처음 골라 둘 칸 · 셸은 ⌘J" keywords="대화 채팅 터미널 셸 claude codex 기본 템플릿 명령줄 taskminal task new">
          <Choices
            kind="card"
            label="새 일감 시작"
            value={s.newTaskStart}
            onChange={(v) => patch({ newTaskStart: v })}
            options={[
              { value: 'chat-claude', title: 'Claude 대화', desc: '대화로 시작, 셸은 ⌘J' },
              { value: 'chat-codex', title: 'Codex 대화', desc: '대화로 시작, 셸은 ⌘J' },
              { value: 'terminal', title: '터미널', desc: '셸 하나로 시작' },
            ]}
          />
        </Row>
        <Row
          title="새 일감 기본 폴더"
          desc="비워 두면 마지막에 만든 일감의 폴더"
          control={
            <span className="setting-controls">
              <TextField label="새 일감 기본 폴더" value={s.defaultCwd} placeholder="예: ~/code" onCommit={(v) => patch({ defaultCwd: v.trim() })} />
              <button
                type="button"
                className="button"
                onClick={async () => {
                  const picked = await window.taskminal.pickFolder()
                  if (picked) patch({ defaultCwd: picked })
                }}
              >
                폴더 선택…
              </button>
            </span>
          }
        />
        <Row
          title="새 일감 기본 템플릿"
          control={
            <select aria-label="새 일감 기본 템플릿" className="setting-select" value={s.defaultTemplateId ?? ''} onChange={(e) => patch({ defaultTemplateId: e.target.value || null })}>
              <option value="">없음 — ‘새 일감 시작’ 대로</option>
              {s.templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          }
        />
        </Group>
        <Group title="앱">
        <Row
          title="셸까지 모두 끝낼 때 실행 중이면 묻기"
          desc="⌥⌘Q 로 끌 때 · ⌘Q 는 앱만 꺼요"
          keywords="끄기 전 확인 종료 quit"
          control={<Switch label="셸까지 모두 끝낼 때 실행 중이면 묻기" checked={s.confirmQuit} onChange={(v) => patch({ confirmQuit: v })} />}
        />
        <Row title="Dock 아이콘에 확인 필요 수 표시" desc="입력 기다림 · 실패한 일감 수" control={<Switch label="Dock 아이콘에 확인 필요 수 표시" checked={s.dockBadge} onChange={(v) => patch({ dockBadge: v })} />} />
        <Row
          title="이어받기 요약"
          desc="오래 안 본 일감을 열면 그 사이 일을 카드로 · ⌥⌘R 다시 보기"
          keywords="요약 카드 resume 메모 돌아옴 확인 필요 실패 끝난 명령 에이전트"
          control={
            <span className="setting-controls">
              <Switch label="이어받기 요약" checked={s.resumeCard} onChange={(v) => patch({ resumeCard: v })} />
              <select aria-label="이어받기 요약을 띄울 안 본 시간" className="setting-select" disabled={!s.resumeCard} value={s.resumeAfterMin} onChange={(e) => patch({ resumeAfterMin: Number(e.target.value) })}>
                {RESUME_AFTER_CHOICES.map((m) => (
                  <option key={m} value={m}>
                    {m < 60 ? `${m}분` : `${m / 60}시간`} 넘게 안 봤을 때
                  </option>
                ))}
              </select>
            </span>
          }
        />
        </Group>
      </>
    ),
    look: (
      <>
        <Group title="앱">
        <Row
          title="테마"
          keywords="어둡게 밝게 시스템 다크 라이트"
          control={
            <Choices
            label="테마"
            value={s.theme}
            onChange={(v) => patch({ theme: v })}
            options={[
              { value: 'dark', title: '어둡게' },
              { value: 'light', title: '밝게' },
              { value: 'system', title: '시스템 따라가기' },
            ]}
            />
          }
        />
        <Row
          title="강조색"
          control={
            <div role="radiogroup" aria-label="강조색" className="swatches">
              {ACCENTS.map((a) => (
                <button key={a.color} type="button" role="radio" aria-checked={s.accent === a.color} aria-label={a.name} className={`swatch${s.accent === a.color ? ' selected' : ''}`} style={{ background: a.color }} onClick={() => patch({ accent: a.color })} />
              ))}
            </div>
          }
        />
        </Group>
        <Group title="터미널 글자">
        <Row
          title="터미널 글꼴"
          desc="설치되지 않은 글꼴은 Menlo · 한글은 Apple SD Gothic Neo 로 그려요"
          control={
            <select aria-label="터미널 글꼴" className="setting-select" value={s.fontFamily} onChange={(e) => patch({ fontFamily: e.target.value })}>
              {FONT_FAMILIES.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          }
        />
        <Row
          title="글자 크기"
          desc="⌘+ ⌘− ⌘0"
          control={
            <span className="setting-controls">
              <input aria-label="글자 크기" type="range" min={FONT_MIN} max={FONT_MAX} step={1} value={s.fontSize} onChange={(e) => patch({ fontSize: Number(e.target.value) })} />
              <output className="setting-value">{s.fontSize}px</output>
            </span>
          }
        />
        <Row
          title="줄 간격"
          control={
            <span className="setting-controls">
              <input aria-label="줄 간격" type="range" min={LINE_HEIGHT.min} max={LINE_HEIGHT.max} step={0.1} value={s.lineHeight} onChange={(e) => patch({ lineHeight: Number(Number(e.target.value).toFixed(1)) })} />
              <output className="setting-value">{s.lineHeight.toFixed(1)}</output>
            </span>
          }
        >
          <pre className="font-preview" aria-label="미리보기" style={{ fontFamily: fontStack(s.fontFamily), fontSize: s.fontSize, lineHeight: s.lineHeight }}>
            {'❯ git status -s\n M src/shared/model.ts\n?? 임시 메모.txt\n// 한글과 English 가 같은 줄에서 폭이 맞는지: 가나다 abc 123'}
          </pre>
        </Row>
        <Row
          title="포커스 아닌 분할 흐리게"
          desc="100% 면 흐리지 않음"
          keywords="밝기 pane"
          control={
            <span className="setting-controls">
              <input aria-label="포커스 아닌 분할 밝기" type="range" min={DIM.min * 100} max={DIM.max * 100} step={1} value={Math.round(s.dimOpacity * 100)} onChange={(e) => patch({ dimOpacity: Number(e.target.value) / 100 })} />
              <output className="setting-value">{Math.round(s.dimOpacity * 100)}%</output>
            </span>
          }
        />
        </Group>
        <Group title="사이드바">
        <Row
          title="사이드바 밀도"
          keywords="한 줄 두 줄"
          control={
            <Choices
            label="사이드바 밀도"
            value={s.sidebarDensity}
            onChange={(v) => patch({ sidebarDensity: v })}
            options={[
              { value: 'two', title: '두 줄 (폴더 · 상태)' },
              { value: 'one', title: '한 줄 (이름만)' },
            ]}
            />
          }
        />
        </Group>
      </>
    ),
    term: (
      <>
        <Group title="셸">
        <Row
          title="셸"
          desc={
            shellRejected ? (
              <span className="conflict" data-testid="shell-rejected">
                {s.shell} 은 /etc/shells 에 없어 로그인 셸($SHELL)로 열어요
              </span>
            ) : (
              '비우면 로그인 셸($SHELL) · 새 터미널부터'
            )
          }
          keywords="zsh bash fish"
          control={
            <>
              <TextField label="셸" value={s.shell ?? ''} placeholder="예: /bin/zsh" onCommit={(v) => patch({ shell: v.trim() || null })} list="allowed-shells" />
              <datalist id="allowed-shells">{shells?.map((sh) => <option key={sh} value={sh} />)}</datalist>
            </>
          }
        />
        <Row
          title="셸 통합"
          desc="명령 시작 · 끝 · exit 코드를 pane 머리 · 사이드바에 (zsh · 새 터미널부터)"
          keywords="활동 표시 OSC 133 zshrc"
          control={<Switch label="셸 통합" checked={s.shellIntegration} onChange={(v) => patch({ shellIntegration: v })} />}
        />
        </Group>
        <Group title="스크롤">
        <Row
          title="스크롤 보관 줄 수"
          desc={`터미널마다 위로 올려 볼 수 있는 줄 (${SCROLLBACK.min.toLocaleString()}–${SCROLLBACK.max.toLocaleString()})`}
          keywords="scrollback"
          control={
            <TextField
              label="스크롤 보관 줄 수"
              className="setting-input short"
              value={String(s.scrollback)}
              onCommit={(v) => {
                const n = Number(v.replace(/[,\s]/g, ''))
                if (Number.isInteger(n) && n >= SCROLLBACK.min && n <= SCROLLBACK.max) patch({ scrollback: n })
              }}
            />
          }
        />
        <Row
          title="스크롤 되살리기"
          desc="다시 열 때 이전 출력 · 출력을 디스크에 저장해요(끄면 지움)"
          keywords="복원 재시작 scrollback restore 이전 세션 비밀번호"
          control={<Switch label="스크롤 되살리기" checked={s.restoreScrollback} onChange={(v) => patch({ restoreScrollback: v })} />}
        />
        </Group>
        <Group title="커서">
        <Row
          title="커서"
          keywords="막대 블록 밑줄 cursor"
          control={
            <Choices
            label="커서 모양"
            value={s.cursorStyle}
            onChange={(v) => patch({ cursorStyle: v })}
            options={[
              { value: 'bar', title: '막대' },
              { value: 'block', title: '블록' },
              { value: 'underline', title: '밑줄' },
            ]}
            />
          }
        />
        <Row title="커서 깜빡임" control={<Switch label="커서 깜빡임" checked={s.cursorBlink} onChange={(v) => patch({ cursorBlink: v })} />} />
        </Group>
        <Group title="입력 · 복사">
        <Row title="Option 키를 Meta 로" desc="켜면 ⌥ 로 특수문자를 입력할 수 없어요 (emacs · vim 용)" control={<Switch label="Option 키를 Meta 로" checked={s.optionAsMeta} onChange={(v) => patch({ optionAsMeta: v })} />} />
        <Row title="선택하면 바로 복사" desc="끄면 ⌘C 로 복사" control={<Switch label="선택하면 바로 복사" checked={s.copyOnSelect} onChange={(v) => patch({ copyOnSelect: v })} />} />
        </Group>
        <Group title="포트">
        <Row title="숨긴 포트" desc={s.hiddenPorts.length ? '탭 · 사이드바 · ⌘P 에 보이지 않는 포트예요' : '숨긴 포트가 없어요 · 포트 칩 메뉴 › 이 포트 숨기기'} keywords="포트 서버 칩 다시 보이기">
          {s.hiddenPorts.length > 0 && (
            <ul className="manage-list" data-testid="hidden-ports">
              {s.hiddenPorts.map((port) => (
                <li key={port} className="manage-item">
                  <span className="mono">:{port}</span>
                  <button type="button" className="button small" onClick={() => patch({ hiddenPorts: s.hiddenPorts.filter((p) => p !== port) })}>
                    다시 보이기
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Row>
        </Group>
      </>
    ),
    notify: (
      <>
        <Group title="macOS 알림 · 소리" desc="사이드바의 '확인 필요'에는 항상 올라가요">
        <Row title="언제 알릴지" keywords="확인 필요 macOS 알림 소리 입력 기다림 오래 걸린 실패 셸 닫힘">
          <table className="notify-table">
            <thead>
              <tr>
                <th scope="col">언제</th>
                <th scope="col">macOS 알림</th>
                <th scope="col">소리</th>
              </tr>
            </thead>
            <tbody>
              {NOTIFY_KINDS.map((kind) => (
                <tr key={kind} data-testid={`notify-${kind}`}>
                  <th scope="row">
                    <div className="setting-title">{NOTIFY_ROWS[kind].title}</div>
                    <div className="setting-desc">{NOTIFY_ROWS[kind].desc}</div>
                  </th>
                  <td>
                    <Switch label={`${NOTIFY_ROWS[kind].title} — macOS 알림`} checked={s.notify[kind].banner} onChange={(v) => setNotify(kind, 'banner', v)} />
                  </td>
                  <td>
                    <Switch label={`${NOTIFY_ROWS[kind].title} — 소리`} checked={s.notify[kind].sound} onChange={(v) => setNotify(kind, 'sound', v)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Row>
        </Group>
        <Group title="기준">
        <Row
          title="'오래 걸린 명령' 기준"
          control={
            <select aria-label="오래 걸린 명령 기준" className="setting-select" value={s.longAfterSec} onChange={(e) => patch({ longAfterSec: Number(e.target.value) })}>
              {LONG_AFTER_CHOICES.map((sec) => (
                <option key={sec} value={sec}>
                  {sec < 60 ? `${sec}초` : `${sec / 60}분`} 이상
                </option>
              ))}
            </select>
          }
        />
        <Row title="보고 있는 일감은 알리지 않기" desc="앱이 앞에 있고 그 pane 을 보고 있으면" control={<Switch label="보고 있는 일감은 알리지 않기" checked={s.muteViewed} onChange={(v) => patch({ muteViewed: v })} />} />
        <Row
          title="'입력 기다림'으로 보는 신호"
          desc="터미널 벨(BEL) · OSC 9 · OSC 777 — Claude Code 는 preferredNotifChannel 을 terminal_bell 로"
          keywords="claude bel osc 알림 신호 기본 설정"
        />
        </Group>
      </>
    ),
    keys: (
      <>
        <Group title="바꾸기">
        <Row
          title="단축키 바꾸기"
          desc="칸을 누르고 새 키 · Esc 취소 · ⌫ 키 없음(터미널 프로그램에 넘김)"
          keywords="iTerm2 기본값"
          control={
            <button type="button" className="button" onClick={() => patch({ keys: {} })} disabled={Object.keys(s.keys).length === 0}>
              iTerm2 기본값으로
            </button>
          }
        />
        </Group>
        {KEY_GROUPS.map((g) => (
          <Group key={g.title} title={g.title}>
          {g.commands.map((command) => {
            const sc = shortcuts.find((x) => x.command === command)!
            const conflict = conflicts.get(command)
            const listening = capturing === command
            return (
              <Row
                key={command}
                title={sc.label}
                keywords={`${g.title} 단축키 ${sc.accel ? accelLabel(sc.accel) : ''}`}
                desc={conflict && <span className="conflict">{conflict}</span>}
                control={
                  <button
                    type="button"
                    className={`key-field${conflict ? ' bad' : ''}${listening ? ' listening' : ''}`}
                    aria-label={`${sc.label} 단축키 ${sc.accel ? accelLabel(sc.accel) : '없음'}, 바꾸기`}
                    data-testid={`key-${command}`}
                    onClick={() => setCapturing(listening ? null : command)}
                    onKeyDown={onCaptureKey(command)}
                    onBlur={() => listening && setCapturing(null)}
                  >
                    {listening ? '키를 누르세요' : sc.accel ? accelLabel(sc.accel) : '없음'}
                  </button>
                }
              />
            )
          })}
          {g.title === '탭 · 분할' && <Row title="탭으로 가기" desc="⌘1 ~ ⌘8 n번째 탭 · ⌘9 마지막 탭 (바꿀 수 없음)" keywords="단축키 탭 번호" />}
          </Group>
        ))}
      </>
    ),
    tasks: (
      <Group>
        <Row title="상태" desc="지우면 그 상태의 일감은 첫 번째 상태로 옮겨져요" keywords="일감 상태 진행 대기 완료">
          <ul className="manage-list" aria-label="상태 목록">
            {s.statuses.map((st, i) => (
              <li key={st.id} className="manage-item" data-testid="status-item">
                <input type="color" aria-label={`${st.name} 색`} value={st.color} onChange={(e) => dispatch({ type: 'status/update', id: st.id, color: e.target.value })} />
                <TextField label="상태 이름" className="setting-input" value={st.name} onCommit={(v) => dispatch({ type: 'status/update', id: st.id, name: v })} />
                <span className="manage-count">일감 {countBy((id) => id === st.id, 'statusId')}</span>
                <button type="button" className="icon-button" aria-label={`${st.name} 위로`} disabled={i === 0} onClick={() => dispatch({ type: 'status/move', id: st.id, step: -1 })}>
                  ↑
                </button>
                <button type="button" className="icon-button" aria-label={`${st.name} 아래로`} disabled={i === s.statuses.length - 1} onClick={() => dispatch({ type: 'status/move', id: st.id, step: 1 })}>
                  ↓
                </button>
                <button type="button" className="icon-button" aria-label={`${st.name} 지우기`} disabled={s.statuses.length <= 1} onClick={() => dispatch({ type: 'status/remove', id: st.id })}>
                  ×
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="button" onClick={() => dispatch({ type: 'status/add', id: newId(), name: '새 상태', color: ACCENTS[3].color })}>
            + 상태 추가
          </button>
        </Row>
        <Row title="묶음" desc="지우면 그 묶음의 일감은 '묶음 없음'으로 옮겨져요" keywords="일감 묶음 그룹">
          <ul className="manage-list" aria-label="묶음 목록">
            {s.groups.map((g, i) => (
              <li key={g.id} className="manage-item" data-testid="group-item">
                <TextField label="묶음 이름" className="setting-input" value={g.name} onCommit={(v) => dispatch({ type: 'group/rename', id: g.id, name: v })} />
                <span className="manage-count">일감 {countBy((id) => id === g.id, 'groupId')}</span>
                <button type="button" className="icon-button" aria-label={`${g.name} 위로`} disabled={i === 0} onClick={() => dispatch({ type: 'group/move', id: g.id, step: -1 })}>
                  ↑
                </button>
                <button type="button" className="icon-button" aria-label={`${g.name} 아래로`} disabled={i === s.groups.length - 1} onClick={() => dispatch({ type: 'group/move', id: g.id, step: 1 })}>
                  ↓
                </button>
                <button type="button" className="icon-button" aria-label={`${g.name} 지우기`} onClick={() => dispatch({ type: 'group/remove', id: g.id })}>
                  ×
                </button>
              </li>
            ))}
            {s.groups.length === 0 && <li className="manage-empty">묶음이 없습니다</li>}
          </ul>
          <button type="button" className="button" onClick={() => dispatch({ type: 'group/add', id: newId(), name: '새 묶음' })}>
            + 묶음 추가
          </button>
        </Row>
        <Row title="템플릿" desc="새 일감에서 골라 써요. 만든 일감은 템플릿을 지워도 그대로예요" keywords="일감 템플릿">
          <ul className="manage-list" aria-label="템플릿 목록">
            {s.templates.map((t) => (
              <li key={t.id} className="manage-item" data-testid="template-item">
                <TextField label="템플릿 이름" className="setting-input" value={t.name} onCommit={(v) => dispatch({ type: 'template/rename', id: t.id, name: v })} />
                <span className="manage-count">탭 {t.tabs.length}</span>
                <button type="button" className="button" aria-label={`${t.name} JSON 편집`} onClick={() => setEditingTemplate(t.id)}>
                  편집
                </button>
                <button type="button" className="icon-button" aria-label={`${t.name} 지우기`} onClick={() => dispatch({ type: 'template/remove', id: t.id })}>
                  ×
                </button>
              </li>
            ))}
            {s.templates.length === 0 && <li className="manage-empty">템플릿이 없습니다</li>}
          </ul>
          <button type="button" className="button" onClick={() => setEditingTemplate(NEW_TEMPLATE)}>
            + 새 템플릿
          </button>
        </Row>
      </Group>
    ),
  }

  return (
    <div className="settings" role="dialog" aria-modal="true" aria-label="설정" data-testid="settings" onKeyDown={onKeyDown}>
      <nav className="settings-nav" aria-label="설정 칸">
        <button type="button" className="settings-back" onClick={onClose}>
          <Icon name="back" />
          일감으로 돌아가기
        </button>
        <div className="settings-search-wrap">
          <Icon name="search" className="settings-search-icon" />
          <input
            ref={searchRef}
            className="settings-search"
            type="search"
            aria-label="설정 찾기"
            placeholder="설정 찾기"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.stopPropagation() // 찾기 글자만 지운다
                setQuery('')
              }
            }}
          />
        </div>
        <div className="settings-nav-groups">
          {NAV_GROUPS.map((g) => (
            <div key={g.title} className="settings-nav-group">
              <div className="settings-nav-group-title">{g.title}</div>
              {g.ids.map((id) => {
                const x = SECTIONS.find((y) => y.id === id)!
                const current = !query && section === x.id
                return (
                  <button key={x.id} type="button" className={`settings-nav-item${current ? ' current' : ''}`} aria-current={current ? 'page' : undefined} onClick={() => {
                    setQuery('')
                    setSection(x.id)
                  }}>
                    <Icon name={x.icon} />
                    {x.title}
                    {x.id === 'keys' && conflicts.size > 0 && (
                      <span className="badge" data-testid="key-conflict-badge">
                        충돌 {conflicts.size}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      </nav>
      <div className="settings-main">
        <header className="settings-head">
          <span className="settings-crumbs" aria-hidden="true">
            <span>설정</span>
            <span>/</span>
            <span className="settings-crumb-current">{query ? '찾기' : current.title}</span>
          </span>
          <button type="button" className="icon-button settings-close" aria-label="설정 닫기" title="닫기 (esc)" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        <QueryContext.Provider value={query.trim()}>
          <div className="settings-body" data-testid="settings-body">
            <div className="settings-column">
              <div className="settings-page-head">
                <h1>{query ? `‘${query}’ 찾기` : current.title}</h1>
                {!query && <p>{current.desc}</p>}
              </div>
              <RowCountProvider value={reportRow}>
                {SECTIONS.filter((x) => show(x.id)).map((x) => (
                  <Section key={x.id} id={x.id} title={x.title} showTitle={query !== ''}>
                    {body[x.id]}
                  </Section>
                ))}
              </RowCountProvider>
              {noMatch && <p className="settings-none">맞는 설정이 없습니다</p>}
            </div>
          </div>
        </QueryContext.Provider>
      </div>
      {editorOpen && (
        <TemplateEditor
          template={editedTemplate}
          onSave={(value) => {
            if (editedTemplate) dispatch({ type: 'template/replace', id: editedTemplate.id, name: value.name, tabs: value.tabs })
            else dispatch({ type: 'template/add', template: { id: newId(), ...value } })
            setEditingTemplate(null)
          }}
          onCancel={() => setEditingTemplate(null)}
        />
      )}
    </div>
  )
}
