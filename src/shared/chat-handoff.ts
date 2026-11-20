import { chatStatus, lastTurnText, type ChatEvent, type ChatState } from './chat'
import { redact } from './redact'

const STATUS: Record<ChatState, string> = {
  new: '이전 실행 기록 미확인',
  run: '이전 대화 실행 중',
  wait: '이전 대화가 사용자 응답을 기다리는 중',
  done: '이전 대화 턴 완료',
  fail: '이전 대화 실패',
  stopped: '이전 대화 중단',
}

// 한 줄로 독립 실행된 대표 검사만 이전 도구 결과에 연결한다.
const CHECK_COMMAND = /^(?:npm test|npm run (?:test|typecheck|check)|npx vitest run|pnpm test|yarn test|git diff --check|go test|cargo test|pytest|flutter test)(?:[ \t]+[\w./-]+)*$/

function observedChecks(events: readonly ChatEvent[]): string[] {
  const checks = new Map<string, { command: string; ok?: boolean }>()
  for (const event of events.slice(-250)) {
    if (event.t === 'tool' && event.name === 'Bash' && CHECK_COMMAND.test(event.summary.trim())) {
      checks.set(event.id, { command: event.summary.trim() })
    } else if (event.t === 'tool_end') {
      const check = checks.get(event.id)
      if (check) check.ok = event.ok
    }
  }
  return [...checks.values()].slice(-4).map(({ command, ok }) =>
    `- ${redact(command)} · ${ok === undefined ? '결과 미확인' : ok ? '도구 성공' : '도구 오류'}`,
  )
}

export const HANDOFF_MAX_CHARS = 10_000

export function claudeHandoff(events: readonly ChatEvent[], files: readonly string[] | null): string {
  const goal = events.findLast((event) => event.t === 'user')?.text.trim()
  const previousAnswer = lastTurnText(events).trim()
  const checks = observedChecks(events)
  const previousChecks = checks.length > 0 ? ['이전 대화에 기록된 검사 명령과 도구 결과', ...checks] : []
  const paths = files === null ? null : [...new Set(files)]
  const changes = paths === null ? '변경 파일 미확인' : paths.length === 0 ? '현재 작업 트리에 변경 없음' : [
    ...paths.slice(0, 12).map((path) => `- ${redact(path).slice(0, 240)}`),
    ...(paths.length > 12 ? [`- 외 ${paths.length - 12}개`] : []),
  ].join('\n')
  return [
    '## 작업 목표',
    goal ? redact(goal).slice(0, 2_000) : '목표를 입력해 주세요.',
    '',
    '## 현재 변경 파일',
    changes,
    '',
    '## 검증',
    '현재 커밋의 검사 결과 미확인. 이어서 필요한 검사를 지정해 주세요.',
    ...previousChecks,
    '',
    '## 현재 상태와 막힌 지점',
    STATUS[chatStatus(events).state],
    ...(previousAnswer ? ['', 'Claude의 최근 답변 발췌 (검증되지 않은 대화 기록)', redact(previousAnswer).slice(0, 2_000)] : []),
  ].join('\n')
}
