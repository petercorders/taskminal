// 위험 명령 표 — 배포 · 지우기 · 올리기처럼 다시 실행하면 되돌리기 어려운 명령.
// 19단계 명령 기록의 '새 pane 에서 실행' 을 '넣기만' 으로 바꾸고, 20단계 빠른 명령의 '실행 전 물어봐요' 권유가 같은 표를 쓴다(한 곳에서 고친다).

const DANGER = [/deploy/i, /(^|[^\w-])rm(\s|$)/, /(^|[^\w-])push(\s|$)/i, /(^|[^\w-])drop(\s|$)/i, /docker[ -]compose\s+up/i]

export function isDangerous(cmd: string): boolean {
  return DANGER.some((re) => re.test(cmd))
}
