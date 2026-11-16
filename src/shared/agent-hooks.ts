// 51단계: 터미널에서 직접 띄운 Claude · Codex 의 상태 — 훅이 pane 기록 파일에 덧붙인 줄을 읽어 상태로 바꾼다.
// 훅 프로세스는 제어 터미널이 없어(스파이크: /dev/tty 쓰기 실패) OSC 대신 파일로 보낸다.
// 줄: `v1⇥<초>⇥<에이전트>⇥<사건>⇥<종류>` — 프롬프트 · 도구 입력은 쓰지 않는다.

export type AgentKind = 'claude' | 'codex'
/** working 작업 중 · permission 허락 기다림 · input 입력 기다림 · done 턴 끝 · failed 턴 실패 · ended 세션 끝 */
export type AgentPhase = 'working' | 'permission' | 'input' | 'done' | 'failed' | 'ended'

export interface AgentSignal {
  agent: AgentKind
  phase: AgentPhase
  /** ms */
  at: number
}

/** claude `--settings` 로 거는 훅 사건 — 모두 상태로 바뀌는 것만 건다 */
export const CLAUDE_HOOK_EVENTS = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'Stop',
  'StopFailure',
  'SessionEnd',
] as const

/** 셸 통합의 claude · codex 함수가 명령이 돌아온 뒤 덧붙이는 사건(죽거나 강제 종료돼 SessionEnd 가 없어도 닫히게) */
export const EXIT_EVENT = 'TaskminalExit'

const CLAUDE_PHASE: Record<string, AgentPhase> = {
  UserPromptSubmit: 'working',
  PreToolUse: 'working',
  PostToolUse: 'working',
  PostToolUseFailure: 'working',
  PermissionRequest: 'permission',
  Stop: 'done',
  StopFailure: 'failed',
  SessionEnd: 'ended',
  [EXIT_EVENT]: 'ended',
}
const CLAUDE_NOTIFICATION: Record<string, AgentPhase> = {
  permission_prompt: 'permission',
  idle_prompt: 'input',
  elicitation_dialog: 'input',
}

export function agentPhase(agent: AgentKind, event: string, type: string): AgentPhase | null {
  if (event === EXIT_EVENT) return 'ended'
  if (agent === 'codex') return event === 'agent-turn-complete' ? 'done' : null
  if (event === 'Notification') return CLAUDE_NOTIFICATION[type] ?? null
  return Object.hasOwn(CLAUDE_PHASE, event) ? CLAUDE_PHASE[event]! : null
}

/** 한 줄 → 상태. 모르는 판 · 에이전트 · 사건 · 깨진 줄은 null. */
export function parseAgentLine(line: string): AgentSignal | null {
  const parts = line.split('\t')
  if (parts.length !== 5) return null
  const [ver, sec, agent, event, type] = parts as [string, string, string, string, string]
  if (ver !== 'v1' || !/^\d{1,12}$/.test(sec)) return null
  if (agent !== 'claude' && agent !== 'codex') return null
  const phase = agentPhase(agent, event, type)
  return phase ? { agent, phase, at: Number(sec) * 1000 } : null
}

/** 줄바꿈까지 온 줄만 — 반쪽 줄은 rest 로 남겨 다음 읽기에 잇는다. */
export function splitLines(text: string): { lines: string[]; rest: string } {
  const end = text.lastIndexOf('\n')
  if (end < 0) return { lines: [], rest: text }
  return { lines: text.slice(0, end).split('\n'), rest: text.slice(end + 1) }
}

/** sh 작은따옴표 — 공백 · 따옴표가 있는 경로(`Application Support`)도 한 낱말로 */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** claude 훅 스크립트. stdin JSON 은 다 읽고(쓰는 쪽이 막히지 않게) 맨 앞 사건 이름 · 알림 종류만 뽑는다.
 * 글 안의 `\"hook_event_name\"` 은 따옴표 앞 \ 때문에 맞지 않고, 진짜 키는 도구 입력보다 앞에 온다(awk match 는 가장 왼쪽). */
export function claudeHookScript(): string {
  return `#!/bin/sh
# Taskminal 에이전트 상태 훅 — 사건 이름 · 알림 종류만 pane 기록 파일에 덧붙인다. 출력 없이 늘 0 (허락 결정에 끼지 않는다).
in=$(cat)
f=\${TASKMINAL_AGENT_EVENTS-}
[ -n "$f" ] || exit 0
pick() {
  printf '%s\\n' "$in" | awk -v k="$1" 'match($0, "\\"" k "\\" *: *\\"[A-Za-z_]+\\"") { s = substr($0, RSTART, RLENGTH); sub(/^"[a-z_]+" *: *"/, "", s); sub(/"$/, "", s); print s; exit }'
}
ev=$(pick hook_event_name)
[ -n "$ev" ] || exit 0
ty=$(pick notification_type)
{ printf 'v1\\t%s\\tclaude\\t%s\\t%s\\n' "$(date +%s)" "$ev" "$ty" >> "$f"; } 2>/dev/null
exit 0
`
}

/** codex `notify` 프로그램 — 턴 끝 JSON 이 첫 인자로 온다. 종류만 덧붙인다. */
export function codexNotifyScript(): string {
  return `#!/bin/sh
# Taskminal 에이전트 상태 — codex 턴 끝 알림의 종류만 pane 기록 파일에 덧붙인다. 출력 없이 늘 0.
f=\${TASKMINAL_AGENT_EVENTS-}
[ -n "$f" ] || exit 0
ty=$(printf '%s\\n' "\${1-}" | awk 'match($0, /^\\{ *"type" *: *"[a-z-]+"/) { s = substr($0, RSTART, RLENGTH); sub(/^\\{ *"type" *: *"/, "", s); sub(/"$/, "", s); print s; exit }')
[ -n "$ty" ] || exit 0
{ printf 'v1\\t%s\\tcodex\\t%s\\t\\n' "$(date +%s)" "$ty" >> "$f"; } 2>/dev/null
exit 0
`
}

/** `claude --settings <파일>` 내용. statusLine 은 52단계(사용량)에서 건다. */
export function claudeHookSettings(hookPath: string, statusLinePath?: string): string {
  const command = { type: 'command', command: shQuote(hookPath), timeout: 10 }
  const settings: Record<string, unknown> = {
    hooks: Object.fromEntries(CLAUDE_HOOK_EVENTS.map((e) => [e, [{ hooks: [command] }]])),
  }
  if (statusLinePath) settings['statusLine'] = { type: 'command', command: shQuote(statusLinePath), padding: 0 }
  return `${JSON.stringify(settings, null, 2)}\n`
}

/** `codex -c <값>` — TOML 기본 문자열 이스케이프는 JSON 과 같다(\" · \\). */
export function codexNotifyArg(scriptPath: string): string {
  return `notify=[${JSON.stringify(scriptPath)}]`
}

/** 사용자 codex config.toml 맨 위(첫 [표] 앞)에 notify 가 있나 — 있으면 덮지 않게 감싸지 않는다. */
export function codexHasNotify(toml: string): boolean {
  for (const raw of toml.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('[')) return false
    if (/^notify\s*=/.test(line)) return true
  }
  return false
}

const AGENT_NAME: Record<AgentKind, string> = { claude: 'Claude', codex: 'Codex' }
const PHASE_LABEL: Record<Exclude<AgentPhase, 'ended'>, string> = {
  working: '작업 중',
  permission: '허락 기다림',
  input: '입력 기다림',
  done: '끝남',
  failed: '실패',
}

/** 화면 글자: `Claude · 허락 기다림` */
export function agentLabel(a: { agent: AgentKind; phase: Exclude<AgentPhase, 'ended'> }): string {
  return `${AGENT_NAME[a.agent]} · ${PHASE_LABEL[a.phase]}`
}
