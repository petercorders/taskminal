import { createContext, useContext, useEffect, useRef, useState, type Dispatch, type KeyboardEvent, type ReactNode } from 'react'
import { accelFromEvent, accelLabel, FONT_MAX, FONT_MIN, keyConflicts, type AppCommand, type Shortcut } from '../../shared/keymap'
import { ACCENTS, DIM, FONT_FAMILIES, LINE_HEIGHT, LONG_AFTER_CHOICES, NOTIFY_KINDS, SCROLLBACK, settingsMatch } from '../../shared/settings'
import type { AppState, NotifyKind } from '../../shared/types'
import type { Action, SettingsPatch } from '../store'
import { fontStack } from '../term-settings'
import { TemplateEditor } from './TemplateEditor'
import { HostSection } from './HostSection'
import { BackupSection } from './BackupSection'
import { PrivacySection } from './PrivacySection'
import type { Restored } from '../../shared/backup'
import type { BackupMark } from '../../shared/ipc'

type SectionId = 'general' | 'look' | 'term' | 'host' | 'notify' | 'privacy' | 'backup' | 'keys' | 'tasks'
/** ⌘P 로 바로 여는 칸 */
export type SettingsJump = 'host' | 'backup' | 'privacy'
const SECTIONS: Array<{ id: SectionId; title: string }> = [
  { id: 'general', title: '일반' },
  { id: 'look', title: '모양' },
  { id: 'term', title: '터미널' },
  { id: 'host', title: '셸 지킴이' },
  { id: 'notify', title: '알림 · 활동' },
  { id: 'privacy', title: '개인정보' },
  { id: 'backup', title: '백업 · 되돌리기' },
  { id: 'keys', title: '단축키' },
  { id: 'tasks', title: '일감 관리' },
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
  onClose(): void
}

// 찾는 중이면 모든 칸에서 맞는 줄만 보인다 — 줄마다 찾을 글자를 갖는다
const QueryContext = createContext('')

/** 설정 한 줄. 찾기 글자가 title · desc · keywords 에 모두 없으면 그리지 않는다. */
function Row({ title, desc, keywords = '', control, children }: { title: string; desc?: ReactNode; keywords?: string; control?: ReactNode; children?: ReactNode }) {
  const query = useContext(QueryContext)
  if (query && !settingsMatch(`${title} ${typeof desc === 'string' ? desc : ''} ${keywords}`, query)) return null
  return (
    <div className="setting-row" data-testid="setting-row" data-title={title}>
      <div className="setting-head">
        <div className="setting-text">
          <div className="setting-title">{title}</div>
          {desc && <div className="setting-desc">{desc}</div>}
        </div>
        {control}
      </div>
      {children}
    </div>
  )
}

function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange(v: boolean): void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`switch${checked ? ' on' : ''}`} onClick={() => onChange(!checked)}>
      <span className="switch-knob" aria-hidden />
    </button>
  )
}

/** 라디오 묶음 (카드 · 알약 모양) */
function Choices<T extends string | number>({ label, value, options, onChange, kind = 'pill' }: { label: string; value: T; options: Array<{ value: T; title: ReactNode; desc?: string }>; onChange(v: T): void; kind?: 'pill' | 'card' }) {
  return (
    <div role="radiogroup" aria-label={label} className={`choices ${kind}`}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" role="radio" aria-checked={value === o.value} className={`choice${value === o.value ? ' selected' : ''}`} onClick={() => onChange(o.value)}>
          <span className="choice-title">{o.title}</span>
          {o.desc && <span className="choice-desc">{o.desc}</span>}
        </button>
      ))}
    </div>
  )
}

/** 글자 칸: 칠 때마다가 아니라 ↩ · 포커스를 잃을 때 한 번 반영(빈 이름 · 반쯤 친 경로가 저장되지 않게). Esc 는 되돌림 */
function TextField({ label, value, onCommit, placeholder, className, list }: { label: string; value: string; onCommit(v: string): void; placeholder?: string; className?: string; list?: string }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <input
      className={className ?? 'setting-input'}
      aria-label={label}
      value={draft}
      placeholder={placeholder}
      list={list}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft === value) return
        onCommit(draft)
        setDraft(value) // 받아들이지 않은 값(틀린 수 · 빈 이름)은 칸을 원래대로 — 받아들였으면 새 value 가 다시 채운다
      }}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          e.stopPropagation() // 설정 창을 닫지 않고 되돌리기만
          setDraft(value)
        }
      }}
    />
  )
}

// 단축키 칸에서 바꿀 수 있는 명령 (탭 번호 ⌘1~9 는 고정)
const KEY_GROUPS: Array<{ title: string; commands: AppCommand[] }> = [
  { title: '일감', commands: ['new-task', 'palette', 'next-task', 'prev-task', 'next-attention', 'settings'] },
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

export function SettingsView({ state, shortcuts, dispatch, newId, initialSection, busy = 0, onClose, onRestore }: Props) {
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
  const sectionTitle = SECTIONS.find((x) => x.id === section)!.title

  const body: Record<SectionId, ReactNode> = {
    host: <HostSection state={state} busy={busy} Row={Row} />,
    privacy: <PrivacySection s={s} patch={patch} Row={Row} Switch={Switch} />,
    backup: <BackupSection state={state} Row={Row} newId={newId} onRestore={onRestore} />,
    general: (
      <>
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
              <option value="">없음 — 셸 하나</option>
              {s.templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          }
        />
        <Row
          title="셸까지 모두 끝낼 때 실행 중이면 묻기"
          desc="⌥⌘Q · 예: flutter run · 서버 · Claude 가 돌고 있을 때. ⌘Q 는 앱만 끄고 셸은 계속 돌아요"
          keywords="끄기 전 확인 종료 quit"
          control={<Switch label="셸까지 모두 끝낼 때 실행 중이면 묻기" checked={s.confirmQuit} onChange={(v) => patch({ confirmQuit: v })} />}
        />
        <Row title="Dock 아이콘에 확인 필요 수 표시" desc="입력 기다림 · 실패한 일감 수" control={<Switch label="Dock 아이콘에 확인 필요 수 표시" checked={s.dockBadge} onChange={(v) => patch({ dockBadge: v })} />} />
      </>
    ),
    look: (
      <>
        <Row title="테마" keywords="어둡게 밝게 시스템 다크 라이트">
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
        </Row>
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
        <Row title="사이드바 밀도" keywords="한 줄 두 줄">
          <Choices
            label="사이드바 밀도"
            value={s.sidebarDensity}
            onChange={(v) => patch({ sidebarDensity: v })}
            options={[
              { value: 'two', title: '두 줄 (폴더 · 상태)' },
              { value: 'one', title: '한 줄 (이름만)' },
            ]}
          />
        </Row>
      </>
    ),
    term: (
      <>
        <Row
          title="셸"
          desc={
            shellRejected ? (
              <span className="conflict" data-testid="shell-rejected">
                {s.shell} 은 /etc/shells 에 없어 로그인 셸($SHELL)로 열어요
              </span>
            ) : (
              '비우면 로그인 셸($SHELL). /etc/shells 에 있는 셸만 · 새 터미널부터'
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
          desc="다시 열 때 이전 출력을 보여 줘요. 터미널 출력을 디스크에 저장해요(비밀번호 등이 남을 수 있어요) — 끄면 저장한 것을 모두 지워요"
          keywords="복원 재시작 scrollback restore 이전 세션"
          control={<Switch label="스크롤 되살리기" checked={s.restoreScrollback} onChange={(v) => patch({ restoreScrollback: v })} />}
        />
        <Row title="커서" keywords="막대 블록 밑줄 cursor">
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
        </Row>
        <Row title="커서 깜빡임" control={<Switch label="커서 깜빡임" checked={s.cursorBlink} onChange={(v) => patch({ cursorBlink: v })} />} />
        <Row
          title="셸 통합"
          desc="명령 시작 · 끝과 exit 코드를 알아 pane 머리 · 사이드바에 보여 줘요(zsh). ~/.zshrc 는 바꾸지 않아요. 새 터미널부터"
          keywords="활동 표시 OSC 133"
          control={<Switch label="셸 통합" checked={s.shellIntegration} onChange={(v) => patch({ shellIntegration: v })} />}
        />
        <Row title="Option 키를 Meta 로" desc="켜면 ⌥ 로 특수문자를 입력할 수 없어요 (emacs · vim 용)" control={<Switch label="Option 키를 Meta 로" checked={s.optionAsMeta} onChange={(v) => patch({ optionAsMeta: v })} />} />
        <Row title="선택하면 바로 복사" desc="끄면 ⌘C 로 복사" control={<Switch label="선택하면 바로 복사" checked={s.copyOnSelect} onChange={(v) => patch({ copyOnSelect: v })} />} />
      </>
    ),
    notify: (
      <>
        <Row title="언제 알릴지" desc="사이드바의 '확인 필요'에는 항상 올라가요" keywords="macOS 알림 소리 입력 기다림 오래 걸린 실패 셸 닫힘">
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
          desc="터미널 벨(BEL) · 알림 신호(OSC 9 · OSC 777). Claude Code 는 기본 설정에서 이 신호를 보내지 않아요 — Claude Code 설정의 preferredNotifChannel 을 terminal_bell 로 바꾸면 보내요."
          keywords="claude bel osc"
        />
      </>
    ),
    keys: (
      <>
        <Row
          title="단축키 바꾸기"
          desc="칸을 누르고 새 키(⌘ 와 함께)를 누르면 바뀌어요. Esc 는 취소, ⌫ 는 키 없음(터미널 프로그램에 넘김)"
          keywords="iTerm2 기본값"
          control={
            <button type="button" className="button" onClick={() => patch({ keys: {} })} disabled={Object.keys(s.keys).length === 0}>
              iTerm2 기본값으로
            </button>
          }
        />
        {KEY_GROUPS.map((g) =>
          g.commands.map((command) => {
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
          }),
        )}
        <Row title="탭으로 가기" desc="⌘1 ~ ⌘8 n번째 탭 · ⌘9 마지막 탭 (바꿀 수 없음)" keywords="단축키 탭 번호" />
      </>
    ),
    tasks: (
      <>
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
      </>
    ),
  }

  return (
    <div className="settings" role="dialog" aria-modal="true" aria-label="설정" data-testid="settings" onKeyDown={onKeyDown}>
      <nav className="settings-nav" aria-label="설정 칸">
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
        {SECTIONS.map((x) => (
          <button key={x.id} type="button" className={`settings-nav-item${!query && section === x.id ? ' current' : ''}`} aria-current={!query && section === x.id ? 'page' : undefined} onClick={() => {
            setQuery('')
            setSection(x.id)
          }}>
            {x.title}
            {x.id === 'keys' && conflicts.size > 0 && (
              <span className="badge" data-testid="key-conflict-badge">
                충돌 {conflicts.size}
              </span>
            )}
          </button>
        ))}
      </nav>
      <div className="settings-main">
        <header className="settings-head">
          <h1>{query ? `설정 — ‘${query}’ 찾기` : `설정 — ${sectionTitle}`}</h1>
          <span className="settings-saved">바꾸면 바로 저장돼요</span>
          <button type="button" className="button" onClick={onClose}>
            일감으로 돌아가기 <kbd>esc</kbd>
          </button>
        </header>
        <QueryContext.Provider value={query.trim()}>
          <div className="settings-body" data-testid="settings-body">
            {SECTIONS.filter((x) => show(x.id)).map((x) => (
              <section key={x.id} className="settings-section" aria-label={x.title} data-section={x.id}>
                {query && <h2 className="settings-section-title">{x.title}</h2>}
                {body[x.id]}
              </section>
            ))}
            <p className="settings-none">맞는 설정이 없습니다</p>
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
