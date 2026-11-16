import { FIND_TOOLS, WORK_TOOLS, commandLabel, toolBlocked, type FindKind } from '../shared/work-tools'

/** 56단계: 좁은 창 · 사이드바의 '작업 도구 선택' 칸 — 위 도구 줄과 같은 두 묶음 · 이름 · 꺼짐 규칙. 값은 도구 kind 또는 `find-<kind>` */
export function WorkToolOptions({ task }: { task: { host?: string } | null }) {
  return (
    <>
      <option value="" disabled>
        작업 도구
      </option>
      <optgroup label="이 일감">
        {WORK_TOOLS.filter((t) => t.group === 'task').map((t) => (
          <option key={t.kind} value={t.kind} disabled={toolBlocked(t, task) !== null}>
            {commandLabel(t.command)}
          </option>
        ))}
      </optgroup>
      <optgroup label="앱">
        {FIND_TOOLS.map((f) => (
          <option key={f.kind} value={`find-${f.kind}`}>
            {commandLabel(f.command)}
          </option>
        ))}
        {WORK_TOOLS.filter((t) => t.group === 'app').map((t) => (
          <option key={t.kind} value={t.kind}>
            {commandLabel(t.command)}
          </option>
        ))}
      </optgroup>
    </>
  )
}

/** 56단계: 찾기 네 화면 머리의 '찾을 곳' 줄 — 다른 곳을 누르면 지금 화면을 닫고 그 화면을 쓰던 검색어로 연다 */
export function FindSwitch({ current, query, onSwitch }: { current: FindKind; query: string; onSwitch?(kind: FindKind, query: string): void }) {
  if (!onSwitch) return null
  return (
    <nav className="find-switch" aria-label="찾을 곳">
      {FIND_TOOLS.map((f) => (
        <button
          key={f.kind}
          type="button"
          className={`seg${f.kind === current ? ' on' : ''}`}
          aria-current={f.kind === current ? 'page' : undefined}
          onClick={() => f.kind !== current && onSwitch(f.kind, query)}
        >
          {f.short}
        </button>
      ))}
    </nav>
  )
}
